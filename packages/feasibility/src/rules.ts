import type {
  CapabilityStatus,
  CapabilityType,
  ConstraintOutcome,
  ConstraintResult,
  DataStatus,
  EvidenceClass,
  EvidenceRef,
  FeasibilitySnapshot,
  HospitalAvailabilityResponse,
  HospitalInput,
  ReasonCode,
} from '@jiva/domain-models';
import { CAPABILITY_KEY, LIVE_STATUS_KEY, isCapabilityType } from './capabilityMap';
import { assessFreshness, FreshnessAssessment, FreshnessPolicy } from './policy';

export interface RuleContext {
  snapshot: FeasibilitySnapshot;
  policy: FreshnessPolicy;
  hospitalIndex: number;
}

/** Evidence statuses that may assert CURRENT operational state (PASS or FAIL) in any environment. */
const OPERATIONAL_GRADE: ReadonlySet<DataStatus> = new Set<DataStatus>([
  'HOSPITAL_CONFIRMED',
  'AUTHORIZED_FEED',
  'CURRENT',
]);

/**
 * Whether evidence with this status may assert current state. SYNTHETIC_DEMO qualifies ONLY when the
 * policy's evidence environment is DEMO: in PRODUCTION it can never satisfy an operational rule.
 */
export function isOperationalGrade(status: DataStatus | string, policy: FreshnessPolicy): boolean {
  if (status === 'SYNTHETIC_DEMO') return policy.evidenceEnvironment === 'DEMO';
  return OPERATIONAL_GRADE.has(status as DataStatus);
}

function ref(
  ctx: RuleContext,
  path: string,
  cls: EvidenceClass,
  ev: { source: string; dataStatus: DataStatus | string; observedAt?: string; validUntil?: string; confidence?: number },
  fresh: FreshnessAssessment
): EvidenceRef {
  return {
    snapshotId: ctx.snapshot.snapshotId,
    path: `candidates[${ctx.hospitalIndex}].${path}`,
    evidenceClass: cls,
    source: ev.source,
    dataStatus: ev.dataStatus,
    observedAt: ev.observedAt,
    validUntil: fresh.effectiveExpiry ?? ev.validUntil,
    ageSeconds: fresh.ageSeconds,
    freshness: fresh.freshness,
    confidence: ev.confidence,
  };
}

function result(
  ruleId: string,
  ruleName: string,
  category: ConstraintResult['category'],
  outcome: ConstraintOutcome,
  reasonCode: ReasonCode,
  rationale: string,
  evidenceRefs: EvidenceRef[],
  resolvableByAcceptance: boolean
): ConstraintResult {
  return { ruleId, ruleName, category, outcome, reasonCode, rationale, evidenceRefs, resolvableByAcceptance };
}

// ------------------------------------------------------------------ acceptance helpers

export interface ResponseAssessment {
  response: HospitalAvailabilityResponse;
  fresh: FreshnessAssessment;
  ref: EvidenceRef;
}

function assessResponse(
  ctx: RuleContext,
  path: string,
  response: HospitalAvailabilityResponse | undefined
): ResponseAssessment | undefined {
  if (!response) return undefined;
  const ev = { observedAt: response.respondedAt, validUntil: response.validUntil };
  const fresh = assessFreshness('ACCEPTANCE_RESPONSE', ev, ctx.snapshot.evaluatedAt, ctx.policy);
  return {
    response,
    fresh,
    ref: ref(ctx, path, 'ACCEPTANCE_RESPONSE', {
      source: 'acceptance-response', // fixed token; no client-supplied text
      dataStatus: response.trustedSource ?? 'UNVERIFIED',
      observedAt: response.respondedAt,
      validUntil: response.validUntil,
    }, fresh),
  };
}

/** The case-scoped response, only if it belongs to this case and hospital. */
export function caseResponse(ctx: RuleContext, h: HospitalInput): ResponseAssessment | undefined {
  const r = h.acceptance.response;
  if (!r || r.caseId !== ctx.snapshot.case.caseId || r.hospitalId !== h.hospitalId) return undefined;
  return assessResponse(ctx, 'acceptance.response', r);
}

