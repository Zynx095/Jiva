import * as fs from 'fs';
import * as path from 'path';
import type {
  CapabilityType,
  FeasibilitySnapshot,
  HospitalAvailabilityResponse,
  HospitalFinancialProfile,
  HospitalInput,
  HospitalInsuranceProfile,
  OperationalEvidence,
  EtaEvidence,
  UnknownFact,
} from '../../packages/domain-models/src';
import {
  buildDecisionTrace,
  createFreshnessPolicy,
  hashPolicy,
  evaluateFeasibility,
  screenCandidates,
  hashSnapshot,
} from '../../packages/feasibility/src';

// ------------------------------------------------------------------ fixtures

const T0 = '2026-09-27T10:00:00.000Z';
const at = (min: number) => new Date(Date.parse(T0) + min * 60000).toISOString();
const policy = createFreshnessPolicy();
/** A correlated, current request for case CASE: the only kind a positive response may resolve against. */
const CORR = { requestState: 'OUTSTANDING' as const, request: { requestId: 'AR-1', requestedAt: T0_REQ(), expiresAt: T0_EXP() } };
function T0_REQ() { return new Date(Date.parse('2026-09-27T10:00:00.000Z') - 30 * 60000).toISOString(); }
function T0_EXP() { return new Date(Date.parse('2026-09-27T10:00:00.000Z') + 60 * 60000).toISOString(); }
const CASE = 'CASE-1';
const IDS = { decisionId: 'D-1', traceId: 'T-1' };

function op(over: Partial<OperationalEvidence['statuses']> = {}, meta: Partial<OperationalEvidence> = {}): OperationalEvidence {
  return {
    statuses: { emergency: 'UNKNOWN', icu: 'UNKNOWN', trauma: 'UNKNOWN', nicu: 'UNKNOWN', picu: 'UNKNOWN', ventilator: 'UNKNOWN', ...over },
    source: 'capacity-update:test',
    dataStatus: 'HOSPITAL_CONFIRMED',
    observedAt: at(-5),
    ...meta,
  };
}

function hosp(id: string, over: Partial<HospitalInput> = {}): HospitalInput {
  return {
    hospitalId: id,
    displayName: `Hospital ${id}`,
    location: { value: { latitude: 12.97, longitude: 77.59, coordinateSource: 'test' }, source: 'test', sourceType: 'TEST', observedAt: at(-1000), confidence: 1, dataStatus: 'PUBLIC_LISTED' },
    capabilities: { value: { emergency: true, trauma: true, icu: true }, source: 'registry', sourceType: 'GOVERNMENT_REGISTRY', observedAt: at(-60 * 24), confidence: 0.9, dataStatus: 'PUBLIC_LISTED' },
    operational: op(),
    acceptance: { requestState: 'NOT_REQUESTED' },
    ...over,
  };
}

function resp(hospitalId: string, status: HospitalAvailabilityResponse['status'], caps: CapabilityType[], respondedMin: number, validMin: number, caseId = CASE): HospitalAvailabilityResponse {
  return {
    responseId: `R-${hospitalId}-${caseId}-${status}-${respondedMin}`,
    requestId: 'AR-1',
    caseId,
    hospitalId,
    status,
    acceptedCapabilities: caps,
    limitations: status === 'LIMITED' ? ['limited test'] : [],
    respondedAt: at(respondedMin),
    validUntil: at(validMin),
    responderRole: 'CLINICAL_COORDINATOR',
    source: 'HOSPITAL_CONFIRMED',
    trustedSource: 'HOSPITAL_CONFIRMED',
  };
}

const accepted = (id: string, caps: CapabilityType[] = ['EMERGENCY', 'TRAUMA', 'ICU']) =>
  ({ ...CORR, response: resp(id, 'ACCEPTED', caps, -2, 30) });

const eta = (sec: number, dist = sec * 10): EtaEvidence =>
  ({ durationSeconds: sec, distanceMeters: dist, provider: 'mock', synthetic: true, trafficAware: false, calculatedAt: T0 });
