/**
 * Policy 1 (Static Capability Evidence) — Option B, approved.
 *
 * PUBLIC_LISTED / HOSPITAL_CONFIRMED / AUTHORIZED_FEED may produce a positive capability PASS from
 * a static listing alone. HISTORICAL / UNVERIFIED may still support an explicit negative (FAIL),
 * but a positive listing alone is not strong enough evidence for PASS — it resolves to UNKNOWN
 * unless a current, usable acceptance response independently confirms the capability
 * (CAPABILITY_CONFIRMED_BY_RESPONSE, unchanged). UNKNOWN / NOT_DISCLOSED remain UNKNOWN.
 * SYNTHETIC_DEMO behavior (DEMO vs PRODUCTION) is unchanged.
 */
import type {
  CapabilityType,
  DataStatus,
  FeasibilitySnapshot,
  HospitalAvailabilityResponse,
  HospitalInput,
} from '../../packages/domain-models/src';
import { createFreshnessPolicy, evaluateFeasibility, hashPolicy } from '../../packages/feasibility/src';

const T0 = '2026-09-27T10:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60000).toISOString();
const CASE = 'CASE-POLICY1';
const IDS = { decisionId: 'D-1', traceId: 'T-1' };

function hosp(id: string, dataStatus: DataStatus, listedIcu: boolean | undefined, over: Partial<HospitalInput> = {}): HospitalInput {
  return {
    hospitalId: id,
    displayName: `Hospital ${id}`,
    location: { value: { latitude: 12.97, longitude: 77.59, coordinateSource: 'test' }, source: 'test', sourceType: 'TEST', observedAt: at(-1000), confidence: 1, dataStatus: 'PUBLIC_LISTED' },
    capabilities: { value: listedIcu === undefined ? {} : { icu: listedIcu }, source: 'registry', sourceType: 'GOVERNMENT_REGISTRY', observedAt: at(-60 * 24), confidence: 0.9, dataStatus },
    operational: { statuses: { emergency: 'UNKNOWN', icu: 'UNKNOWN', trauma: 'UNKNOWN', nicu: 'UNKNOWN', picu: 'UNKNOWN', ventilator: 'UNKNOWN' }, source: 'seed', dataStatus: 'UNKNOWN', observedAt: undefined },
    acceptance: { requestState: 'NOT_REQUESTED' },
    ...over,
  };
}

function resp(hospitalId: string, caps: CapabilityType[], o: { respondedMin?: number; validMin?: number; requestId?: string; trustedSource?: string; caseId?: string } = {}): HospitalAvailabilityResponse {
  return {
    responseId: `R-${hospitalId}-${o.respondedMin ?? -2}`,
    requestId: o.requestId ?? 'AR-1',
    caseId: o.caseId ?? CASE, hospitalId, status: 'ACCEPTED',
    acceptedCapabilities: caps, limitations: [],
    respondedAt: at(o.respondedMin ?? -2), validUntil: at(o.validMin ?? 30),
    responderRole: 'CLINICAL_COORDINATOR', source: 'HOSPITAL_CONFIRMED',
    trustedSource: (o.trustedSource ?? 'HOSPITAL_CONFIRMED') as HospitalAvailabilityResponse['trustedSource'],
  };
}

const validAcceptance = (id: string, caps: CapabilityType[] = ['ICU'], caseId = CASE) => ({
  requestState: 'OUTSTANDING' as const,
  request: { requestId: 'AR-1', requestedAt: at(-30), expiresAt: at(60) },
  response: resp(id, caps, { caseId }),
});

function snap(candidates: HospitalInput[], policy: ReturnType<typeof createFreshnessPolicy>): FeasibilitySnapshot {
  return {
    snapshotId: 'S-1', evaluatedAt: T0, policyVersion: policy.version, policyHash: hashPolicy(policy),
    trigger: { eventId: 'E-1', eventType: 'test', sourceId: 'test' },
    case: {
      caseId: CASE,
      requirement: { requirementId: 'REQ-1', caseId: CASE, requiredCapabilities: ['ICU'], optionalCapabilities: [], severity: 'CRITICAL', createdAt: at(-10), source: 'test' },
      requirementProvenance: 'RULE_DERIVED',
    },
    candidates,
    transport: { etaByHospital: {} },
  };
}