/** respondedAt is stamped by the hospital's clock. Ingestion already tolerates 60 s of future skew; the same tolerance applies before requestedAt. */
const CLOCK_SKEW_MS = 60_000;

export type ResponseUsability =
  | { usable: true }
  | { usable: false; reason: ReasonCode };

/**
 * A POSITIVE response (ACCEPTED/LIMITED) may resolve unknowns only if ALL hold:
 *  - a request exists for this exact case + hospital, is not cancelled, and is the CURRENT one
 *    (a response naming an older request id is superseded, one naming an unknown id is uncorrelated);
 *  - the response was made inside that request's [requestedAt, expiresAt] window;
 *  - its provenance was derived by a trusted adapter and is operational-grade under the policy.
 * Negative responses (REJECTED/UNAVAILABLE, LIMITED coverage gaps) restrict and therefore need no
 * correlation: an unsolicited negative can only make the engine more conservative.
 */
export function responseUsability(ctx: RuleContext, h: HospitalInput, r: HospitalAvailabilityResponse): ResponseUsability {
  const req = h.acceptance.request;
  if (!req) return { usable: false, reason: 'RESPONSE_NO_VALID_REQUEST' };
  if (req.cancelledAt) return { usable: false, reason: 'RESPONSE_REQUEST_CANCELLED' };
  if (r.requestId !== req.requestId) return { usable: false, reason: 'RESPONSE_REQUEST_SUPERSEDED' };
  const at = Date.parse(r.respondedAt);
  if (!Number.isFinite(at) || at < Date.parse(req.requestedAt) - CLOCK_SKEW_MS || at > Date.parse(req.expiresAt)) {
    return { usable: false, reason: 'RESPONSE_OUTSIDE_REQUEST_WINDOW' };
  }
  if (!isOperationalGrade(r.trustedSource ?? 'UNVERIFIED', ctx.policy)) return { usable: false, reason: 'RESPONSE_EVIDENCE_NOT_TRUSTED' };
  return { usable: true };
}

export function currentAccepting(ctx: RuleContext, h: HospitalInput): ResponseAssessment | undefined {
  const r = caseResponse(ctx, h);
  if (!r || r.fresh.freshness !== 'FRESH') return undefined;
  if (r.response.status !== 'ACCEPTED' && r.response.status !== 'LIMITED') return undefined;
  return responseUsability(ctx, h, r.response).usable ? r : undefined;
}

// ------------------------------------------------------------------ HC-CLIN-01

