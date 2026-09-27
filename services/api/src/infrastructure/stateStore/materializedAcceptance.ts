import type { CareRequirement, HospitalAvailabilityResponse } from '@jiva/domain-models';
import type { CaseAcceptanceView } from '@jiva/domain-models';
import { AcceptanceLedger, compareRequestOrder, compareResponses, type AcceptanceView } from '../../feasibility/acceptanceLedger';

/**
 * Materialized acceptance/requirement records: an O(1)-indexed replacement for scanning event
 * history to answer "what is the current acceptance state for (case, hospital) / hospital-wide
 * UNAVAILABLE / latest requirement for case". Event history remains the audit trail and is never
 * removed; these are derived indexes maintained ALONGSIDE it.
 *
 * Both `LocalStateStore` and `DynamoStateStore` implement the same operations using the SAME
 * ordering rules as `AcceptanceLedger` (compareRequests / compareResponses / earliest-cancellation),
 * so:
 *   - stale evidence can never overwrite newer evidence (conditional "only if strictly newer" writes)
 *   - out-of-order and duplicate writes converge deterministically regardless of arrival order
 *   - `rebuildFromEvents` (bulk replay through AcceptanceLedger, the same reducer used for parity
 *     testing) produces byte-identical final records to the incremental live path
 *
 * Expiry (`validUntil`/`expiresAt`) is still evaluated at READ time by the feasibility engine
 * against the evaluation clock — materialization changes nothing about that.
 */

export interface MaterializedRequest { requestId: string; requestedAt: string; expiresAt: string; cancelledAt?: string }

export interface CaseHospitalRecord {
  request?: MaterializedRequest;
  response?: HospitalAvailabilityResponse;
}

/** Everything a `putAcceptance*` implementation needs to decide whether to accept a new fact. */
export function shouldAcceptRequest(existing: MaterializedRequest | undefined, incoming: MaterializedRequest): boolean {
  return !existing || compareRequestOrder(existing, incoming) < 0;
}
export function shouldAcceptResponse(existing: HospitalAvailabilityResponse | undefined, incoming: HospitalAvailabilityResponse): boolean {
  return !existing || compareResponses(incoming, existing) > 0;
}
export function shouldAcceptCancellation(existing: string | undefined, incomingCancelledAt: string): boolean {
  return !existing || Date.parse(incomingCancelledAt) < Date.parse(existing);
}
export function shouldAcceptWideUnavailable(existing: HospitalAvailabilityResponse | undefined, incoming: HospitalAvailabilityResponse): boolean {
  return incoming.status === 'UNAVAILABLE' && (!existing || compareResponses(incoming, existing) > 0);
}
export function shouldAcceptNewestAccepting(existingRespondedAt: string | undefined, incoming: HospitalAvailabilityResponse): boolean {
  return (incoming.status === 'ACCEPTED' || incoming.status === 'LIMITED') &&
    (!existingRespondedAt || Date.parse(incoming.respondedAt) > Date.parse(existingRespondedAt));
}
export function shouldAcceptRequirement(existing: CareRequirement | undefined, incoming: CareRequirement): boolean {
  return !existing || Date.parse(incoming.createdAt) > Date.parse(existing.createdAt) ||
    (Date.parse(incoming.createdAt) === Date.parse(existing.createdAt) && incoming.requirementId > existing.requirementId);
}

/** Same requestState/mismatch/hospital-wide-supersession logic as `AcceptanceLedger.view()`, computed from materialized parts. */
export function assembleView(
  record: CaseHospitalRecord | undefined,
  wideUnavailable: HospitalAvailabilityResponse | undefined,
  newestAcceptingAt: string | undefined,
  nowMs: number
): CaseAcceptanceView {
  const req = record?.request;
  const view: CaseAcceptanceView = {
    requestState: !req ? 'NOT_REQUESTED' : req.cancelledAt ? 'REQUEST_CANCELLED' : Date.parse(req.expiresAt) > nowMs ? 'OUTSTANDING' : 'REQUEST_EXPIRED',
  };
  if (req) view.request = { requestId: req.requestId, requestedAt: req.requestedAt, expiresAt: req.expiresAt, ...(req.cancelledAt ? { cancelledAt: req.cancelledAt } : {}) };
  const response = record?.response;
  if (response) {
    view.response = { ...response, acceptedCapabilities: [...response.acceptedCapabilities], limitations: [...response.limitations] };
    if (req && response.requestId !== req.requestId) view.requestIdMismatch = true;
  }
  if (wideUnavailable && !(newestAcceptingAt && Date.parse(newestAcceptingAt) > Date.parse(wideUnavailable.respondedAt))) {
    view.hospitalWideUnavailable = { ...wideUnavailable, acceptedCapabilities: [...wideUnavailable.acceptedCapabilities], limitations: [...wideUnavailable.limitations] };
  }
  return view;
}

