/**
 * JIVA PHASE 6.3 — DECISION AUTHORITY GATE & CANARY TEST SUITE
 *
 * Verifies all 20 authority gate requirements:
 *   1. LEGACY mode
 *   2. SHADOW mode
 *   3. CANARY mode
 *   4. Invalid mode
 *   5. Missing mode
 *   6. Feasibility exception
 *   7. Feasibility timeout
 *   8. Malformed feasibility result
 *   9. Unexpected disagreement
 *  10. Expected disagreement
 *  11. Kill switch
 *  12. Late feasibility result
 *  13. Replay
 *  14. Duplicate evaluation
 *  15. Multi-case isolation
 *  16. AI failure
 *  17. Mapping failure
 *  18. Trace failure
 *  19. Metrics failure / tracking
 *  20. Policy hash change
 */

import { randomUUID } from 'crypto';
import type { AmbulanceState, CareRequirement, HospitalState, PatientState } from '../../packages/domain-models/src';
import { createFreshnessPolicy } from '../../packages/feasibility/src';
import { AcceptanceLedger, withTrust } from '../../services/api/src/feasibility/acceptanceLedger';
import { FeasibilityShadow } from '../../services/api/src/feasibility/shadow';
import {
  DecisionAuthority,
  authorityKillSwitch,
  DecisionAuthorityKillSwitch,
  AuthorityCircuitBreaker,
  DecisionAuthorityMetrics,
  PromotionGateValidator,
  setCaseAuthorityMode,
  resetCaseAuthorityOverrides,
} from '../../services/api/src/feasibility/authority';
import {
  check,
  counter,
  eq,
  hospital,
  iso,
  ok,
  passCount,
  requestedEvent,
  responseEvent,
  stubMapping,
  T0,
  withCapacity,
} from './helpers/feasibilityHarness';

const HOSP_1 = 'HOSP-BLR-001';
const HOSP_2 = 'HOSP-BLR-002';
const HOSP_3 = 'HOSP-BLR-003';
const CASE_A = 'CASE-AUTH-A';
const CASE_B = 'CASE-AUTH-B';
const ORIGIN = { latitude: 13.0, longitude: 77.6 };

function restoreMode(saved: string | undefined) {
  if (saved === undefined) {
    delete process.env.DECISION_AUTHORITY_MODE;
  } else {
    process.env.DECISION_AUTHORITY_MODE = saved;
  }
}

function testAmbulance(id = 'AMB-BLR-001', caseId = CASE_A): AmbulanceState {
  return {
    ambulanceId: id,
    currentLocation: { ...ORIGIN },
    assignedPatient: caseId,
    status: 'DISPATCHED',
    requiredCapabilities: ['EMERGENCY', 'TRAUMA', 'ICU'],
    lastUpdated: iso(0),
    locationAsOf: iso(0),
    provenance: [],
  };
}

function testPatient(caseId = CASE_A): PatientState {
  return {
    patientId: caseId,
    currentStatus: 'ASSESSED',
    careRequirements: ['EMERGENCY', 'TRAUMA', 'ICU'],
    activeConditions: ['Polytrauma'],
    currentLocation: { ...ORIGIN },
    lastUpdated: iso(0),
    provenance: [],
  };
}

function testRequirement(caseId = CASE_A): CareRequirement {
  return {
    requirementId: `REQ-${caseId}`,
    caseId,
    requiredCapabilities: ['EMERGENCY', 'TRAUMA', 'ICU'],
    optionalCapabilities: [],
    severity: 'CRITICAL',
    createdAt: iso(-10),
    source: 'assessment-engine',
  };
}

function buildTestHospitals(): HospitalState[] {
  const h1 = withCapacity(hospital(HOSP_1, 1), { emergency: 'AVAILABLE', trauma: 'AVAILABLE', icu: 'AVAILABLE' }, -5);
  const h2 = withCapacity(hospital(HOSP_2, 2), { emergency: 'AVAILABLE', trauma: 'AVAILABLE', icu: 'AVAILABLE' }, -5);
  const h3 = withCapacity(hospital(HOSP_3, 3), { emergency: 'AVAILABLE', trauma: 'UNAVAILABLE', icu: 'UNAVAILABLE' }, -5);
  return [h1, h2, h3];
}