export function ruleRequiredCapability(ctx: RuleContext, h: HospitalInput): ConstraintResult & {
  matched: string[]; missing: string[]; unknown: string[];
} {
  const required = ctx.snapshot.case.requirement.requiredCapabilities as string[];
  const capEv = h.capabilities;
  const capFresh = assessFreshness('LISTED_CAPABILITY', capEv, ctx.snapshot.evaluatedAt, ctx.policy);
  const capRef = ref(ctx, 'capabilities', 'LISTED_CAPABILITY', capEv, capFresh);
  const accepting = currentAccepting(ctx, h);
  const confirmed = new Set<string>(accepting ? accepting.response.acceptedCapabilities : []);
  const syntheticBlocked = capEv.dataStatus === 'SYNTHETIC_DEMO' && ctx.policy.evidenceEnvironment !== 'DEMO';
  const capsUnusable = capEv.dataStatus === 'UNKNOWN' || capEv.dataStatus === 'NOT_DISCLOSED' || syntheticBlocked;

  const matched: string[] = [];
  const missing: string[] = [];
  const unknown: string[] = [];
  const notes: string[] = [];
  const refs: EvidenceRef[] = [capRef];
  if (accepting && confirmed.size > 0) refs.push(accepting.ref);

  const conflicts: string[] = [];
  for (const cap of required) {
    if (!isCapabilityType(cap)) {
      unknown.push(cap);
      notes.push(`${cap}: unrecognized capability code`);
      continue;
    }
    const listed = capsUnusable ? undefined : capEv.value[CAPABILITY_KEY[cap as CapabilityType]];
    if (listed === false) {
      // An explicit negative is a known fact. A response cannot flip it (the hospital UI echoes the
      // requested capabilities into acceptedCapabilities, so a positive there is not independent
      // evidence); the contradiction is recorded instead of being resolved in the positive's favour.
      missing.push(cap);
      if (confirmed.has(cap)) conflicts.push(cap);
      continue;
    }
    if (confirmed.has(cap)) {
      // A current, case-scoped hospital response may resolve an UNKNOWN (never contradict a listing).
      matched.push(cap);
      continue;
    }
    if (listed === true) matched.push(cap);
    else unknown.push(cap);
  }

  const staleNote = capFresh.freshness === 'STALE' ? ' (listing past its review horizon; flagged, still used as a static fact)' : '';
  const src = `${capEv.dataStatus} listing '${capEv.source}'`;
  let outcome: ConstraintOutcome;
  let reason: ReasonCode;
  let rationale: string;
  if (missing.length > 0) {
    outcome = 'FAIL';
    reason = 'CAPABILITY_NOT_PROVIDED';
    rationale = `Explicitly not provided per ${src}: ${missing.join(', ')}.${conflicts.length ? ` Contradicted by a positive response for ${conflicts.join(', ')}; the explicit listing is not overridden.` : ''}`;
  } else if (unknown.length > 0) {
    outcome = 'UNKNOWN';
    reason = unknown.some(c => !isCapabilityType(c)) ? 'UNRECOGNIZED_CAPABILITY' : syntheticBlocked ? 'EVIDENCE_NOT_OPERATIONAL_GRADE' : capsUnusable ? 'NOT_DISCLOSED' : 'NOT_LISTED';
    rationale = `No evidence either way for: ${unknown.join(', ')} (${src}). Unknown is not treated as absent.${notes.length ? ' ' + notes.join('; ') : ''}`;
  } else {
    outcome = 'PASS';
    reason = matched.some(c => confirmed.has(c)) ? 'CAPABILITY_CONFIRMED_BY_RESPONSE' : 'CAPABILITY_LISTED';
    rationale = `All required capabilities present: ${matched.join(', ') || '(none required)'} — ${src}. A listing is not a claim of current readiness.`;
  }
  return {
    ...result('HC-CLIN-01', 'required_capability_listed', 'CLINICAL_CAPABILITY', outcome, reason, rationale + staleNote, refs, false),
    matched, missing, unknown,
  };
}

// ------------------------------------------------------------------ HC-OPS-01 / HC-OPS-02

interface StatusEval { outcome: ConstraintOutcome; reason: ReasonCode; detail: string }

function evalLiveStatus(status: CapabilityStatus, usable: boolean, dataStatus: string, fresh: FreshnessAssessment): StatusEval {
  if (!usable) {
    return { outcome: 'UNKNOWN', reason: 'EVIDENCE_NOT_OPERATIONAL_GRADE', detail: `${dataStatus} evidence cannot assert current state` };
  }
  if (fresh.freshness === 'UNTIMED') return { outcome: 'UNKNOWN', reason: 'EVIDENCE_UNTIMED', detail: 'no observation time' };
  if (fresh.freshness === 'STALE') {
    // A3: expired evidence loses its assertion in BOTH directions. Never inferred positive.
    return { outcome: 'UNKNOWN', reason: 'EVIDENCE_STALE', detail: `${status} expired at ${fresh.effectiveExpiry}` };
  }
  if (status === 'UNAVAILABLE') return { outcome: 'FAIL', reason: 'OPERATIONAL_UNAVAILABLE', detail: 'UNAVAILABLE (current)' };
  if (status === 'AVAILABLE' || status === 'LIMITED') return { outcome: 'PASS', reason: 'OPERATIONAL_STATUS_CURRENT', detail: `${status} (current)` };
  return { outcome: 'UNKNOWN', reason: 'NO_LIVE_EVIDENCE', detail: 'reported UNKNOWN' };
}