const routeFailed: UnknownFact = { status: 'UNKNOWN', reasonCode: 'ROUTE_FAILED', detail: 'provider down' };

function snap(candidates: HospitalInput[], etas: Record<string, EtaEvidence | UnknownFact> = {}, over: Partial<FeasibilitySnapshot> = {}): FeasibilitySnapshot {
  return {
    snapshotId: 'S-1',
    evaluatedAt: T0,
    policyVersion: policy.version,
    policyHash: hashPolicy(policy),
    trigger: { eventId: 'E-1', eventType: 'test', sourceId: 'test' },
    case: {
      caseId: CASE,
      requirement: { requirementId: 'REQ-1', caseId: CASE, requiredCapabilities: ['EMERGENCY', 'TRAUMA', 'ICU'], optionalCapabilities: [], severity: 'CRITICAL', createdAt: at(-10), source: 'test' },
      requirementProvenance: 'RULE_DERIVED',
    },
    candidates,
    transport: { etaByHospital: etas },
    ...over,
  };
}

const run = (s: FeasibilitySnapshot) => evaluateFeasibility(s, policy, IDS);
const cand = (s: FeasibilitySnapshot, id: string) => run(s).decision.candidates.find(c => c.hospitalId === id)!;
const rule = (s: FeasibilitySnapshot, id: string, ruleId: string) => cand(s, id).hardConstraints.find(r => r.ruleId === ruleId)!;

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

// ------------------------------------------------------------------ tests

console.log('[Test] Care Feasibility Engine (pure core)\n');

check('Hard constraint beats ETA: a 5-min hospital lacking trauma cannot outrank a feasible 25-min one', () => {
  const near = hosp('H-NEAR', { capabilities: { ...hosp('x').capabilities, value: { emergency: true, trauma: false, icu: true } }, acceptance: accepted('H-NEAR', ['EMERGENCY', 'ICU']) });
  const far = hosp('H-FAR', { acceptance: accepted('H-FAR') });
  const s = snap([near, far], { 'H-NEAR': eta(300), 'H-FAR': eta(1500) });
  const d = run(s).decision;
  eq(d.selectedHospitalId, 'H-FAR', 'selection');
  eq(cand(s, 'H-NEAR').verdict, 'INELIGIBLE', 'near verdict');
  eq(d.candidates[0].hospitalId, 'H-FAR', 'order');
});

check('Current hospital confirmation of a capability for this case outranks a public listing', () => {
  const h = hosp('H', { capabilities: { ...hosp('x').capabilities, value: { emergency: true, icu: true } }, acceptance: accepted('H') });
  const s = snap([h], { H: eta(60) });
  eq(rule(s, 'H', 'HC-CLIN-01').reasonCode, 'CAPABILITY_CONFIRMED_BY_RESPONSE', 'reason');
  eq(cand(s, 'H').verdict, 'ELIGIBLE', 'verdict');
});

check('D1: route failure is UNKNOWN ETA, sorts after every known ETA, never 0', () => {
  const s = snap([hosp('H-A', { acceptance: accepted('H-A') }), hosp('H-B', { acceptance: accepted('H-B') })],
    { 'H-A': routeFailed, 'H-B': eta(2400) });
  const { decision, evaluated } = run(s);
  eq(decision.selectedHospitalId, 'H-B', 'known ETA chosen over unknown');
  eq(decision.candidates.map(c => c.hospitalId), ['H-B', 'H-A'], 'order');
  const trace = buildDecisionTrace(s, decision, evaluated);
  const tA = trace.candidates.find(c => c.hospitalId === 'H-A')!;
  eq(tA.transit.etaMinutes, null, 'trace ETA is null, not 0');
  eq(tA.transit.etaStatus, 'UNKNOWN', 'trace etaStatus');
  eq(decision.candidates[1].contextualFactors.find(f => f.factorId === 'SF-ETA')!.level, 'UNKNOWN', 'ETA factor level');
});

