import { caseResponses, eventAmbulanceId, eventCaseId, hospitalShortName, isAwaiting } from '@jiva/ui/src';
import type { AmbulanceState, CandidateSummary, CaseResponse, HospitalState, JivaEvent, PatientState } from './types';

/** At a hospital: the unit's position or the hospital placed the patient there (ARRIVED), or the hospital recorded the handover. */
export const isAtHospital = (p: PatientState) => p.currentStatus === 'ARRIVED' || p.currentStatus === 'HANDED_OVER';

/** Open = still being coordinated (not at a hospital yet, not closed). */
export const isOpenCase = (p: PatientState) => p.currentStatus !== 'DISCHARGED' && !isAtHospital(p);

export const isOnJob = (a: AmbulanceState) => a.status !== 'AVAILABLE' && a.status !== 'UNAVAILABLE';

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export { caseResponses, isAwaiting };

/** Hospitals with at least one request still awaiting an answer. */
export function pendingHospitals(responses: Map<string, Map<string, CaseResponse>>, openCases: Set<string>, now: number): Set<string> {
  const out = new Set<string>();
  for (const [caseId, m] of responses) {
    if (!openCases.has(caseId)) continue;
    for (const r of m.values()) if (isAwaiting(r, now)) out.add(r.hospitalId);
  }
  return out;
}

/**
 * Hospitals holding a current (unexpired) acceptance for a case still being coordinated: ACCEPTED wins
 * over LIMITED. A hospital's operational state keeps only its LATEST answer to any case, so declining one
 * patient must not hide that it is still receiving another.
 */
export function acceptingHospitals(responses: Map<string, Map<string, CaseResponse>>, openCases: Set<string>, now: number): Map<string, 'ACCEPTED' | 'LIMITED'> {
  const out = new Map<string, 'ACCEPTED' | 'LIMITED'>();
  for (const [caseId, m] of responses) {
    if (!openCases.has(caseId)) continue;
    for (const r of m.values()) {
      if ((r.status !== 'ACCEPTED' && r.status !== 'LIMITED') || (r.validUntil && Date.parse(r.validUntil) <= now)) continue;
      if (r.status === 'ACCEPTED' || !out.has(r.hospitalId)) out.set(r.hospitalId, r.status);
    }
  }
  return out;
}

/**
 * The status a hospital shows on the network map and lists. Unknown stays unknown:
 * no response is never rendered as available. "Unavailable" (ED or a hospital-wide answer) wins; then a
 * current acceptance for any open case; then the hospital's latest answer.
 */
export function hospitalDisplayStatus(h: HospitalState, pending: Set<string>, accepting: Map<string, 'ACCEPTED' | 'LIMITED'> = new Map()): string {
  const op = h.operationalState;
  if (op?.emergency === 'UNAVAILABLE') return 'UNAVAILABLE';
  const a = op?.acceptance;
  if (a === 'UNAVAILABLE') return a;
  const current = accepting.get(h.hospitalId);
  if (current) return current;
  if (a === 'ACCEPTED' || a === 'LIMITED' || a === 'REJECTED') return a;
  if (pending.has(h.hospitalId)) return 'PENDING';
  return 'UNKNOWN';
}

export interface Freshness {
  text: string;
  stale: boolean;
}

/** How current a hospital's operational picture is. */
export function hospitalFreshness(h: HospitalState, now: number): Freshness {
  const op = h.operationalState;
  if (op?.expiresAt && (op.acceptance === 'ACCEPTED' || op.acceptance === 'LIMITED')) {
    const left = Date.parse(op.expiresAt) - now;
    if (left > 0 && left < 5 * 60_000) return { text: `Acceptance expires in ${Math.ceil(left / 60_000)} min`, stale: true };
  }
  if (!op?.capacityAsOf && !op?.lastConfirmedAt) return { text: 'Seed data — no live report yet', stale: true };
  const last = Math.max(Date.parse(op.capacityAsOf ?? '') || 0, Date.parse(op.lastConfirmedAt ?? '') || 0);
  const ageMin = (now - last) / 60_000;
  return { text: '', stale: ageMin > 30 };
}

/** How current an ambulance position is. Units on a job without a recent update are flagged. */
export function gpsFreshness(a: AmbulanceState, now: number): Freshness {
  if (!a.locationAsOf) return { text: isOnJob(a) ? 'No position update since dispatch' : 'Station position', stale: isOnJob(a) };
  const ageMin = (now - Date.parse(a.locationAsOf)) / 60_000;
  return { text: '', stale: isOnJob(a) && ageMin > 3 };
}

export interface CaseFacts {
  severity?: string;
  condition?: string;
  reportedAt?: string;
}

/** Severity and reported condition per case, from the emergency report itself. */
export function caseFacts(eventsNewestFirst: JivaEvent[]): Map<string, CaseFacts> {
  const out = new Map<string, CaseFacts>();
  for (const e of eventsNewestFirst) {
    if (e.eventType !== 'patient.emergency.created') continue;
    const id = eventCaseId(e);
    if (id && !out.has(id)) out.set(id, { severity: str(e.payload.severity), condition: str(e.payload.condition), reportedAt: e.timestamp });
  }
  return out;
}

/** Latest legacy candidate evaluation per case (the "why" behind who was asked). */
export function caseCandidates(eventsNewestFirst: JivaEvent[]): Map<string, CandidateSummary[]> {
  const out = new Map<string, CandidateSummary[]>();
  for (const e of eventsNewestFirst) {
    if (e.eventType !== 'hospital.candidate.generated') continue;
    const id = str(e.payload.caseId);
    if (!id || out.has(id) || !Array.isArray(e.payload.candidates)) continue;
    out.set(
      id,
      (e.payload.candidates as Array<Record<string, unknown>>).map((c) => ({
        hospitalId: String(c.hospitalId),
        hospitalName: String(c.hospitalName),
        operationalEligibility: String(c.operationalEligibility),
        distanceKm: typeof c.distanceKm === 'number' ? c.distanceKm : undefined,
        etaMinutes: typeof c.etaMinutes === 'number' ? c.etaMinutes : undefined,
        reason: str(c.reason),
        missingCapabilities: strs(c.missingCapabilities),
      })),
    );
  }
  return out;
}

/** Events that belong to a case, including routing events that only carry the ambulance id. */
export function eventsForCase(eventsNewestFirst: JivaEvent[], caseId: string, ambulanceId?: string, since?: string): JivaEvent[] {
  const sinceMs = since ? Date.parse(since) : 0;
  return eventsNewestFirst.filter((e) => {
    if (eventCaseId(e) === caseId) return true;
    return !!ambulanceId && eventAmbulanceId(e) === ambulanceId && Date.parse(e.timestamp) >= sinceMs;
  });
}

/** Name resolver used by every human-readable sentence on this screen. */
export function makeNameResolver(hospitals: HospitalState[]) {
  const map = new Map(hospitals.map((h) => [h.hospitalId, hospitalShortName(h.displayName, h.address?.locality)]));
  return (id: string) => map.get(id);
}