function combine(evals: { key: string; e: StatusEval }[]): { outcome: ConstraintOutcome; reason: ReasonCode } {
  const fail = evals.find(x => x.e.outcome === 'FAIL');
  if (fail) return { outcome: 'FAIL', reason: fail.e.reason };
  const unk = evals.find(x => x.e.outcome === 'UNKNOWN');
  if (unk) return { outcome: 'UNKNOWN', reason: unk.e.reason };
  return { outcome: 'PASS', reason: 'OPERATIONAL_STATUS_CURRENT' };
}

function operationalInputs(ctx: RuleContext, h: HospitalInput) {
  const op = h.operational;
  const fresh = assessFreshness('OPERATIONAL_CAPACITY', op, ctx.snapshot.evaluatedAt, ctx.policy);
  return { op, fresh, usable: isOperationalGrade(op.dataStatus, ctx.policy), refs: [ref(ctx, 'operational', 'OPERATIONAL_CAPACITY', op, fresh)] };
}

export function ruleEmergencyDepartment(ctx: RuleContext, h: HospitalInput): ConstraintResult {
  const { op, fresh, usable, refs } = operationalInputs(ctx, h);
  const e = evalLiveStatus(op.statuses.emergency, usable, op.dataStatus, fresh);
  return result('HC-OPS-01', 'ed_not_unavailable', 'OPERATIONAL_AVAILABILITY', e.outcome, e.reason,
    `Emergency department: ${e.detail}.${e.outcome === 'UNKNOWN' ? ' Resolved by hospital acceptance, never assumed available.' : ''}`, refs, true);
}

export function ruleRequiredUnits(ctx: RuleContext, h: HospitalInput): ConstraintResult {
  const { op, fresh, usable, refs } = operationalInputs(ctx, h);
  const required = ctx.snapshot.case.requirement.requiredCapabilities as string[];
  const evals = required
    .filter((c): c is CapabilityType => isCapabilityType(c) && LIVE_STATUS_KEY[c] !== undefined)
    .map(c => ({ key: c, e: evalLiveStatus(op.statuses[LIVE_STATUS_KEY[c]!], usable, op.dataStatus, fresh) }));
  if (evals.length === 0) {
    return result('HC-OPS-02', 'required_unit_not_unavailable', 'OPERATIONAL_AVAILABILITY', 'NOT_APPLICABLE',
      'NO_LIVE_STATUS_FOR_REQUIRED', 'No required capability has a live unit status.', refs, true);
  }
  const c = combine(evals);
  return result('HC-OPS-02', 'required_unit_not_unavailable', 'OPERATIONAL_AVAILABILITY', c.outcome, c.reason,
    evals.map(x => `${x.key}: ${x.e.detail}`).join('; ') + '.', refs, true);
}

// ------------------------------------------------------------------ HC-ACC-01..04

export function ruleNotRejected(ctx: RuleContext, h: HospitalInput): ConstraintResult {
  const r = caseResponse(ctx, h);
  // REJECTED for this case stands until the hospital sends a newer response for the case.
  if (r && r.response.status === 'REJECTED') {
    return result('HC-ACC-01', 'not_rejected_for_case', 'OPERATIONAL_AVAILABILITY', 'FAIL', 'REJECTED',
      `Hospital REJECTED case ${ctx.snapshot.case.caseId} at ${r.response.respondedAt}.`, [r.ref], false);
  }
  return result('HC-ACC-01', 'not_rejected_for_case', 'OPERATIONAL_AVAILABILITY', 'PASS', 'NOT_REJECTED',
    'No rejection recorded for this case.', r ? [r.ref] : [], false);
}