check('D1: a missing ETA entry is also UNKNOWN (not 0)', () => {
  const s = snap([hosp('H-A', { acceptance: accepted('H-A') }), hosp('H-B', { acceptance: accepted('H-B') })], { 'H-B': eta(3000) });
  eq(run(s).decision.selectedHospitalId, 'H-B', 'selection');
});

check('D2: absent capability is UNKNOWN -> INDETERMINATE; explicit false -> INELIGIBLE', () => {
  const absent = hosp('H-ABS', { capabilities: { ...hosp('x').capabilities, value: { emergency: true, icu: true } } });
  const falsy = hosp('H-FALSE', { capabilities: { ...hosp('x').capabilities, value: { emergency: true, icu: true, trauma: false } } });
  const s = snap([absent, falsy]);
  eq(cand(s, 'H-ABS').verdict, 'INDETERMINATE', 'absent');
  eq(rule(s, 'H-ABS', 'HC-CLIN-01').outcome, 'UNKNOWN', 'absent rule');
  eq(rule(s, 'H-ABS', 'HC-CLIN-01').reasonCode, 'NOT_LISTED', 'absent reason');
  eq(cand(s, 'H-FALSE').verdict, 'INELIGIBLE', 'false');
  eq(rule(s, 'H-FALSE', 'HC-CLIN-01').reasonCode, 'CAPABILITY_NOT_PROVIDED', 'false reason');
});

check('D2: unrecognized capability codes and NOT_DISCLOSED listings are UNKNOWN, not absent', () => {
  const s1 = snap([hosp('H-1')]);
  s1.case.requirement.requiredCapabilities = ['EMERGENCY', 'HYPERBARIC' as CapabilityType];
  eq(rule(s1, 'H-1', 'HC-CLIN-01').reasonCode, 'UNRECOGNIZED_CAPABILITY', 'unrecognized');
  const s2 = snap([hosp('H-2', { capabilities: { ...hosp('x').capabilities, dataStatus: 'NOT_DISCLOSED' } })]);
  eq(cand(s2, 'H-2').verdict, 'INDETERMINATE', 'not disclosed');
});

check('D3: current ICU UNAVAILABLE fails a required-unit rule even with an ACCEPTED response', () => {
  const s = snap([hosp('H-A', { operational: op({ icu: 'UNAVAILABLE' }), acceptance: accepted('H-A') }), hosp('H-B', { acceptance: accepted('H-B') })],
    { 'H-A': eta(100), 'H-B': eta(900) });
  eq(cand(s, 'H-A').verdict, 'INELIGIBLE', 'A verdict');
  eq(rule(s, 'H-A', 'HC-OPS-02').reasonCode, 'OPERATIONAL_UNAVAILABLE', 'A reason');
  eq(run(s).decision.selectedHospitalId, 'H-B', 'selection');
});

check('D3: on reroute, another hospital with the required unit UNAVAILABLE is not selected', () => {
  const s = snap([
    hosp('H-DEST', { acceptance: accepted('H-DEST') }),
    hosp('H-ICU-DOWN', { operational: op({ icu: 'UNAVAILABLE' }), acceptance: accepted('H-ICU-DOWN') }),
    hosp('H-OK', { acceptance: accepted('H-OK') }),
  ], { 'H-DEST': eta(60), 'H-ICU-DOWN': eta(120), 'H-OK': eta(1800) });
  s.case.excludedHospitalIds = ['H-DEST'];
  eq(run(s).decision.selectedHospitalId, 'H-OK', 'reroute selection');
});

check('D3: unit status only matters when that capability is required', () => {
  const s = snap([hosp('H-A', { operational: op({ nicu: 'UNAVAILABLE' }), acceptance: accepted('H-A') })], { 'H-A': eta(60) });
  eq(cand(s, 'H-A').verdict, 'ELIGIBLE', 'NICU not required');
});

