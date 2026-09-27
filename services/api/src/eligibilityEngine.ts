import { HospitalState, GeoPoint, CareRequirement, HospitalCandidate, CapabilityType } from '@jiva/domain-models';
import type { CaseAcceptanceStatus } from './feasibility/acceptanceLedger';
import { hospitalsStore } from './stateStore';
import { mappingProvider } from './mapping';
import type { MappingProvider } from '@jiva/mapping';

/**
 * Optional dependencies so the SAME legacy evaluation can run outside the local in-memory
 * stores (AWS lambdas read hospitals from DynamoDB). Defaults preserve local behaviour exactly.
 */
export interface EvaluationDeps {
  hospitals?: Iterable<HospitalState>;
  mapping?: Pick<MappingProvider, 'calculateRoute'>;
  nowMs?: number;
  /**
   * CASE-SCOPED acceptance status (fixes the legacy one-slot bug at the exact decision boundary:
   * this is where "is this hospital accepted for THIS case" is decided). When supplied, this
   * REPLACES `hospital.operationalState.acceptance/acceptanceCaseId/expiresAt` as the source of
   * acceptance truth for the requirement's case: the shared slot only ever holds the LAST writer
   * across every case, so without this override case B's acceptance at a hospital silently strips
   * case A's own eligibility there. Backed by the per-(case, hospital) acceptance ledger /
   * materialized index (see acceptanceLedger.ts / materializedAcceptance.ts), which already keeps
   * cases independent. Clinical capability and hospital-wide ED-unavailable checks are untouched
   * (those are legitimately hospital-wide facts, not per-case).
   */
  acceptanceOverride?: (hospitalId: string) => CaseAcceptanceStatus | Promise<CaseAcceptanceStatus>;
}