export function ruleNotHospitalUnavailable(ctx: RuleContext, h: HospitalInput): ConstraintResult {
  const candidates = [h.acceptance.hospitalWideUnavailable, caseResponse(ctx, h)?.response]
    .filter((x): x is HospitalAvailabilityResponse => !!x && x.status === 'UNAVAILABLE' && x.hospitalId === h.hospitalId);
  if (candidates.length === 0) {
    return result('HC-ACC-02', 'not_hospital_wide_unavailable', 'OPERATIONAL_AVAILABILITY', 'PASS', 'NOT_HOSPITAL_UNAVAILABLE',
      'No UNAVAILABLE response on record.', [], true);
  }
  const latest = candidates.reduce((a, b) => (Date.parse(b.respondedAt) > Date.parse(a.respondedAt) ? b : a));
  const a = assessResponse(ctx, 'acceptance.hospitalWideUnavailable', latest)!;
  if (a.fresh.freshness === 'FRESH') {
    return result('HC-ACC-02', 'not_hospital_wide_unavailable', 'OPERATIONAL_AVAILABILITY', 'FAIL', 'HOSPITAL_UNAVAILABLE',
      `Hospital reported UNAVAILABLE at ${latest.respondedAt}, valid until ${latest.validUntil}.`, [a.ref], true);
  }
  // A3: expired UNAVAILABLE loses its assertion -> UNKNOWN, never AVAILABLE.
  return result('HC-ACC-02', 'not_hospital_wide_unavailable', 'OPERATIONAL_AVAILABILITY', 'UNKNOWN', 'UNAVAILABLE_EXPIRED',
    `UNAVAILABLE report expired at ${a.fresh.effectiveExpiry}; current status unknown.`, [a.ref], true);
}

export function ruleLimitedCoversRequired(ctx: RuleContext, h: HospitalInput): ConstraintResult {
  const r = caseResponse(ctx, h);
  if (!r || r.response.status !== 'LIMITED') {
    return result('HC-ACC-03', 'limited_covers_required', 'CLINICAL_CAPABILITY', 'NOT_APPLICABLE', 'NO_LIMITED_RESPONSE',
      'No LIMITED response for this case.', [], true);
  }
  if (r.fresh.freshness !== 'FRESH') {
    return result('HC-ACC-03', 'limited_covers_required', 'CLINICAL_CAPABILITY', 'UNKNOWN', 'LIMITED_EXPIRED',
      `LIMITED response expired at ${r.fresh.effectiveExpiry}.`, [r.ref], true);
  }
  const accepted = new Set<string>(r.response.acceptedCapabilities);
  const required = ctx.snapshot.case.requirement.requiredCapabilities as string[];
  const lacking = required.filter(c => !accepted.has(c));
  if (lacking.length === 0) {
    const usability = responseUsability(ctx, h, r.response);
    if (!usability.usable) {
      return result('HC-ACC-03', 'limited_covers_required', 'CLINICAL_CAPABILITY', 'UNKNOWN', usability.reason,
        `LIMITED response cannot be used as evidence (${usability.reason}).`, [r.ref], true);
    }
  }
  if (lacking.length > 0) {
    return result('HC-ACC-03', 'limited_covers_required', 'CLINICAL_CAPABILITY', 'FAIL', 'LIMITED_MISSING_CAPABILITY',
      `LIMITED acceptance does not cover required: ${lacking.join(', ')}. ${r.response.limitations.length} limitation(s) stated.`, [r.ref], false);
  }
  return result('HC-ACC-03', 'limited_covers_required', 'CLINICAL_CAPABILITY', 'PASS', 'LIMITED_COVERS_REQUIRED',
    `LIMITED acceptance covers all required capabilities. ${r.response.limitations.length} limitation(s) stated.`, [r.ref], true);
}