check('D4/A2: LIMITED missing a required capability is INELIGIBLE; covering LIMITED is ELIGIBLE but ranks after ACCEPTED', () => {
  const limitedMissing = hosp('H-LM', { acceptance: { ...CORR, response: resp('H-LM', 'LIMITED', ['EMERGENCY', 'TRAUMA'], -1, 30) } });
  const limitedOk = hosp('H-LO', { acceptance: { ...CORR, response: resp('H-LO', 'LIMITED', ['EMERGENCY', 'TRAUMA', 'ICU'], -1, 30) } });
  const acc = hosp('H-ACC', { acceptance: accepted('H-ACC') });
  const s = snap([limitedMissing, limitedOk, acc], { 'H-LM': eta(60), 'H-LO': eta(120), 'H-ACC': eta(1200) });
  eq(cand(s, 'H-LM').verdict, 'INELIGIBLE', 'limited missing');
  eq(rule(s, 'H-LM', 'HC-ACC-03').reasonCode, 'LIMITED_MISSING_CAPABILITY', 'limited missing reason');
  eq(cand(s, 'H-LO').verdict, 'ELIGIBLE', 'limited ok');
  eq(run(s).decision.selectedHospitalId, 'H-ACC', 'ACCEPTED preferred over LIMITED regardless of ETA');
});

check('D5: an acceptance for another case never counts for this case', () => {
  const other = hosp('H-A', { acceptance: { requestState: 'NOT_REQUESTED', response: resp('H-A', 'ACCEPTED', ['EMERGENCY', 'TRAUMA', 'ICU'], -1, 30, 'CASE-OTHER') } });
  const s = snap([other], { 'H-A': eta(60) });
  eq(cand(s, 'H-A').verdict, 'PENDING_ACCEPTANCE', 'other case acceptance ignored');
});

check('D5: a REJECTED for another case has no effect on this case', () => {
  const s = snap([hosp('H-A', { acceptance: { ...CORR, response: resp('H-A', 'REJECTED', [], -1, 30, 'CASE-OTHER') } })]);
  eq(cand(s, 'H-A').verdict, 'PENDING_ACCEPTANCE', 'verdict');
});

check('D6/A3: fresh UNAVAILABLE -> FAIL, expired UNAVAILABLE -> UNKNOWN, fresh AVAILABLE -> PASS, expired AVAILABLE -> UNKNOWN', () => {
  const cases: [string, OperationalEvidence, string][] = [
    ['fresh UNAVAILABLE', op({ emergency: 'UNAVAILABLE' }, { observedAt: at(-5) }), 'FAIL'],
    ['expired UNAVAILABLE', op({ emergency: 'UNAVAILABLE' }, { observedAt: at(-31) }), 'UNKNOWN'],
    ['fresh AVAILABLE', op({ emergency: 'AVAILABLE' }, { observedAt: at(-5) }), 'PASS'],
    ['expired AVAILABLE', op({ emergency: 'AVAILABLE' }, { observedAt: at(-31) }), 'UNKNOWN'],
    ['untimed AVAILABLE', op({ emergency: 'AVAILABLE' }, { observedAt: undefined }), 'UNKNOWN'],
  ];
  for (const [label, evidence, expected] of cases) {
    const s = snap([hosp('H', { operational: evidence })]);
    eq(rule(s, 'H', 'HC-OPS-01').outcome, expected, label);
  }
});

check('D6/A3: expired evidence never yields ELIGIBLE and never INELIGIBLE on its own', () => {
  const expiredUnavailable = snap([hosp('H', { operational: op({ emergency: 'UNAVAILABLE', icu: 'UNAVAILABLE' }, { observedAt: at(-120) }) })]);
  eq(cand(expiredUnavailable, 'H').verdict, 'PENDING_ACCEPTANCE', 'expired unavailable -> awaits confirmation');
  const expiredAvailable = snap([hosp('H', { operational: op({ emergency: 'AVAILABLE', icu: 'AVAILABLE' }, { observedAt: at(-120) }) })]);
  eq(cand(expiredAvailable, 'H').verdict, 'PENDING_ACCEPTANCE', 'expired available -> not eligible');
});