/**
 * Store-backed AcceptanceView: every `.view()` call reads the materialized records directly
 * (O(1) indexed lookups), never scans or replays event history. Used by the shadow whenever the
 * store exposes the materialization methods (both LocalStateStore and DynamoStateStore do).
 */
export class MaterializedAcceptanceView implements AcceptanceView {
  constructor(private readonly store: {
    getAcceptanceRecord(caseId: string, hospitalId: string): Promise<CaseHospitalRecord | undefined>;
    getHospitalWideUnavailable(hospitalId: string): Promise<{ response?: HospitalAvailabilityResponse; newestAcceptingAt?: string } | undefined>;
  }) {}

  /** Async in truth; `AcceptanceView.view` is synchronous, so callers must `await preload()` first via `forHospitals`. */
  private cache = new Map<string, CaseAcceptanceView>();

  async preload(caseId: string, hospitalIds: Iterable<string>, nowMs: number): Promise<this> {
    await Promise.all([...hospitalIds].map(async hospitalId => {
      const [record, wide] = await Promise.all([this.store.getAcceptanceRecord(caseId, hospitalId), this.store.getHospitalWideUnavailable(hospitalId)]);
      this.cache.set(`${caseId}|${hospitalId}`, assembleView(record, wide?.response, wide?.newestAcceptingAt, nowMs));
    }));
    return this;
  }

  view(caseId: string, hospitalId: string): CaseAcceptanceView {
    return this.cache.get(`${caseId}|${hospitalId}`) || { requestState: 'NOT_REQUESTED' };
  }
}

/**
 * Bulk reconstruction: replay a COMPLETE (unbounded, paginated) event list through the same
 * `AcceptanceLedger` reducer used for the live path, and hand back the final per-(case,hospital)
 * records plus per-hospital wide-unavailable state, ready to be written back as materialized
 * records. This is how a store recovers if its materialized indexes are lost, and it is also the
 * "replay" side of the live-vs-replay equivalence proof (both go through this one reducer).
 */
export function rebuildFromEvents(events: Iterable<{ eventId: string; eventType: string; timestamp: string; payload?: unknown; metadata?: unknown }>): {
  byKey: Map<string, CaseHospitalRecord>;
  wideByHospital: Map<string, { response?: HospitalAvailabilityResponse; newestAcceptingAt?: string }>;
} {
  const ledger = AcceptanceLedger.fromEvents(events);
  const keys = new Set<string>();
  const hospitals = new Set<string>();
  for (const e of events) {
    const p: any = (e as any).payload;
    if (!p?.hospitalId) continue;
    hospitals.add(p.hospitalId);
    if (p.caseId) keys.add(`${p.caseId}|${p.hospitalId}`);
  }
  const farFuture = Date.now() + 100 * 365 * 24 * 3600 * 1000; // raw facts only: requestState is not used from this view
  const byKey = new Map<string, CaseHospitalRecord>();
  for (const key of keys) {
    const [caseId, hospitalId] = key.split('|');
    const v = ledger.view(caseId, hospitalId, farFuture);
    const rec: CaseHospitalRecord = {};
    if (v.request) rec.request = v.request;
    if (v.response) rec.response = v.response;
    byKey.set(key, rec);
  }
  const wideByHospital = new Map<string, { response?: HospitalAvailabilityResponse; newestAcceptingAt?: string }>();
  for (const hospitalId of hospitals) {
    const raw = ledger.hospitalWideRaw(hospitalId);
    if (raw.response || raw.newestAcceptingAt) wideByHospital.set(hospitalId, raw);
  }
  return { byKey, wideByHospital };
}