export async function evaluateHospitals(
  requirement: CareRequirement,
  ambulanceLocation: GeoPoint,
  deps: EvaluationDeps = {}
): Promise<HospitalCandidate[]> {
  const candidates: HospitalCandidate[] = [];
  const mapping = deps.mapping || mappingProvider;
  const nowMs = deps.nowMs ?? Date.now();

  const promises = Array.from(deps.hospitals || hospitalsStore.values()).map(async (hospital) => {
    const missingCapabilities: CapabilityType[] = [];
    let capabilityMatch = 0;

    for (const req of requirement.requiredCapabilities) {
      // We look at static capabilities (has the facility ever possessed it)
      // Note: lowercasing the enum string to match capabilities object keys, e.g. 'ICU' -> 'icu'
      const key = (req.toLowerCase().replace(/_([a-z])/g, g => g[1].toUpperCase())) as keyof typeof hospital.capabilities;
      if (hospital.capabilities[key]) {
         capabilityMatch += 1;
      } else {
         missingCapabilities.push(req);
      }
    }

    const requiredCapabilitiesSatisfied = requirement.requiredCapabilities.filter(c => !missingCapabilities.includes(c));
    const isCapable = missingCapabilities.length === 0;

    let operationalEligibility: 'ELIGIBLE' | 'PENDING_ACCEPTANCE' | 'INELIGIBLE' = 'INELIGIBLE';

    let reason = '';
    const op = hospital.operationalState;

    // An acceptance only counts for the emergency it was given for (legacy shared-slot semantics).
    const legacySlot = (): [string, boolean, boolean] => [
      op.acceptance,
      !!op.expiresAt && nowMs > new Date(op.expiresAt).getTime(),
      !op.acceptanceCaseId || op.acceptanceCaseId === requirement.caseId,
    ];
    let acceptance: string, acceptanceExpired: boolean, acceptanceForThisCase: boolean;
    if (deps.acceptanceOverride) {
      // Case-scoped read (the actual fix). If it fails, this NEVER blocks the legacy decision: it
      // degrades to the pre-existing shared-slot check (same behaviour as if no override existed).
      try {
        const cs = await deps.acceptanceOverride(hospital.hospitalId);
        [acceptance, acceptanceExpired, acceptanceForThisCase] = [cs.status, cs.expired, true];
      } catch (err) {
        console.warn(`[Eligibility] Case-scoped acceptance read failed for ${hospital.hospitalId} (falling back to the shared slot): ${err instanceof Error ? err.message : String(err)}`);
        [acceptance, acceptanceExpired, acceptanceForThisCase] = legacySlot();
      }
    } else {
      [acceptance, acceptanceExpired, acceptanceForThisCase] = legacySlot();
    }
    const expiresAt = op.expiresAt;
    const operationallyUnavailable = op.emergency === 'UNAVAILABLE';

    if (!isCapable) {
      operationalEligibility = 'INELIGIBLE';
      reason = `Missing required capabilities: ${missingCapabilities.join(', ')}`;
    } else if (operationallyUnavailable) {
      operationalEligibility = 'INELIGIBLE';
      reason = `Hospital reported emergency department UNAVAILABLE.`;
    } else if ((acceptance === 'ACCEPTED' || acceptance === 'LIMITED') && !acceptanceForThisCase) {
      operationalEligibility = 'PENDING_ACCEPTANCE';
      reason = `Current response relates to a different case; acceptance for this case required.`;
    } else if (acceptance === 'ACCEPTED' || acceptance === 'LIMITED') {
      if (acceptanceExpired) {
        operationalEligibility = 'PENDING_ACCEPTANCE';
        reason = `Acceptance expired at ${expiresAt}. Requires new request.`;
      } else {
        operationalEligibility = 'ELIGIBLE';
        reason = acceptance === 'ACCEPTED' ? `Capable and ACCEPTED.` : `Capable but ACCEPTED with LIMITATIONS.`;
      }
    } else if (acceptance === 'REJECTED' && acceptanceForThisCase) {
      operationalEligibility = 'INELIGIBLE';
      reason = `Hospital explicitly REJECTED the request.`;
    } else if (acceptance === 'UNAVAILABLE') {
      operationalEligibility = 'INELIGIBLE';
      reason = `Hospital is currently operationally UNAVAILABLE.`;
    } else {
      operationalEligibility = 'PENDING_ACCEPTANCE';
      reason = `All required capabilities present; current acceptance required.`;
    }

    let distanceKm = 0;
    let etaMinutes = 0;
    
    if (hospital.location && ambulanceLocation) {
      try {
        const route = await mapping.calculateRoute({
           origin: ambulanceLocation,
           destination: { latitude: hospital.location.latitude, longitude: hospital.location.longitude },
           travelMode: 'DRIVING'
        });
        distanceKm = Number((route.distanceMeters / 1000).toFixed(1));
        etaMinutes = Math.ceil(route.durationSeconds / 60);
      } catch (err) {
        console.error(`Route calc failed for ${hospital.hospitalId}`, err);
      }
    }

    candidates.push({
      hospitalId: hospital.hospitalId,
      hospitalName: hospital.displayName,
      capabilityMatch: isCapable ? 1.0 : (requiredCapabilitiesSatisfied.length / Math.max(requirement.requiredCapabilities.length, 1)),
      requiredCapabilitiesSatisfied,
      missingCapabilities,
      operationalEligibility,
      acceptanceStatus: (acceptance === 'UNKNOWN') ? 'PENDING' : acceptance as HospitalCandidate['acceptanceStatus'],
      distanceKm,
      etaMinutes,
      reason
    });
  });

  await Promise.all(promises);

  // Sort: Eligible first, then Pending, then Ineligible. Within groups, by ETA
  return candidates.sort((a, b) => {
    const scoreA = a.operationalEligibility === 'ELIGIBLE' ? 2 : a.operationalEligibility === 'PENDING_ACCEPTANCE' ? 1 : 0;
    const scoreB = b.operationalEligibility === 'ELIGIBLE' ? 2 : b.operationalEligibility === 'PENDING_ACCEPTANCE' ? 1 : 0;
    
    if (scoreA !== scoreB) return scoreB - scoreA;
    const accA = a.acceptanceStatus === 'ACCEPTED' ? 1 : 0;
    const accB = b.acceptanceStatus === 'ACCEPTED' ? 1 : 0;
    if (scoreA === 2 && accA !== accB) return accB - accA;
    if (a.etaMinutes !== b.etaMinutes) return a.etaMinutes - b.etaMinutes;
    return a.distanceKm - b.distanceKm;
  });
}