check('A4: explicit validUntil takes precedence over the policy default (both directions)', () => {
  const longValid = snap([hosp('H', { operational: op({ emergency: 'UNAVAILABLE' }, { observedAt: at(-45), validUntil: at(60) }) })]);
  eq(rule(longValid, 'H', 'HC-OPS-01').outcome, 'FAIL', 'validUntil extends beyond 30-min default');
  const shortValid = snap([hosp('H', { operational: op({ emergency: 'UNAVAILABLE' }, { observedAt: at(-5), validUntil: at(-1) }) })]);
  eq(rule(shortValid, 'H', 'HC-OPS-01').outcome, 'UNKNOWN', 'validUntil shorter than default');
});

check('A4: freshness durations are configurable policy values', () => {
  const strict = createFreshnessPolicy({ OPERATIONAL_CAPACITY: { maxAgeSeconds: 60 } });
  const s = { ...snap([hosp('H', { operational: op({ emergency: 'UNAVAILABLE' }, { observedAt: at(-5) }) })]), policyVersion: strict.version, policyHash: hashPolicy(strict) };
  const r = evaluateFeasibility(s, strict, IDS).decision.candidates[0].hardConstraints.find(c => c.ruleId === 'HC-OPS-01')!;
  eq(r.outcome, 'UNKNOWN', '5-min-old evidence stale under a 60 s policy');
  if (!policy.label.toLowerCase().includes('prototype')) throw new Error('Policy must be labeled as prototype defaults');
});

check('Operational evidence below operational grade (PUBLIC_LISTED/HISTORICAL/UNVERIFIED) can never PASS or FAIL', () => {
  for (const ds of ['PUBLIC_LISTED', 'HISTORICAL', 'UNVERIFIED'] as const) {
    for (const status of ['AVAILABLE', 'UNAVAILABLE'] as const) {
      const s = snap([hosp('H', { operational: op({ emergency: status, icu: status }, { dataStatus: ds }) })]);
      eq(rule(s, 'H', 'HC-OPS-01').reasonCode, 'EVIDENCE_NOT_OPERATIONAL_GRADE', `${ds}/${status}`);
    }
  }
});

check('Hospital-wide UNAVAILABLE: fresh -> INELIGIBLE for every case; expired -> UNKNOWN (awaits acceptance)', () => {
  const wide = resp('H', 'UNAVAILABLE', [], -5, 25, 'CASE-OTHER');
  const s1 = snap([hosp('H', { acceptance: { requestState: 'NOT_REQUESTED', hospitalWideUnavailable: wide } })]);
  eq(cand(s1, 'H').verdict, 'INELIGIBLE', 'fresh');
  const expired = resp('H', 'UNAVAILABLE', [], -40, -10, 'CASE-OTHER');
  const s2 = snap([hosp('H', { acceptance: { requestState: 'NOT_REQUESTED', hospitalWideUnavailable: expired } })]);
  eq(cand(s2, 'H').verdict, 'PENDING_ACCEPTANCE', 'expired');
  eq(rule(s2, 'H', 'HC-ACC-02').reasonCode, 'UNAVAILABLE_EXPIRED', 'expired reason');
});

