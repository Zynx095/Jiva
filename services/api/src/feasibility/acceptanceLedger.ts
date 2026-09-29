import type { CapabilityType, CaseAcceptanceView, DataStatus, HospitalAvailabilityResponse } from '@jiva/domain-models';
import { canonicalJson } from '@jiva/feasibility';

export type LedgerApplyResult = 'APPLIED' | 'DUPLICATE' | 'CONFLICT' | 'STALE' | 'INVALID';

export interface LedgerRequest { requestId: string; caseId: string; hospitalId: string; requestedAt: string; expiresAt: string }

export function compareRequestOrder(a: { requestId: string; requestedAt: string }, b: { requestId: string; requestedAt: string }): number {
  return compareRequests(a as LedgerRequest, b as LedgerRequest);
}

const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);
const key = (caseId: string, hospitalId: string) => `${caseId}|${hospitalId}`;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Restrictiveness used ONLY to break an exact respondedAt tie: the more restrictive answer wins. */
export const RESTRICTIVENESS: Record<string, number> = { ACCEPTED: 0, LIMITED: 1, REJECTED: 2, UNAVAILABLE: 3 };

/**
 * THE ordering rule (one definition, used by live and replay alike). Response A is later than B iff
 *   respondedAt(A) > respondedAt(B), else
 *   restrictiveness(A) > restrictiveness(B)   (UNAVAILABLE > REJECTED > LIMITED > ACCEPTED), else
 *   responseId(A) > responseId(B)             (lexicographic).
 * It is a total order that does not depend on arrival order, event timestamps or the wall clock.
 */