export function ruleCurrentAcceptance(ctx: RuleContext, h: HospitalInput): ConstraintResult & {
  pendingOn?: 'ACCEPTANCE_REQUEST' | 'ACCEPTANCE_RESPONSE';
} {
  const name = 'current_acceptance';
  const r = caseResponse(ctx, h);
  if (r && (r.response.status === 'ACCEPTED' || r.response.status === 'LIMITED')) {
    const usability = responseUsability(ctx, h, r.response);
    if (!usability.usable) {
      return {
        ...result('HC-ACC-04', name, 'OPERATIONAL_AVAILABILITY', 'UNKNOWN', usability.reason,
          `${r.response.status} response cannot be used as current acceptance evidence (${usability.reason}); a valid request/response exchange is required.`, [r.ref], true),
        pendingOn: 'ACCEPTANCE_REQUEST',
      };
    }
    if (r.fresh.freshness === 'FRESH') {
      return {
        ...result('HC-ACC-04', name, 'OPERATIONAL_AVAILABILITY', 'PASS', r.response.status === 'ACCEPTED' ? 'ACCEPTED' : 'ACCEPTED_LIMITED',
          `${r.response.status} (${r.response.trustedSource}) at ${r.response.respondedAt}, valid until ${r.response.validUntil}.`, [r.ref], true),
      };
    }
    return {
      ...result('HC-ACC-04', name, 'OPERATIONAL_AVAILABILITY', 'UNKNOWN', 'ACCEPTANCE_EXPIRED',
        `${r.response.status} expired at ${r.fresh.effectiveExpiry}; a new acceptance is required.`, [r.ref], true),
      pendingOn: 'ACCEPTANCE_REQUEST',
    };
  }
  if (r) {
    return {
      ...result('HC-ACC-04', name, 'OPERATIONAL_AVAILABILITY', 'UNKNOWN', 'RESPONSE_NOT_ACCEPTING',
        `Latest response for this case is ${r.response.status}.`, [r.ref], true),
      pendingOn: 'ACCEPTANCE_REQUEST',
    };
  }
  const req = h.acceptance;
  if (req.requestState === 'OUTSTANDING') {
    return {
      ...result('HC-ACC-04', name, 'OPERATIONAL_AVAILABILITY', 'UNKNOWN', 'NO_RESPONSE_YET',
        `Request ${req.request?.requestId} outstanding until ${req.request?.expiresAt}; no response yet.`, [], true),
      pendingOn: 'ACCEPTANCE_RESPONSE',
    };
  }
  if (req.requestState === 'REQUEST_CANCELLED') {
    return {
      ...result('HC-ACC-04', name, 'OPERATIONAL_AVAILABILITY', 'UNKNOWN', 'REQUEST_CANCELLED_NO_RESPONSE',
        `Request ${req.request?.requestId} was cancelled.`, [], true),
      pendingOn: 'ACCEPTANCE_REQUEST',
    };
  }
  if (req.requestState === 'REQUEST_EXPIRED') {
    return {
      ...result('HC-ACC-04', name, 'OPERATIONAL_AVAILABILITY', 'UNKNOWN', 'REQUEST_EXPIRED_NO_RESPONSE',
        `Request ${req.request?.requestId} expired at ${req.request?.expiresAt} without a response.`, [], true),
      pendingOn: 'ACCEPTANCE_REQUEST',
    };
  }
  return {
    ...result('HC-ACC-04', name, 'OPERATIONAL_AVAILABILITY', 'UNKNOWN', 'NO_REQUEST',
      'No acceptance requested for this case yet.', [], true),
    pendingOn: 'ACCEPTANCE_REQUEST',
  };
}

// ------------------------------------------------------------------ HC-GEO-01 / HC-TMP-01

export function ruleLocatable(ctx: RuleContext, h: HospitalInput): ConstraintResult {
  const loc = h.location;
  const ok = !!loc && Number.isFinite(loc.value.latitude) && Number.isFinite(loc.value.longitude) &&
    !(loc.value.latitude === 0 && loc.value.longitude === 0);
  if (!ok) {
    return result('HC-GEO-01', 'locatable', 'TRANSIT_TIME', 'UNKNOWN', 'NO_LOCATION', 'Facility has no usable coordinates.', [], false);
  }
  const fresh = assessFreshness('FACILITY_LOCATION', loc!, ctx.snapshot.evaluatedAt, ctx.policy);
  return result('HC-GEO-01', 'locatable', 'TRANSIT_TIME', 'PASS', 'LOCATED', `Coordinates from ${loc!.value.coordinateSource}.`,
    [ref(ctx, 'location', 'FACILITY_LOCATION', loc!, fresh)], false);
}

export function ruleCareWindow(): ConstraintResult {
  // No defensible, provenance-bearing care window source exists in JIVA yet. Never fabricated.
  return result('HC-TMP-01', 'within_care_window', 'TRANSIT_TIME', 'NOT_APPLICABLE', 'NO_CARE_WINDOW_DEFINED',
    'No clinician-supplied care window; temporal feasibility not evaluated.', [], false);
}