check('Acceptance table: NO_REQUEST / OUTSTANDING / REQUEST_EXPIRED / ACCEPTED / REJECTED', () => {
  const rows: [HospitalInput['acceptance'], string, string, string | undefined][] = [
    [{ requestState: 'NOT_REQUESTED' }, 'PENDING_ACCEPTANCE', 'NO_REQUEST', 'ACCEPTANCE_REQUEST'],
    [{ requestState: 'OUTSTANDING', request: { requestId: 'AR', requestedAt: at(-1), expiresAt: at(14) } }, 'PENDING_ACCEPTANCE', 'NO_RESPONSE_YET', 'ACCEPTANCE_RESPONSE'],
    [{ requestState: 'REQUEST_EXPIRED', request: { requestId: 'AR', requestedAt: at(-20), expiresAt: at(-5) } }, 'PENDING_ACCEPTANCE', 'REQUEST_EXPIRED_NO_RESPONSE', 'ACCEPTANCE_REQUEST'],
    [accepted('H'), 'ELIGIBLE', 'ACCEPTED', undefined],
    [{ ...CORR, response: resp('H', 'REJECTED', [], -1, 30) }, 'INELIGIBLE', 'REJECTED', undefined],
  ];
  for (const [acceptance, verdict, reason, pendingOn] of rows) {
    const s = snap([hosp('H', { acceptance })], { H: eta(60) });
    const c = cand(s, 'H');
    eq(c.verdict, verdict, `verdict for ${reason}`);
    if (!c.blockingReasons.includes(reason as never) && verdict !== 'ELIGIBLE') throw new Error(`blocking reason ${reason} missing: ${c.blockingReasons}`);
    if (verdict === 'ELIGIBLE') eq(rule(s, 'H', 'HC-ACC-04').reasonCode, 'ACCEPTED', 'accepted reason');
    eq(c.pendingOn, pendingOn, `pendingOn for ${reason}`);
  }
});

check('Acceptance expiry boundary: evaluatedAt === validUntil is expired; 1 ms before is valid', () => {
  const r = resp('H', 'ACCEPTED', ['EMERGENCY', 'TRAUMA', 'ICU'], -10, 0);
  const atBoundary = snap([hosp('H', { acceptance: { ...CORR, response: r } })], { H: eta(60) });
  eq(cand(atBoundary, 'H').verdict, 'PENDING_ACCEPTANCE', 'at boundary');
  eq(rule(atBoundary, 'H', 'HC-ACC-04').reasonCode, 'ACCEPTANCE_EXPIRED', 'expired reason');
  const before = snap([hosp('H', { acceptance: { ...CORR, response: r } })], { H: eta(60) },
    { evaluatedAt: new Date(Date.parse(T0) - 1).toISOString() });
  eq(cand(before, 'H').verdict, 'ELIGIBLE', '1 ms before');
});

check('Routing separation: the transport screen (mapping input) excludes every INELIGIBLE candidate', () => {
  const s = snap([
    hosp('H-OK'),
    hosp('H-INDET', { capabilities: { ...hosp('x').capabilities, value: { emergency: true } } }),
    hosp('H-NO', { capabilities: { ...hosp('x').capabilities, value: { emergency: true, trauma: false, icu: true } } }),
  ]);
  const screened = screenCandidates(s, policy);
  eq(screened.map(x => `${x.hospitalId}:${x.verdict}`), ['H-INDET:INDETERMINATE', 'H-OK:PENDING_ACCEPTANCE'], 'screen');
});

check('Verdict semantics: UNKNOWN != ELIGIBLE and UNKNOWN != INELIGIBLE', () => {
  const s = snap([hosp('H-OPUNK'), hosp('H-CAPUNK', { capabilities: { ...hosp('x').capabilities, value: { emergency: true, icu: true } } })]);
  eq(cand(s, 'H-OPUNK').verdict, 'PENDING_ACCEPTANCE', 'operational unknown awaits acceptance');
  eq(cand(s, 'H-CAPUNK').verdict, 'INDETERMINATE', 'capability unknown is indeterminate');
  eq(run(s).decision.outcome, 'AWAITING_ACCEPTANCE', 'no selection without acceptance');
});

check('Historical bed counts are never used by any rule', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../packages/feasibility/src/rules.ts'), 'utf8');
  if (/historical|totalBeds|icuBeds/i.test(src.replace(/HISTORICAL/g, ''))) throw new Error('rules reference historical capacity');
});

