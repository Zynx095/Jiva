import { HospitalState, GeoPoint, CareRequirement, HospitalCandidate, CapabilityType } from '@jiva/domain-models';
import { hospitalsStore } from './stateStore';
import { mappingProvider } from './mapping';

export async function evaluateHospitals(
  requirement: CareRequirement,
  ambulanceLocation: GeoPoint
): Promise<HospitalCandidate[]> {
  const candidates: HospitalCandidate[] = [];

  const promises = Array.from(hospitalsStore.values()).map(async (hospital) => {
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
    const acceptance = hospital.operationalState.acceptance;

    let reason = '';

    const op = hospital.operationalState;
    const expiresAt = op.expiresAt;
    const acceptanceExpired = !!expiresAt && Date.now() > new Date(expiresAt).getTime();
    // An acceptance only counts for the emergency it was given for.
    const acceptanceForThisCase = !op.acceptanceCaseId || op.acceptanceCaseId === requirement.caseId;
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
        const route = await mappingProvider.calculateRoute({
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
      acceptanceStatus: (hospital.operationalState.acceptance === 'UNKNOWN') ? 'PENDING' : hospital.operationalState.acceptance,
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
