import type { DataStatus, HospitalState } from '@jiva/domain-models';
import { acceptanceLedger } from './feasibility/acceptanceLedger';
import { hospitalsStore, patientsStore, stateStore } from './stateStore';

/**
 * Referral overview for one case: for every connected (network) hospital, four DIFFERENT kinds of
 * information, kept apart so none is mistaken for another:
 *
 *   listed      — what the hospital's record lists (directory-level suitability; not availability)
 *   assessment  — JIVA's estimate from the latest candidate evaluation (capability match, ETA)
 *   referral +  — the case-specific request and the hospital's EXPLICIT answer to it, with times and
 *   answer        trusted provenance (the only thing that can make a hospital a destination)
 *   capacity    — the last reported service status and who reported it; "verified" only when the
 *                 report came from a real hospital principal or an authorised feed
 *
 * Read-only: derived from the hospital store, the event ledger and the per-(case, hospital) acceptance
 * ledger that the legacy eligibility already uses. It changes nothing.
 */
export interface ReferralRow {
  hospitalId: string;
  name: string;
  dataStatus: string;
  listed: { listedRequired: string[]; missingRequired: string[] };
  assessment?: { eligibility: string; reason: string; etaMinutes?: number; distanceKm?: number; evaluatedAt: string };
  referral: { state: 'NOT_REQUESTED' | 'OUTSTANDING' | 'EXPIRED' | 'CANCELLED'; requestId?: string; requestedAt?: string; expiresAt?: string; cancelledAt?: string };
  answer?: { responseId: string; requestId: string; status: string; respondedAt: string; validUntil: string; current: boolean; limitations: string[]; provenance: DataStatus };
  capacity: { emergency: string; icu: string; trauma: string; reportedAt?: string; provenance: DataStatus | 'SEED'; verified: boolean };
}

export interface ReferralOverview {
  caseId: string;
  requiredCapabilities: string[];
  generatedAt: string;
  rows: ReferralRow[];
}

const capabilityKey = (code: string) => code.toLowerCase().replace(/_([a-z])/g, g => g[1].toUpperCase());

function capacityOf(h: HospitalState): ReferralRow['capacity'] {
  const op = h.operationalState;
  const report = [...h.provenance].reverse().find(p => p.sourceName === 'Capacity Update');
  const provenance: ReferralRow['capacity']['provenance'] = report ? (report.trustedStatus ?? 'UNVERIFIED') : 'SEED';
  return {
    emergency: op.emergency, icu: op.icu, trauma: op.trauma,
    ...(op.capacityAsOf ? { reportedAt: op.capacityAsOf } : {}),
    provenance,
    verified: provenance === 'HOSPITAL_CONFIRMED' || provenance === 'AUTHORIZED_FEED',
  };
}

export async function referralOverview(caseId: string, nowMs = Date.now()): Promise<ReferralOverview | undefined> {
  const patient = patientsStore.get(caseId);
  if (!patient) return undefined;
  const required = patient.careRequirements;
  const events = await stateStore.queryEventsByCase(caseId);
  const latestCandidates = events
    .filter(e => e.eventType === 'hospital.candidate.generated')
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
    .pop();
  const candidates = latestCandidates?.eventType === 'hospital.candidate.generated' ? latestCandidates.payload.candidates : [];

  const rows: ReferralRow[] = [...hospitalsStore.values()].map(h => {
    const caps = h.capabilities as Record<string, boolean | undefined>;
    const listedRequired = required.filter(c => caps[capabilityKey(c)]);
    const c = candidates.find(x => x.hospitalId === h.hospitalId);
    const view = acceptanceLedger.view(caseId, h.hospitalId, nowMs);
    const referral: ReferralRow['referral'] = !view.request
      ? { state: 'NOT_REQUESTED' }
      : {
          state: view.requestState === 'REQUEST_CANCELLED' ? 'CANCELLED' : view.requestState === 'REQUEST_EXPIRED' ? 'EXPIRED' : 'OUTSTANDING',
          requestId: view.request.requestId, requestedAt: view.request.requestedAt, expiresAt: view.request.expiresAt,
          ...(view.request.cancelledAt ? { cancelledAt: view.request.cancelledAt } : {}),
        };
    const r = view.response;
    const answer: ReferralRow['answer'] = r && {
      responseId: r.responseId, requestId: r.requestId, status: r.status, respondedAt: r.respondedAt, validUntil: r.validUntil,
      current: (r.status === 'ACCEPTED' || r.status === 'LIMITED') ? Date.parse(r.validUntil) > nowMs && view.requestState !== 'REQUEST_CANCELLED' : true,
      limitations: [...r.limitations],
      provenance: r.trustedSource ?? 'UNVERIFIED',
    };
    return {
      hospitalId: h.hospitalId,
      name: h.displayName,
      dataStatus: h.dataStatus,
      listed: { listedRequired, missingRequired: required.filter(x => !listedRequired.includes(x)) },
      ...(c && latestCandidates ? { assessment: { eligibility: c.operationalEligibility, reason: c.reason, etaMinutes: c.etaMinutes, distanceKm: c.distanceKm, evaluatedAt: latestCandidates.timestamp } } : {}),
      referral,
      ...(answer ? { answer } : {}),
      capacity: capacityOf(h),
    };
  });
  return { caseId, requiredCapabilities: [...required], generatedAt: new Date(nowMs).toISOString(), rows };
}