function evalOne(id: string, dataStatus: DataStatus, listedIcu: boolean | undefined, env: 'DEMO' | 'PRODUCTION' = 'DEMO', over: Partial<HospitalInput> = {}) {
  const policy = createFreshnessPolicy({}, undefined, { environment: env });
  const h = hosp(id, dataStatus, listedIcu, over);
  const s = snap([h], policy);
  const d = evaluateFeasibility(s, policy, IDS).decision;
  const c = d.candidates.find(x => x.hospitalId === id)!;
  const capRule = c.hardConstraints.find(r => r.ruleId === 'HC-CLIN-01')!;
  return { verdict: c.verdict, capOutcome: capRule.outcome, capReason: capRule.reasonCode };
}

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
function eq<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log('[Test] Policy 1 — static capability evidence (Option B)\n');

check('1. PUBLIC_LISTED + listed=true -> PASS', () => {
  const r = evalOne('H1', 'PUBLIC_LISTED', true);
  eq(r.capOutcome, 'PASS', 'capability outcome');
  eq(r.capReason, 'CAPABILITY_LISTED', 'reason');
});

check('2. HOSPITAL_CONFIRMED + listed=true -> PASS', () => {
  const r = evalOne('H2', 'HOSPITAL_CONFIRMED', true);
  eq(r.capOutcome, 'PASS', 'capability outcome');
  eq(r.capReason, 'CAPABILITY_LISTED', 'reason');
});

check('3. AUTHORIZED_FEED + listed=true -> PASS', () => {
  const r = evalOne('H3', 'AUTHORIZED_FEED', true);
  eq(r.capOutcome, 'PASS', 'capability outcome');
  eq(r.capReason, 'CAPABILITY_LISTED', 'reason');
});

check('4. HISTORICAL + listed=true -> UNKNOWN (never PASS from listing alone)', () => {
  const r = evalOne('H4', 'HISTORICAL', true);
  eq(r.capOutcome, 'UNKNOWN', 'capability outcome');
  eq(r.capReason, 'EVIDENCE_NOT_OPERATIONAL_GRADE', 'reason');
  eq(r.verdict, 'INDETERMINATE', 'verdict never reaches eligible from this alone');
});

check('5. UNVERIFIED + listed=true -> UNKNOWN (never PASS from listing alone)', () => {
  const r = evalOne('H5', 'UNVERIFIED', true);
  eq(r.capOutcome, 'UNKNOWN', 'capability outcome');
  eq(r.capReason, 'EVIDENCE_NOT_OPERATIONAL_GRADE', 'reason');
  eq(r.verdict, 'INDETERMINATE', 'verdict never reaches eligible from this alone');
});

check('6. UNKNOWN dataStatus -> UNKNOWN', () => {
  const r = evalOne('H6', 'UNKNOWN', undefined);
  eq(r.capOutcome, 'UNKNOWN', 'capability outcome');
});

check('7. NOT_DISCLOSED dataStatus -> UNKNOWN', () => {
  const r = evalOne('H7', 'NOT_DISCLOSED', undefined);
  eq(r.capOutcome, 'UNKNOWN', 'capability outcome');
});

check('8. SYNTHETIC_DEMO in DEMO env -> PASS (unchanged)', () => {
  const r = evalOne('H8', 'SYNTHETIC_DEMO', true, 'DEMO');
  eq(r.capOutcome, 'PASS', 'capability outcome');
});

check('9. SYNTHETIC_DEMO in PRODUCTION env -> UNKNOWN (unchanged)', () => {
  const r = evalOne('H9', 'SYNTHETIC_DEMO', true, 'PRODUCTION');
  eq(r.capOutcome, 'UNKNOWN', 'capability outcome');
  eq(r.capReason, 'EVIDENCE_NOT_OPERATIONAL_GRADE', 'reason');
});