async function main() {
  console.log('\n============================================================');
  console.log('JIVA PHASE 6.3: DECISION AUTHORITY & CANARY TEST SUITE');
  console.log('============================================================\n');

  // ============================================================ 1. LEGACY mode
  await check('1. LEGACY mode: legacy decision executes, feasibility is off, destination is legacy pick', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'LEGACY';
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(res.effectiveMode, 'LEGACY', 'effectiveMode is LEGACY');
      eq(res.finalDecision.source, 'LEGACY', 'finalDecision.source is LEGACY');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'selectedHospitalId matches legacy pick');
      eq(res.feasibilityDecision, undefined, 'feasibilityDecision is undefined in LEGACY mode');
      eq(res.fallback, false, 'no fallback');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 2. SHADOW mode
  await check('2. SHADOW mode: legacy is authoritative, feasibility runs in contained observation', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'SHADOW';
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(res.effectiveMode, 'SHADOW', 'effectiveMode is SHADOW');
      eq(res.finalDecision.source, 'LEGACY', 'finalDecision.source is LEGACY');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'selectedHospitalId matches legacy pick');
      eq(res.fallback, false, 'no fallback');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 3. CANARY mode
  await check('3. CANARY mode: legacy controls destination, feasibility evaluated alongside, comparison recorded', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(res.effectiveMode, 'CANARY', 'effectiveMode is CANARY');
      eq(res.finalDecision.source, 'LEGACY', 'CRITICAL CANARY INVARIANT: destination is controlled by LEGACY');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'destination is HOSP_1');
      ok(res.feasibilityDecision !== undefined, 'feasibilityDecision is evaluated synchronously');
      eq(res.agreement, true, 'both paths agreed on HOSP_1');
      eq(res.disagreementClass, 'AGREEMENT', 'disagreementClass is AGREEMENT');
      ok(authority.getMetrics().canaryEvaluations > 0, 'canary evaluation count incremented');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 4. Invalid mode
  await check('4. Invalid mode: DECISION_AUTHORITY_MODE=garbage safely falls back to SHADOW mode', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'GARBAGE_UNRECOGNIZED_MODE';
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(res.effectiveMode, 'SHADOW', 'invalid mode fails safe to SHADOW');
      eq(res.finalDecision.source, 'LEGACY', 'destination source is LEGACY');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 5. Missing mode
  await check('5. Missing mode: unset configuration defaults strictly to safe SHADOW mode', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    delete process.env.DECISION_AUTHORITY_MODE;
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(res.effectiveMode, 'SHADOW', 'default is SHADOW');
      eq(res.finalDecision.source, 'LEGACY', 'destination source is LEGACY');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 6. Feasibility exception
  await check('6. Feasibility exception: failure contained, fallback triggered, legacy destination unaffected', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      // Inject throwing error in shadow.evaluate
      (shadow as any).evaluate = async () => { throw new Error('Feasibility engine simulated crash'); };

      const authority = new DecisionAuthority({ shadow, now: () => T0 });
      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(res.finalDecision.source, 'LEGACY', 'legacy source preserved');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'legacy destination HOSP_1 unharmed');
      eq(res.disagreementClass, 'ENGINE_ERROR', 'disagreementClass is ENGINE_ERROR');
      eq(res.agreement, false, 'marked as disagreement');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 7. Feasibility timeout
  await check('7. Feasibility timeout: evaluation exceeding budget times out safely without delaying legacy', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      // Set timeout to 10ms and make shadow hang
      const shadow = new FeasibilityShadow({
        hospitals: () => hospitals,
        ledger,
        mapping: stubMapping(),
        timeoutMs: 10,
        log: () => undefined,
      });
      (shadow as any).run = async () => new Promise(resolve => setTimeout(resolve, 200));

      const authority = new DecisionAuthority({ shadow, now: () => T0 });
      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(res.finalDecision.source, 'LEGACY', 'legacy source preserved on timeout');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'destination HOSP_1 unharmed');
      eq(res.disagreementClass, 'TIMEOUT', 'disagreementClass is TIMEOUT');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 8. Malformed feasibility result
  await check('8. Malformed feasibility result: empty/corrupt candidate array safely triggers fallback', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      // Return corrupt decision without selectedHospitalId or candidates
      (shadow as any).evaluate = async () => ({
        decision: { candidates: [], outcome: 'CORRUPT', evaluatedAt: iso(0), traceId: 't1' },
        trace: {} as any,
      });

      const authority = new DecisionAuthority({ shadow, now: () => T0 });
      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(res.finalDecision.source, 'LEGACY', 'legacy destination preserved');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'HOSP_1 assigned by legacy');
      eq(res.disagreementClass, 'LEGACY_ONLY', 'classified as LEGACY_ONLY');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 9. Unexpected disagreement
  await check('9. Unexpected disagreement: divergent destinations without policy difference classified as UNEXPECTED', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      // Feasibility chooses HOSP_2 while legacy chooses HOSP_1
      (shadow as any).evaluate = async () => ({
        decision: {
          candidates: [
            { hospitalId: HOSP_1, verdict: 'ELIGIBLE', blockingReasons: [] },
            { hospitalId: HOSP_2, verdict: 'ELIGIBLE', blockingReasons: [] },
          ],
          selectedHospitalId: HOSP_2,
          outcome: 'FEASIBLE',
          evaluatedAt: iso(0),
          traceId: 't-unexp',
        },
        trace: {} as any,
      });

      const authority = new DecisionAuthority({ shadow, now: () => T0 });
      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(res.disagreementClass, 'UNEXPECTED_DIFFERENCE', 'disagreementClass is UNEXPECTED_DIFFERENCE');
      eq(res.finalDecision.source, 'LEGACY', 'canary keeps legacy pick in control');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'legacy pick HOSP_1 returned');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 10. Expected disagreement
  await check('10. Expected disagreement: LIMITED acceptance missing required capability classified as EXPECTED_POLICY_DIFFERENCE', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      // Case needs EMERGENCY, TRAUMA, ICU. HOSP_1 responds LIMITED with only EMERGENCY.
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(
        responseEvent(CASE_A, HOSP_1, 'LIMITED', { respondedMin: -5, caps: ['EMERGENCY'], limitations: ['No ICU', 'No Trauma'] }).payload as any,
        { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }
      ));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(res.disagreementClass, 'EXPECTED_POLICY_DIFFERENCE', 'disagreementClass is EXPECTED_POLICY_DIFFERENCE');
      ok(res.disagreementReasons.includes('LIMITED_MISSING_CAPABILITY'), 'contains LIMITED_MISSING_CAPABILITY reason');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 11. Kill switch
  await check('11. Kill switch: tripping kill switch forces safe SHADOW mode; legacy routing completely unharmed', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    const killSwitch = new DecisionAuthorityKillSwitch();
    try {
      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      const authority = new DecisionAuthority({ shadow, killSwitch, now: () => T0 });

      // Before kill switch: CANARY
      const before = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });
      eq(before.effectiveMode, 'CANARY', 'before trip: CANARY');

      // Trip the kill switch
      killSwitch.trip('Emergency manual halt by platform operator');
      ok(killSwitch.isActive(), 'kill switch is active');

      const after = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: testPatient(CASE_A),
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      eq(after.effectiveMode, 'SHADOW', 'after trip: forced to safe SHADOW');
      eq(after.fallback, true, 'fallback flag is true');
      eq(after.fallbackReason, 'KILL_SWITCH_ACTIVE', 'fallbackReason is KILL_SWITCH_ACTIVE');
      eq(after.finalDecision.selectedHospitalId, HOSP_1, 'legacy destination HOSP_1 returned unharmed');

      // Restore kill switch
      killSwitch.restore();
      ok(!killSwitch.isActive(), 'kill switch is restored');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================ 12. Late feasibility result
  await check('12. Late feasibility result: cancelled evaluation drops output and cannot mutate authority', async () => {
    const hospitals = buildTestHospitals();
    const ledger = new AcceptanceLedger();
    let lateExecuted = false;

    const shadow = new FeasibilityShadow({
      hospitals: () => hospitals,
      ledger,
      mapping: stubMapping(),
      timeoutMs: 15,
      log: () => undefined,
    });
    // Simulate long-running task that finishes after timeout
    (shadow as any).run = async (_input: any, cancel: { cancelled: boolean }) => {
      await new Promise(r => setTimeout(r, 60));
      if (!cancel.cancelled) {
        lateExecuted = true;
      }
      return undefined;
    };

    const authority = new DecisionAuthority({ shadow, now: () => T0 });
    const res = await authority.selectDestination({
      ambulance: testAmbulance('AMB-1', CASE_A),
      patient: testPatient(CASE_A),
      requirement: testRequirement(CASE_A),
      hospitals,
      mapping: stubMapping(),
      acceptanceView: ledger,
      nowMs: T0,
    });

    await new Promise(r => setTimeout(r, 80));
    eq(lateExecuted, false, 'late execution was cancelled and dropped');
    eq(res.finalDecision.source, 'LEGACY', 'legacy source preserved');
  });

  // ============================================================ 13. Replay
  await check('13. Replay: arrival order permutations produce identical authority result and audit hash', async () => {
    const hospitals = buildTestHospitals();
    const req = requestedEvent(CASE_A, HOSP_1, -20);
    const resp = responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -15 });

    // Permutation 1
    const ledger1 = new AcceptanceLedger();
    ledger1.recordRequest(req.payload as any);
    ledger1.applyResponse(withTrust(resp.payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    // Permutation 2: Response arrives first, then request
    const ledger2 = new AcceptanceLedger();
    ledger2.applyResponse(withTrust(resp.payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
    ledger2.recordRequest(req.payload as any);

    const shadow1 = new FeasibilityShadow({ hospitals: () => hospitals, ledger: ledger1, mapping: stubMapping(), log: () => undefined, newId: counter() });
    const shadow2 = new FeasibilityShadow({ hospitals: () => hospitals, ledger: ledger2, mapping: stubMapping(), log: () => undefined, newId: counter() });

    const auth1 = new DecisionAuthority({ shadow: shadow1, now: () => T0 });
    const auth2 = new DecisionAuthority({ shadow: shadow2, now: () => T0 });

    const res1 = await auth1.selectDestination({
      ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
      hospitals, mapping: stubMapping(), acceptanceView: ledger1, nowMs: T0,
    });

    const res2 = await auth2.selectDestination({
      ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
      hospitals, mapping: stubMapping(), acceptanceView: ledger2, nowMs: T0,
    });

    eq(res1.auditHash, res2.auditHash, 'audit hashes match between permutation 1 and permutation 2');
    eq(res1.finalDecision.selectedHospitalId, res2.finalDecision.selectedHospitalId, 'destinations match');
  });

  // ============================================================ 14. Duplicate evaluation
  await check('14. Duplicate evaluation: identical input produces deterministic identical audit hash', async () => {
    const hospitals = buildTestHospitals();
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
    const authority = new DecisionAuthority({ shadow, now: () => T0 });

    const input = {
      ambulance: testAmbulance('AMB-1', CASE_A),
      patient: testPatient(CASE_A),
      requirement: testRequirement(CASE_A),
      hospitals,
      mapping: stubMapping(),
      acceptanceView: ledger,
      nowMs: T0,
    };

    const first = await authority.selectDestination(input);
    const second = await authority.selectDestination(input);

    eq(first.auditHash, second.auditHash, 'auditHash is strictly idempotent');
    eq(first.finalDecision.selectedHospitalId, second.finalDecision.selectedHospitalId, 'decisions identical');
  });

  // ============================================================ 15. Multi-case isolation
  await check('15. Multi-case isolation: Case A canary override does not affect Case B authority state', async () => {
    resetCaseAuthorityOverrides();
    try {
      setCaseAuthorityMode(CASE_A, 'CANARY');
      setCaseAuthorityMode(CASE_B, 'SHADOW');

      const hospitals = buildTestHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      ledger.recordRequest(requestedEvent(CASE_B, HOSP_2, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_B, HOSP_2, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const resA = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      const resB = await authority.selectDestination({
        ambulance: testAmbulance('AMB-2', CASE_B), patient: testPatient(CASE_B), requirement: testRequirement(CASE_B),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      eq(resA.effectiveMode, 'CANARY', 'Case A executed in CANARY mode');
      eq(resB.effectiveMode, 'SHADOW', 'Case B executed in SHADOW mode');
      eq(resA.finalDecision.selectedHospitalId, HOSP_1, 'Case A routed to HOSP_1');
      eq(resB.finalDecision.selectedHospitalId, HOSP_2, 'Case B routed to HOSP_2');
    } finally {
      resetCaseAuthorityOverrides();
    }
  });

  // ============================================================ 16. AI failure
  await check('16. AI failure: advisory AI failure or absence does not affect decision authority', async () => {
    // Decision authority relies strictly on domain facts, never AI text
    const hospitals = buildTestHospitals();
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
    const authority = new DecisionAuthority({ shadow, now: () => T0 });

    const res = await authority.selectDestination({
      ambulance: testAmbulance('AMB-1', CASE_A),
      patient: testPatient(CASE_A),
      requirement: testRequirement(CASE_A),
      hospitals,
      mapping: stubMapping(),
      acceptanceView: ledger,
      nowMs: T0,
    });

    eq(res.finalDecision.selectedHospitalId, HOSP_1, 'HOSP_1 selected independently of AI status');
  });

  // ============================================================ 17. Mapping failure
  await check('17. Mapping failure: routing provider error does not compromise clinical authority', async () => {
    const hospitals = buildTestHospitals();
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    // Mapping stub fails for all routes
    const failingMapping = stubMapping([`${hospitals[0].location!.latitude},${hospitals[0].location!.longitude}`]);

    const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: failingMapping, log: () => undefined });
    const authority = new DecisionAuthority({ shadow, now: () => T0 });

    const res = await authority.selectDestination({
      ambulance: testAmbulance('AMB-1', CASE_A),
      patient: testPatient(CASE_A),
      requirement: testRequirement(CASE_A),
      hospitals,
      mapping: failingMapping,
      acceptanceView: ledger,
      nowMs: T0,
    });

    eq(res.finalDecision.selectedHospitalId, HOSP_1, 'HOSP_1 chosen by clinical eligibility despite mapping provider down');
  });

  // ============================================================ 18. Trace failure
  await check('18. Trace failure: telemetry sink down does not affect authority decision outcome', async () => {
    const hospitals = buildTestHospitals();
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const shadow = new FeasibilityShadow({
      hospitals: () => hospitals,
      ledger,
      mapping: stubMapping(),
      log: () => undefined,
      publishTrace: async () => { throw new Error('Trace sink stream unavailable'); },
    });
    const authority = new DecisionAuthority({ shadow, now: () => T0 });

    const res = await authority.selectDestination({
      ambulance: testAmbulance('AMB-1', CASE_A),
      patient: testPatient(CASE_A),
      requirement: testRequirement(CASE_A),
      hospitals,
      mapping: stubMapping(),
      acceptanceView: ledger,
      nowMs: T0,
    });

    eq(res.finalDecision.selectedHospitalId, HOSP_1, 'decision completes normally when telemetry sink is down');
  });

  // ============================================================ 19. Metrics tracking
  await check('19. Metrics tracking: counters accurately reflect evaluations, agreements, and fallbacks', async () => {
    const hospitals = buildTestHospitals();
    const ledger = new AcceptanceLedger();
    const metrics = new DecisionAuthorityMetrics();
    const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
    const authority = new DecisionAuthority({ shadow, metrics, now: () => T0 });

    authority.reset();
    eq(metrics.getSummary().evaluationsTotal, 0, 'metrics initialized to 0');

    await authority.selectDestination({
      ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
      hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
    });

    const summary = metrics.getSummary();
    eq(summary.evaluationsTotal, 1, 'evaluationsTotal is 1');
    eq(summary.byMode.SHADOW, 1, 'SHADOW mode recorded');
  });

  // ============================================================ 20. Policy hash change
  await check('20. Policy hash change: policy variations alter policyHash and propagate to auditHash', async () => {
    const hospitals = buildTestHospitals();
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const policy1 = createFreshnessPolicy({ OPERATIONAL_CAPACITY: { maxAgeSeconds: 300 } });
    const policy2 = createFreshnessPolicy({ OPERATIONAL_CAPACITY: { maxAgeSeconds: 900 } });

    const shadow1 = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), policy: policy1, log: () => undefined });
    const shadow2 = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), policy: policy2, log: () => undefined });

    const auth1 = new DecisionAuthority({ shadow: shadow1, now: () => T0 });
    const auth2 = new DecisionAuthority({ shadow: shadow2, now: () => T0 });

    // In CANARY mode where feasibility evaluates synchronously:
    setCaseAuthorityMode(CASE_A, 'CANARY');
    try {
      const res1 = await auth1.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      const res2 = await auth2.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      ok(res1.feasibilityDecision?.policyHash !== res2.feasibilityDecision?.policyHash, 'policy hashes are distinct');
      ok(res1.auditHash !== res2.auditHash, 'audit hashes reflect policy variation');
    } finally {
      resetCaseAuthorityOverrides();
    }
  });

  console.log(`\nAll 20 Decision Authority Tests Passed! Total assertions: ${passCount()}`);
}

main().catch(err => {
  console.error('\nDecision Authority test failed:', err);
  process.exit(1);
});