check('Determinism: shuffled candidate order -> identical ordering, snapshot hash and audit hash', () => {
  const base = [
    hosp('H-1', { acceptance: accepted('H-1') }), hosp('H-2', { acceptance: accepted('H-2') }),
    hosp('H-3'), hosp('H-4', { operational: op({ icu: 'UNAVAILABLE' }) }), hosp('H-5', { acceptance: accepted('H-5') }),
  ];
  const etas = { 'H-1': eta(600), 'H-2': eta(600, 5000), 'H-3': eta(100), 'H-5': routeFailed };
  const ref = run(snap(base, etas));
  const refTrace = buildDecisionTrace(snap(base, etas), ref.decision, ref.evaluated);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 25; i++) {
    const shuffled = [...base].sort(() => rand() - 0.5);
    const s = snap(shuffled, etas);
    const r = run(s);
    eq(r.decision.candidates.map(c => c.hospitalId), ref.decision.candidates.map(c => c.hospitalId), 'order');
    eq(r.decision.snapshotHash, ref.decision.snapshotHash, 'snapshot hash');
    eq(buildDecisionTrace(s, r.decision, r.evaluated).auditHash, refTrace.auditHash, 'audit hash');
  }
  eq(ref.decision.candidates.slice(0, 2).map(c => c.hospitalId), ['H-2', 'H-1'], 'equal ETA broken by distance');
});

check('Engine never reads the wall clock', () => {
  const realNow = Date.now;
  Date.now = () => { throw new Error('wall clock read'); };
  try {
    const s = snap([hosp('H', { acceptance: accepted('H') })], { H: eta(60) });
    const r = run(s);
    buildDecisionTrace(s, r.decision, r.evaluated);
  } finally {
    Date.now = realNow;
  }
});

check('No composite score anywhere in decisions or traces', () => {
  const s = snap([hosp('H', { acceptance: accepted('H') }), hosp('H2')], { H: eta(60), H2: eta(90) });
  const r = run(s);
  const json = JSON.stringify([r.decision, buildDecisionTrace(s, r.decision, r.evaluated)]);
  for (const k of ['overallScore', 'matchPercentage', '"score"', 'weight']) {
    if (json.includes(k)) throw new Error(`found forbidden key ${k}`);
  }
});

check('Financial/insurance: no evidence -> UNKNOWN; never change a verdict or the order', () => {
  const s = snap([hosp('H', { acceptance: accepted('H') })], { H: eta(60) });
  const c = cand(s, 'H');
  eq(c.contextualFactors.find(f => f.factorId === 'SF-FIN-EXPOSURE')!.reasonCode, 'NO_FINANCIAL_EVIDENCE', 'fin');
  eq(c.contextualFactors.find(f => f.factorId === 'SF-INS-COMPAT')!.value!.compatibility, 'UNKNOWN', 'ins');
  for (const f of c.contextualFactors.filter(x => x.factorId.startsWith('SF-FIN') || x.factorId.startsWith('SF-INS'))) {
    if (f.affectsOrdering) throw new Error('financial/insurance must not affect ordering');
  }
});

check('Financial: estimate is a range, never a point value; exposure risk needs a budget', () => {
  const ev = <T>(value: T) => ({ value, source: 'tariff', sourceType: 'HOSPITAL_WEBSITE', observedAt: at(-60 * 24 * 10), confidence: 0.7, dataStatus: 'PUBLIC_LISTED' as const });
  const fp: HospitalFinancialProfile = {
    hospitalId: 'H',
    pricingCategory: ev('PREMIUM_PRIVATE'),
    depositPolicy: { depositRequired: ev(true), statutoryWaiverApplies: ev(true), acceptedPaymentMethods: ev(['UPI']) },
    standardEmergencyProcedures: [{ procedureCode: 'POLYTRAUMA_STAB', procedureName: 'Polytrauma stabilization', estimatedCost: ev({ minInr: 150000, maxInr: 400000, medianInr: 250000 }) }],
    priceTransparencyStatus: ev('PUBLIC_LISTED'),
    statutoryComplianceEmergencyStabilization: ev(true),
  };
  const s = snap([hosp('H', { acceptance: accepted('H'), financialProfile: fp })], { H: eta(60) });
  s.case.procedureCode = 'POLYTRAUMA_STAB';
  s.case.financialContext = { patientId: 'P', selfReportedBudgetConstraintInr: 100000 };
  const f = cand(s, 'H').contextualFactors.find(x => x.factorId === 'SF-FIN-EXPOSURE')!;
  eq(f.level, 'ESTIMATED', 'level');
  eq([f.value!.estimatedMinInr, f.value!.estimatedMaxInr], [150000, 400000], 'range');
  if (JSON.stringify(f).includes('250000')) throw new Error('median leaked as a point value');
  eq(f.value!.exposureRisk, 'HIGH', 'exposure vs budget');
  eq(cand(s, 'H').verdict, 'ELIGIBLE', 'financial never blocks emergency care');
});