check('10. Explicit listed=false -> FAIL, at every evidence grade (unchanged)', () => {
  for (const ds of ['PUBLIC_LISTED', 'HOSPITAL_CONFIRMED', 'AUTHORIZED_FEED', 'HISTORICAL', 'UNVERIFIED'] as DataStatus[]) {
    const r = evalOne(`H10-${ds}`, ds, false);
    eq(r.capOutcome, 'FAIL', `capability outcome for ${ds}`);
    eq(r.capReason, 'CAPABILITY_NOT_PROVIDED', `reason for ${ds}`);
    eq(r.verdict, 'INELIGIBLE', `verdict for ${ds}`);
  }
});

check('11. UNVERIFIED/HISTORICAL + valid acceptance confirming capability -> PASS', () => {
  for (const ds of ['UNVERIFIED', 'HISTORICAL'] as DataStatus[]) {
    const r = evalOne(`H11-${ds}`, ds, undefined, 'DEMO', { acceptance: validAcceptance(`H11-${ds}`) });
    eq(r.capOutcome, 'PASS', `capability outcome for ${ds}`);
    eq(r.capReason, 'CAPABILITY_CONFIRMED_BY_RESPONSE', `reason for ${ds}`);
  }
});

check('12. PUBLIC_LISTED + valid acceptance confirming capability -> unchanged (PASS either way)', () => {
  const r = evalOne('H12', 'PUBLIC_LISTED', true, 'DEMO', { acceptance: validAcceptance('H12') });
  eq(r.capOutcome, 'PASS', 'capability outcome');
  ok(r.capReason === 'CAPABILITY_LISTED' || r.capReason === 'CAPABILITY_CONFIRMED_BY_RESPONSE', 'either listing or confirmation reason is acceptable, both PASS');
});

check('13. Stale/invalid acceptance cannot resolve capability (falls back to listing-grade result)', () => {
  // requestId mismatch -> RESPONSE_REQUEST_SUPERSEDED -> currentAccepting() returns undefined ->
  // no confirmation, so HISTORICAL still resolves via the listing-grade path, not via acceptance.
  const mismatched = {
    requestState: 'OUTSTANDING' as const,
    request: { requestId: 'AR-CURRENT', requestedAt: at(-30), expiresAt: at(60) },
    response: resp('H13', ['ICU'], { requestId: 'AR-STALE' }),
  };
  const r = evalOne('H13', 'HISTORICAL', true, 'DEMO', { acceptance: mismatched });
  eq(r.capOutcome, 'UNKNOWN', 'capability outcome: stale/uncorrelated response cannot confirm');
  eq(r.capReason, 'EVIDENCE_NOT_OPERATIONAL_GRADE', 'falls back to the listing-grade UNKNOWN, not a PASS');
});

check('14. Two simultaneous cases remain isolated (no cross-case leakage from the grade change)', () => {
  const policy = createFreshnessPolicy({}, undefined, { environment: 'DEMO' });
  const hHist = hosp('H14', 'HISTORICAL', true);
  const s1 = snap([hHist], policy);
  const s2: FeasibilitySnapshot = {
    ...s1,
    case: { ...s1.case, caseId: 'CASE-OTHER', requirement: { ...s1.case.requirement, caseId: 'CASE-OTHER' } },
    candidates: [{ ...hHist, acceptance: validAcceptance('H14', ['ICU'], 'CASE-OTHER') }], // this case's own confirmed acceptance
  };
  const d1 = evaluateFeasibility(s1, policy, IDS).decision;
  const d2 = evaluateFeasibility(s2, policy, { decisionId: 'D-2', traceId: 'T-2' }).decision;
  const c1 = d1.candidates.find(c => c.hospitalId === 'H14')!.hardConstraints.find(r => r.ruleId === 'HC-CLIN-01')!;
  const c2 = d2.candidates.find(c => c.hospitalId === 'H14')!.hardConstraints.find(r => r.ruleId === 'HC-CLIN-01')!;
  eq(c1.outcome, 'UNKNOWN', 'case without its own acceptance stays UNKNOWN (unaffected by the other case)');
  eq(c2.outcome, 'PASS', 'the case with its own confirmed acceptance resolves independently');
});

console.log(`\n[Test] Policy 1 capability evidence: ${passed} assertions passed.`);