export function compareResponses(a: HospitalAvailabilityResponse, b: HospitalAvailabilityResponse): number {
  const ta = ms(a.respondedAt), tb = ms(b.respondedAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ra = RESTRICTIVENESS[a.status], rb = RESTRICTIVENESS[b.status];
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.responseId < b.responseId ? -1 : a.responseId > b.responseId ? 1 : 0;
}

export function compareRequests(a: LedgerRequest, b: LedgerRequest): number {
  const ta = ms(a.requestedAt), tb = ms(b.requestedAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
}

function normalizeResponse(p: HospitalAvailabilityResponse): HospitalAvailabilityResponse | undefined {
  if (!p || !isStr(p.responseId) || !isStr(p.caseId) || !isStr(p.hospitalId) || !isStr(p.requestId)) return undefined;
  if (!(p.status in RESTRICTIVENESS)) return undefined;
  if (!Number.isFinite(ms(p.respondedAt)) || !Number.isFinite(ms(p.validUntil))) return undefined;
  return {
    ...p,
    acceptedCapabilities: Array.isArray(p.acceptedCapabilities) ? [...p.acceptedCapabilities] : [],
    limitations: Array.isArray(p.limitations) ? [...p.limitations] : [],
  };
}

/**
 * Per-(case, hospital) acceptance projection.
 *
 * The ledger stores a SET of facts (requests, responses, cancellations) and derives every answer in
 * view() as a pure function of that set. Because nothing depends on insertion order or on the
 * wall clock at insertion time, the live ledger (events applied as they arrive) and a ledger
 * replayed from history hold byte-identical state for the same events (see snapshot()).
 *
 *  - Duplicate responseId with an identical payload: ignored. With a DIFFERENT payload: the id is
 *    CONFLICTED and neither copy is used (deterministic and conservative).
 *  - A response that already claims ACCEPTED/LIMITED with validUntil <= respondedAt has an
 *    impossible window and is INVALID. One that merely ARRIVES late is kept; the engine treats it
 *    as expired at evaluation time. Arrival time is never consulted.
 *  - Out-of-order and stale responses are kept; view() selects by compareResponses().
 *  - UNAVAILABLE is additionally hospital-wide (legacy semantics) until a strictly newer
 *    ACCEPTED/LIMITED from the same hospital.
 *
 * Read-only projection: it never mutates hospital state and never affects legacy decisions.
 */
/** Common surface both the live in-memory ledger and a store-backed materialized view expose. */
export interface AcceptanceView {
  view(caseId: string, hospitalId: string, nowMs: number): CaseAcceptanceView;
}

export class AcceptanceLedger implements AcceptanceView {
  private requests = new Map<string, Map<string, LedgerRequest>>(); // key -> requestId -> request
  private cancellations = new Map<string, string>(); // requestId -> earliest cancelledAt
  private responseBody = new Map<string, HospitalAvailabilityResponse>(); // canonical payload -> response
  private byKey = new Map<string, Set<string>>(); // key -> canonical payloads
  private byHospital = new Map<string, Set<string>>(); // hospitalId -> canonical payloads
  private malformedSkipped = 0;

  /**
   * Rebuild the ledger from event history (AWS lambdas have no long-lived process). ONLY
   * hospital.acceptance.requested / .received / .cancelled events are consulted; everything else (including
   * feasibility.trace.recorded) is ignored, so telemetry can never feed a feasibility input. A
   * malformed or poisoned event is skipped on its own and never prevents the rest from loading.
   */
  static fromEvents(events: Iterable<{ eventId: string; eventType: string; timestamp: string; payload?: unknown; metadata?: unknown }>): AcceptanceLedger {
    const ledger = new AcceptanceLedger();
    const seen = new Set<string>();
    for (const e of events) {
      try {
        if (e.eventType !== 'hospital.acceptance.requested' && e.eventType !== 'hospital.acceptance.received' && e.eventType !== 'hospital.acceptance.cancelled') continue;
        if (seen.has(e.eventId)) continue;
        seen.add(e.eventId);
        if (e.eventType === 'hospital.acceptance.requested') ledger.recordRequest(e.payload as LedgerRequest);
        else if (e.eventType === 'hospital.acceptance.cancelled') ledger.applyCancellation(e.payload as { requestId: string; cancelledAt: string });
        else ledger.applyResponse(withTrust(e.payload as HospitalAvailabilityResponse, e.metadata));
      } catch {
        ledger.malformedSkipped++;
      }
    }
    return ledger;
  }

  get skippedMalformed(): number { return this.malformedSkipped; }

  hasProcessedResponse(responseId: string): boolean {
    for (const canon of this.responseBody.keys()) if (this.responseBody.get(canon)!.responseId === responseId) return true;
    return false;
  }

  reset(): void {
    this.requests.clear();
    this.cancellations.clear();
    this.responseBody.clear();
    this.byKey.clear();
    this.byHospital.clear();
    this.malformedSkipped = 0;
  }

  recordRequest(r: LedgerRequest): void {
    if (!r || !isStr(r.requestId) || !isStr(r.caseId) || !isStr(r.hospitalId) || !Number.isFinite(ms(r.requestedAt)) || !Number.isFinite(ms(r.expiresAt))) return;
    const k = key(r.caseId, r.hospitalId);
    const m = this.requests.get(k) || new Map<string, LedgerRequest>();
    const prior = m.get(r.requestId);
    // Same id seen twice: keep the canonical-minimum so the outcome is arrival-order independent.
    if (!prior || canonicalJson(r) < canonicalJson(prior)) m.set(r.requestId, { requestId: r.requestId, caseId: r.caseId, hospitalId: r.hospitalId, requestedAt: r.requestedAt, expiresAt: r.expiresAt });
    this.requests.set(k, m);
  }

  /** hospital.acceptance.cancelled payload. */
  applyCancellation(p: { requestId: string; cancelledAt: string }): void {
    this.cancelRequest(p?.requestId, p?.cancelledAt);
  }

  /** Withdraw a request. No producer exists yet; the semantics are defined and enforced by the engine. */
  cancelRequest(requestId: string, cancelledAt: string): void {
    if (!isStr(requestId) || !Number.isFinite(ms(cancelledAt))) return;
    const prior = this.cancellations.get(requestId);
    if (!prior || ms(cancelledAt) < ms(prior)) this.cancellations.set(requestId, cancelledAt);
  }

  applyResponse(input: HospitalAvailabilityResponse): LedgerApplyResult {
    const p = normalizeResponse(input);
    if (!p) return 'INVALID';
    if ((p.status === 'ACCEPTED' || p.status === 'LIMITED') && ms(p.validUntil) <= ms(p.respondedAt)) return 'INVALID';
    const canon = canonicalJson(p);
    if (this.responseBody.has(canon)) return 'DUPLICATE';
    const conflicting = [...this.responseBody.values()].some(x => x.responseId === p.responseId);
    const k = key(p.caseId, p.hospitalId);
    const before = this.best(k);
    this.responseBody.set(canon, p);
    (this.byKey.get(k) || this.byKey.set(k, new Set()).get(k)!).add(canon);
    (this.byHospital.get(p.hospitalId) || this.byHospital.set(p.hospitalId, new Set()).get(p.hospitalId)!).add(canon);
    if (conflicting) return 'CONFLICT';
    return before && compareResponses(p, before) < 0 ? 'STALE' : 'APPLIED';
  }

  /** Conflicted responseIds are excluded from every view. */
  private usable(canon: string): HospitalAvailabilityResponse | undefined {
    const r = this.responseBody.get(canon)!;
    for (const other of this.responseBody.values()) if (other !== r && other.responseId === r.responseId) return undefined;
    return r;
  }

  private best(k: string): HospitalAvailabilityResponse | undefined {
    let best: HospitalAvailabilityResponse | undefined;
    for (const canon of this.byKey.get(k) || []) {
      const r = this.usable(canon);
      if (r && (!best || compareResponses(r, best) > 0)) best = r;
    }
    return best;
  }

  /**
   * Raw per-hospital facts behind hospitalWideUnavailable, BEFORE the "superseded by a newer
   * accepting response" check. Used to materialize the two independent facts (the two are updated
   * independently in the live incremental path) rather than the already-resolved boolean.
   */
  hospitalWideRaw(hospitalId: string): { response?: HospitalAvailabilityResponse; newestAcceptingAt?: string } {
    let wide: HospitalAvailabilityResponse | undefined;
    let newestAcceptingAt: string | undefined;
    let newestMs = Number.NEGATIVE_INFINITY;
    for (const canon of this.byHospital.get(hospitalId) || []) {
      const r = this.usable(canon);
      if (!r) continue;
      if (r.status === 'UNAVAILABLE' && (!wide || compareResponses(r, wide) > 0)) wide = r;
      if ((r.status === 'ACCEPTED' || r.status === 'LIMITED') && ms(r.respondedAt) > newestMs) { newestMs = ms(r.respondedAt); newestAcceptingAt = r.respondedAt; }
    }
    return { response: wide, newestAcceptingAt };
  }

  view(caseId: string, hospitalId: string, nowMs: number): CaseAcceptanceView {
    const k = key(caseId, hospitalId);
    let req: LedgerRequest | undefined;
    for (const r of this.requests.get(k)?.values() || []) if (!req || compareRequests(r, req) > 0) req = r;
    const cancelledAt = req ? this.cancellations.get(req.requestId) : undefined;
    const view: CaseAcceptanceView = {
      requestState: !req ? 'NOT_REQUESTED' : cancelledAt ? 'REQUEST_CANCELLED' : ms(req.expiresAt) > nowMs ? 'OUTSTANDING' : 'REQUEST_EXPIRED',
    };
    if (req) view.request = { requestId: req.requestId, requestedAt: req.requestedAt, expiresAt: req.expiresAt, ...(cancelledAt ? { cancelledAt } : {}) };
    const response = this.best(k);
    if (response) {
      view.response = { ...response, acceptedCapabilities: [...response.acceptedCapabilities], limitations: [...response.limitations] };
      if (req && response.requestId !== req.requestId) view.requestIdMismatch = true;
    }
    // Hospital-wide UNAVAILABLE: latest UNAVAILABLE from any case, unless a strictly newer accepting response exists.
    let wide: HospitalAvailabilityResponse | undefined;
    let newestAccepting = Number.NEGATIVE_INFINITY;
    for (const canon of this.byHospital.get(hospitalId) || []) {
      const r = this.usable(canon);
      if (!r) continue;
      if (r.status === 'UNAVAILABLE' && (!wide || compareResponses(r, wide) > 0)) wide = r;
      if ((r.status === 'ACCEPTED' || r.status === 'LIMITED') && ms(r.respondedAt) > newestAccepting) newestAccepting = ms(r.respondedAt);
    }
    if (wide && !(newestAccepting > ms(wide.respondedAt))) view.hospitalWideUnavailable = { ...wide, acceptedCapabilities: [...wide.acceptedCapabilities], limitations: [...wide.limitations] };
    return view;
  }

  /**
   * Canonical dump of the stored fact set, independent of insertion order. Two ledgers built from
   * the same events (live or replayed, in any order) produce the same string.
   */
  snapshot(): string {
    const requests = [...this.requests.values()].flatMap(m => [...m.values()]).map(r => canonicalJson(r)).sort();
    const responses = [...this.responseBody.keys()].sort();
    const cancellations = [...this.cancellations.entries()].map(([id, at]) => `${id}@${at}`).sort();
    return canonicalJson({ requests, responses, cancellations });
  }

  /** Cases that currently have any ledger entry for a hospital (for inspection/tests). */
  casesFor(hospitalId: string): string[] {
    const out = new Set<string>();
    for (const k of [...this.requests.keys(), ...this.byKey.keys()]) {
      const [c, h] = k.split('|');
      if (h === hospitalId) out.add(c);
    }
    return [...out].sort();
  }
}

/**
 * Attach the TRUSTED provenance stamped by the ingestion adapter (event.metadata.trustedEvidence)
 * to a response. Anything the client put in payload.source is left as an unused claim; a response
 * with no stamp is UNVERIFIED and can never resolve an unknown.
 */
export function withTrust(p: HospitalAvailabilityResponse, metadata: unknown): HospitalAvailabilityResponse {
  const status = (metadata as { trustedEvidence?: { status?: string } } | undefined)?.trustedEvidence?.status;
  const trusted: DataStatus = status === 'SYNTHETIC_DEMO' || status === 'HOSPITAL_CONFIRMED' || status === 'AUTHORIZED_FEED' ? status : 'UNVERIFIED';
  return { ...p, acceptedCapabilities: (p?.acceptedCapabilities ?? []) as CapabilityType[], trustedSource: trusted };
}

/**
 * Is this hospital CURRENTLY accepted for the case the view was built for (a fresh ACCEPTED or
 * LIMITED response)? Used by the legacy decision path (pickLegacyDestination) as the case-scoped
 * replacement for the shared one-slot `operationalState.acceptanceCaseId` check.
 */
export function isCurrentlyAccepted(view: CaseAcceptanceView, nowMs: number): boolean {
  const r = view.response;
  return !!r && (r.status === 'ACCEPTED' || r.status === 'LIMITED') && Date.parse(r.validUntil) > nowMs;
}

export interface CaseAcceptanceStatus {
  status: 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'UNAVAILABLE' | 'UNKNOWN';
  expired: boolean;
}

/**
 * The case-scoped acceptance status for `evaluateHospitals` (the legacy candidate/eligibility
 * engine), derived from the SAME per-(case, hospital) view the shadow uses, instead of the shared
 * one-slot `operationalState.acceptance*` fields. Hospital-wide UNAVAILABLE (from ANY case, still
 * legacy semantics) takes priority; otherwise this case's own response governs.
 */
export function caseAcceptanceStatus(view: CaseAcceptanceView, nowMs: number): CaseAcceptanceStatus {
  const wide = view.hospitalWideUnavailable;
  if (wide && Date.parse(wide.validUntil) > nowMs) return { status: 'UNAVAILABLE', expired: false };
  const r = view.response;
  if (!r) return { status: 'UNKNOWN', expired: false };
  // A positive response can only stand on a live request: once the request it depends on is
  // cancelled, the case's standing offer is withdrawn and the response can no longer resolve
  // eligibility, mirroring the full engine's responseUsability() (packages/feasibility/src/rules.ts,
  // `RESPONSE_REQUEST_CANCELLED`). Negative responses (REJECTED/UNAVAILABLE) still stand: they only
  // ever make the legacy decision more conservative, never eligible.
  if ((r.status === 'ACCEPTED' || r.status === 'LIMITED') && view.requestState === 'REQUEST_CANCELLED') {
    return { status: 'UNKNOWN', expired: false };
  }
  const expired = Date.parse(r.validUntil) <= nowMs;
  return { status: r.status, expired };
}

export const acceptanceLedger = new AcceptanceLedger();