check('Insurance: empanelment without a known patient policy is UNKNOWN, not coverage', () => {
  const ev = <T>(value: T) => ({ value, source: 'pmjay', sourceType: 'GOVERNMENT_REGISTRY', observedAt: at(-60 * 24), confidence: 0.9, dataStatus: 'PUBLIC_LISTED' as const });
  const ip: HospitalInsuranceProfile = {
    hospitalId: 'H',
    governmentSchemes: [{ schemeId: 'PMJAY', schemeName: 'PM-JAY', isEmpanelled: ev(true), empanelledSpecialties: ev(['TRAUMA']), preauthMode: ev('EMERGENCY_PROVISIONAL') }],
    tpaNetworks: [],
    emergencyCashlessDeskAvailable: ev(true),
    dataStatus: 'PUBLIC_LISTED',
  };
  const s = snap([hosp('H', { insuranceProfile: ip })]);
  eq(cand(s, 'H').contextualFactors.find(f => f.factorId === 'SF-INS-COMPAT')!.value!.compatibility, 'UNKNOWN', 'no patient policy');
  s.case.insuranceProfile = { patientId: 'P', payerType: 'GOVERNMENT_SCHEME', schemeId: 'PMJAY', cashlessFeasibility: 'UNKNOWN' };
  eq(cand(s, 'H').contextualFactors.find(f => f.factorId === 'SF-INS-COMPAT')!.value!.compatibility, 'UNKNOWN', 'specialty coverage unknown');
});

check('Care window is NOT_APPLICABLE (never fabricated)', () => {
  eq(rule(snap([hosp('H')]), 'H', 'HC-TMP-01').outcome, 'NOT_APPLICABLE', 'care window');
});

check('Trace references the snapshot and records every rule for every candidate', () => {
  const s = snap([hosp('H', { acceptance: accepted('H') }), hosp('H-X', { capabilities: { ...hosp('x').capabilities, value: { emergency: true, trauma: false, icu: true } } })], { H: eta(60) });
  const r = run(s);
  const t = buildDecisionTrace(s, r.decision, r.evaluated);
  eq(t.snapshotHash, hashSnapshot(s), 'snapshot hash');
  eq(t.candidates.length, 2, 'all candidates traced');
  for (const c of t.candidates) {
    eq(c.ruleEvaluations.length, 9, `rule count ${c.hospitalId}`);
    for (const re of c.ruleEvaluations) if (re.passed !== (re.outcome === 'PASS')) throw new Error('passed must be derived from outcome');
  }
  const x = t.candidates.find(c => c.hospitalId === 'H-X')!;
  if (!x.disqualificationReason?.includes('HC-CLIN-01')) throw new Error('blocking rule not named');
  const refs = t.candidates[0].ruleEvaluations.flatMap(re => re.evidenceRefs || []);
  if (!refs.length || refs.some(rf => rf.snapshotId !== 'S-1')) throw new Error('evidence refs must point to the snapshot');
});

check('Import graph: engine has no dependency on mapping, AI, or I/O', () => {
  const dir = path.join(__dirname, '../../packages/feasibility/src');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    if (/@jiva\/(mapping|intelligence|event-schema)|from '(fs|http|https|node:fs)'|fetch\(|Date\.now\(|new Date\(\)/.test(src)) {
      throw new Error(`${f} violates engine purity`);
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, '../package.json'), 'utf8'));
  eq(Object.keys(pkg.dependencies), ['@jiva/domain-models'], 'dependencies');
});

console.log(`\n[Test] Care Feasibility Engine: ${passed} checks passed.`);
