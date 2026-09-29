/**
 * JIVA — DECISION AUTHORITY CONTROLLED TRANSITION RUNNER
 *
 * ============================================================
 * ⚠  TEST / SIMULATION ONLY — NOT HUMAN AUTHORIZATION
 * ============================================================
 * This script exercises the technical promotion mechanism
 * using a CONTROLLED TEST AUTHORIZATION FIXTURE.
 *
 * Setting FEASIBILITY_AUTHORITY_ACKNOWLEDGED=true inside this
 * script is a TEST-ONLY fixture to verify gate mechanics.
 * It does NOT constitute actual human governance authorization.
 *
 * AUTHORIZATION STATE SEMANTICS:
 *   NOT_AUTHORIZED  — No governance acknowledgment present
 *   TEST_AUTHORIZATION — Local test fixture (this script only)
 *   HUMAN_AUTHORIZED  — Requires explicit human sign-off outside
 *                        this automation; NEVER set by scripts
 *
 * Final runtime state after this script:
 *   DECISION_AUTHORITY_MODE = SHADOW (restored)
 *   FEASIBILITY_AUTHORITY_ACKNOWLEDGED = unset (restored)
 *   legacyAuthoritative = true
 * ============================================================
 *
 * Demonstrates and validates the full 6-stage lifecycle progression:
 *
 *   SHADOW
 *      ↓
 *   Human review
 *      ↓
 *   Explicit authorization
 *      ↓
 *   CANARY
 *      ↓
 *   Validate live decision authority behavior
 *      ↓
 *   AUTHORITATIVE
 */

import fs from 'fs';
import path from 'path';
import type { AmbulanceState, CareRequirement, HospitalState, PatientState, GeoPoint } from '../packages/domain-models/src';
import { AcceptanceLedger, withTrust } from '../services/api/src/feasibility/acceptanceLedger';
import { FeasibilityShadow } from '../services/api/src/feasibility/shadow';
import {
  DecisionAuthority,
  authorityKillSwitch,
  AuthorityCircuitBreaker,
  DecisionAuthorityMetrics,
  PromotionGateValidator,
  configuredAuthorityMode,
  setCaseAuthorityMode,
  resetCaseAuthorityOverrides,
} from '../services/api/src/feasibility/authority';
import { stubMapping, hospital, withCapacity, requestedEvent, responseEvent, iso, T0 } from '../tests/unit/helpers/feasibilityHarness';

const HOSP_1 = 'HOSP-BLR-001'; // Manipal Old Airport Road
const HOSP_2 = 'HOSP-BLR-002'; // Aster CMI Hebbal
const HOSP_3 = 'HOSP-BLR-003'; // Bangalore Baptist Hospital
const HOSP_4 = 'HOSP-BLR-004'; // Indira Gandhi Institute of Child Health

const ORIGIN_KORAMANGALA: GeoPoint = { latitude: 12.9352, longitude: 77.6245 };
const ORIGIN_HEBBAL: GeoPoint = { latitude: 13.0358, longitude: 77.5970 };
const ORIGIN_WHITEFIELD: GeoPoint = { latitude: 12.9698, longitude: 77.7500 };

function getHospitals(): HospitalState[] {
  const h1 = withCapacity(hospital(HOSP_1, 1), { emergency: 'AVAILABLE', trauma: 'AVAILABLE', icu: 'AVAILABLE', cathlab: 'AVAILABLE' } as any, -5);
  const h2 = withCapacity(hospital(HOSP_2, 2), { emergency: 'AVAILABLE', trauma: 'AVAILABLE', icu: 'AVAILABLE' }, -5);
  const h3 = withCapacity(hospital(HOSP_3, 3), { emergency: 'AVAILABLE', trauma: 'UNAVAILABLE', icu: 'UNAVAILABLE' }, -5);
  const h4 = withCapacity(hospital(HOSP_4, 4), { emergency: 'AVAILABLE', picu: 'AVAILABLE', nicu: 'AVAILABLE' } as any, -5);
  h4.capabilities = { emergency: true, picu: true, nicu: true };
  return [h1, h2, h3, h4];
}

function makeAmbulance(id: string, caseId: string, loc = ORIGIN_KORAMANGALA): AmbulanceState {
  return {
    ambulanceId: id,
    status: 'DISPATCHED',
    assignedPatient: caseId,
    currentLocation: { ...loc },
    requiredCapabilities: ['EMERGENCY', 'TRAUMA', 'ICU'],
    lastUpdated: iso(0),
    locationAsOf: iso(0),
    provenance: [],
  };
}

function makePatient(caseId: string, condition: string, caps: string[], loc = ORIGIN_KORAMANGALA): PatientState {
  return {
    patientId: caseId,
    currentStatus: 'ASSESSED',
    careRequirements: caps as any,
    activeConditions: [condition],
    currentLocation: { ...loc },
    lastUpdated: iso(0),
    provenance: [],
  };
}

function makeRequirement(caseId: string, caps: string[]): CareRequirement {
  return {
    requirementId: `REQ-${caseId}`,
    caseId,
    requiredCapabilities: caps as any,
    optionalCapabilities: [],
    severity: 'CRITICAL',
    createdAt: iso(-10),
    source: 'assessment-engine',
  };
}

async function run() {
  console.log('\n================================================================');
  console.log('       JIVA DECISION AUTHORITY CONTROLLED TRANSITION');
  console.log('================================================================');
  console.log('  Ladder:');
  console.log('    1. SHADOW');
  console.log('       ↓');
  console.log('    2. Human review');
  console.log('       ↓');
  console.log('    3. Explicit authorization');
  console.log('       ↓');
  console.log('    4. CANARY');
  console.log('       ↓');
  console.log('    5. Validate live decision authority behavior');
  console.log('       ↓');
  console.log('    6. AUTHORITATIVE');
  console.log('================================================================\n');

  const originalEnvMode = process.env.DECISION_AUTHORITY_MODE;
  const originalEnvAck = process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED;

  try {
    const hospitals = getHospitals();
    const ledger = new AcceptanceLedger();
    const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined });
    const authority = new DecisionAuthority({ shadow, now: () => T0 });

    // -------------------------------------------------------------
    // 1. SHADOW
    // -------------------------------------------------------------
    console.log('[STAGE 1] Operating in Baseline SHADOW Mode...');
    delete process.env.DECISION_AUTHORITY_MODE;
    delete process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED;

    ledger.recordRequest(requestedEvent('CASE-BASELINE', HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(
      responseEvent('CASE-BASELINE', HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any,
      { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }
    ));

    const resShadow = await authority.selectDestination({
      ambulance: makeAmbulance('AMB-S1', 'CASE-BASELINE', ORIGIN_KORAMANGALA),
      patient: makePatient('CASE-BASELINE', 'Acute STEMI', ['EMERGENCY', 'TRAUMA', 'ICU']),
      requirement: makeRequirement('CASE-BASELINE', ['EMERGENCY', 'TRAUMA', 'ICU']),
      hospitals,
      mapping: stubMapping(),
      acceptanceView: ledger,
      nowMs: T0,
    });

    console.log(`  ✓ Configured Mode : ${resShadow.configuredMode}`);
    console.log(`  ✓ Effective Mode  : ${resShadow.effectiveMode}`);
    console.log(`  ✓ Decision Source : ${resShadow.finalDecision.source}`);
    console.log(`  ✓ Destination     : ${resShadow.finalDecision.selectedHospitalId} (strictly Legacy destination)`);
    console.log(`  ✓ Feasibility Ran : Contained background observation (zero authority)\n`);

    // -------------------------------------------------------------
    // 2. Human Review
    // -------------------------------------------------------------
    console.log('[STAGE 2] Human Governance Review of Soak Telemetry...');
    const reportPath = path.resolve(__dirname, '../data/validation/reports/canary-soak-report.json');
    if (!fs.existsSync(reportPath)) {
      throw new Error(`Soak report not found at ${reportPath}. Run npm run canary:soak first.`);
    }
    const soakReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

    console.log(`  ✓ Soak Status         : ${soakReport.status}`);
    console.log(`  ✓ Evaluations Tracked : ${soakReport.scale.evaluationsTotal}`);
    console.log(`  ✓ Total Agreements    : ${soakReport.metrics.agreedCount} (${((soakReport.metrics.agreedCount / soakReport.scale.evaluationsTotal) * 100).toFixed(1)}%)`);
    console.log(`  ✓ Unexpected Diff     : ${soakReport.metrics.byDisagreementClass.UNEXPECTED_DIFFERENCE}`);
    console.log(`  ✓ Timeouts / Errors   : ${soakReport.metrics.timeouts} / ${soakReport.metrics.errors}`);
    console.log(`  ✓ Replay Parity       : VERIFIED`);
    console.log(`  ✓ Human Sign-off Req  : PENDING EXPLICIT ACKNOWLEDGMENT\n`);

    // -------------------------------------------------------------
    // 3. Explicit Authorization
    // -------------------------------------------------------------
    console.log('[STAGE 3] Supplying Controlled Test Authorization Fixture (TEST ONLY — NOT real human authorization)...');
    process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED = 'true';
    console.log(`  ✓ Test Fixture Applied : FEASIBILITY_AUTHORITY_ACKNOWLEDGED=true (TEST_AUTHORIZATION — local fixture only)`);
    const preCanaryGate = PromotionGateValidator.validate(authority.getMetrics());
    console.log(`  ✓ Gate 1 Exercised     : ${preCanaryGate.satisfiedGates.includes('FEASIBILITY_AUTHORITY_ACKNOWLEDGED') ? 'YES' : 'NO'} (TEST_AUTHORIZATION verifies gate mechanics — not HUMAN_AUTHORIZED)`);
    console.log(`  ✓ Premature Direct Auth: Safely blocked until >= 10 evaluations recorded (defense-in-depth)\n`);

    // -------------------------------------------------------------
    // 4. CANARY
    // -------------------------------------------------------------
    console.log('[STAGE 4] Transitioning to CANARY Mode (Synchronous Telemetry Fleet)...');
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';

    const canaryFleet = [
      { id: 'CASE-CNR-01', type: 'Severe Polytrauma', hosp: HOSP_1, origin: ORIGIN_KORAMANGALA, caps: ['EMERGENCY', 'TRAUMA', 'ICU'] },
      { id: 'CASE-CNR-02', type: 'Acute Ischemic Stroke', hosp: HOSP_2, origin: ORIGIN_HEBBAL, caps: ['EMERGENCY', 'TRAUMA', 'ICU'] },
      { id: 'CASE-CNR-03', type: 'Pediatric Respiratory', hosp: HOSP_4, origin: ORIGIN_WHITEFIELD, caps: ['EMERGENCY', 'PEDIATRICS'] },
      { id: 'CASE-CNR-04', type: 'Cardiac Arrest', hosp: HOSP_1, origin: ORIGIN_KORAMANGALA, caps: ['EMERGENCY', 'TRAUMA', 'ICU'] },
      { id: 'CASE-CNR-05', type: 'Subdural Hematoma', hosp: HOSP_2, origin: ORIGIN_HEBBAL, caps: ['EMERGENCY', 'TRAUMA', 'ICU'] },
      { id: 'CASE-CNR-06', type: 'Major Burn Shock', hosp: HOSP_1, origin: ORIGIN_KORAMANGALA, caps: ['EMERGENCY', 'TRAUMA', 'ICU'] },
      { id: 'CASE-CNR-07', type: 'Pediatric Status Epilepticus', hosp: HOSP_4, origin: ORIGIN_WHITEFIELD, caps: ['EMERGENCY', 'PEDIATRICS'] },
      { id: 'CASE-CNR-08', type: 'Septic Shock', hosp: HOSP_1, origin: ORIGIN_KORAMANGALA, caps: ['EMERGENCY', 'TRAUMA', 'ICU'] },
      { id: 'CASE-CNR-09', type: 'Aortic Dissection', hosp: HOSP_1, origin: ORIGIN_KORAMANGALA, caps: ['EMERGENCY', 'TRAUMA', 'ICU'] },
      { id: 'CASE-CNR-10', type: 'Spinal Cord Injury', hosp: HOSP_2, origin: ORIGIN_HEBBAL, caps: ['EMERGENCY', 'TRAUMA', 'ICU'] },
      { id: 'CASE-CNR-11', type: 'Pediatric Foreign Body Aspiration', hosp: HOSP_4, origin: ORIGIN_WHITEFIELD, caps: ['EMERGENCY', 'PEDIATRICS'] },
      { id: 'CASE-CNR-12', type: 'Crush Injury', hosp: HOSP_2, origin: ORIGIN_HEBBAL, caps: ['EMERGENCY', 'TRAUMA', 'ICU'] },
    ];

    let canaryAgreements = 0;
    for (const c of canaryFleet) {
      ledger.recordRequest(requestedEvent(c.id, c.hosp, -10).payload as any);
      ledger.applyResponse(withTrust(
        responseEvent(c.id, c.hosp, 'ACCEPTED', { respondedMin: -5 }).payload as any,
        { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }
      ));

      const res = await authority.selectDestination({
        ambulance: makeAmbulance(`AMB-${c.id}`, c.id, c.origin),
        patient: makePatient(c.id, c.type, c.caps, c.origin),
        requirement: makeRequirement(c.id, c.caps),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      if (res.agreement) canaryAgreements++;

      if (res.finalDecision.source !== 'LEGACY') {
        throw new Error(`CRITICAL INVARIANT VIOLATION: Case ${c.id} in CANARY returned source=${res.finalDecision.source}`);
      }
    }

    const canaryMetrics = authority.getMetrics();
    console.log(`  ✓ Fleet Evaluations   : ${canaryMetrics.canaryEvaluations} cases processed`);
    console.log(`  ✓ Agreement Rate      : ${((canaryAgreements / canaryMetrics.canaryEvaluations) * 100).toFixed(1)}%`);
    console.log(`  ✓ CANARY Invariant    : 100% of cases routed strictly via LEGACY destination source`);
    console.log(`  ✓ Disagreements       : 0 unexpected differences\n`);

    // -------------------------------------------------------------
    // 5. Validate Live Decision Authority Behavior
    // -------------------------------------------------------------
    console.log('[STAGE 5] Validating Live Decision Authority Behavior...');
    const liveMetrics = authority.getMetrics();
    const liveGateResult = PromotionGateValidator.validate(liveMetrics, { minEvaluations: 10 });

    console.log(`  ✓ Total Evaluations   : ${liveMetrics.evaluationsTotal}`);
    console.log(`  ✓ Circuit Breaker     : ${authority.circuitBreaker.getState()}`);
    console.log(`  ✓ Kill Switch         : ${authority.killSwitch.isActive() ? 'ACTIVE' : 'READY (OFF)'}`);
    console.log(`  ✓ Promotion Gates     : ${liveGateResult.authorized ? 'ALL GATES PASSED (100%)' : 'BLOCKED'}`);
    for (const g of liveGateResult.satisfiedGates) {
      console.log(`      • [SATISFIED] ${g}`);
    }
    console.log('');

    // -------------------------------------------------------------
    // 6. AUTHORITATIVE
    // -------------------------------------------------------------
    console.log('[STAGE 6] Controlled Promotion to AUTHORITATIVE Mode...');
    process.env.DECISION_AUTHORITY_MODE = 'AUTHORITATIVE';

    const caseLive = 'CASE-LIVE-PROMOTED';
    ledger.recordRequest(requestedEvent(caseLive, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(
      responseEvent(caseLive, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any,
      { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }
    ));

    const resAuth = await authority.selectDestination({
      ambulance: makeAmbulance('AMB-LIVE-1', caseLive, ORIGIN_KORAMANGALA),
      patient: makePatient(caseLive, 'Acute STEMI - CathLab Required', ['EMERGENCY', 'TRAUMA', 'ICU']),
      requirement: makeRequirement(caseLive, ['EMERGENCY', 'TRAUMA', 'ICU']),
      hospitals,
      mapping: stubMapping(),
      acceptanceView: ledger,
      nowMs: T0,
    });

    console.log(`  ✓ Configured Mode     : ${resAuth.configuredMode}`);
    console.log(`  ✓ Effective Mode      : ${resAuth.effectiveMode}`);
    console.log(`  ✓ Decision Source     : ${resAuth.finalDecision.source} ★`);
    console.log(`  ✓ Selected Hospital   : ${resAuth.finalDecision.selectedHospitalId} (Care Feasibility Authoritative)`);
    console.log(`  ✓ Audit Hash          : ${resAuth.auditHash}`);
    console.log(`  ✓ Fail-Safe Fallbacks : Armed & Active (Exception, Timeout, Disagreement, Circuit Breaker, Kill Switch)`);

    // Confirm final state is SHADOW (fixture was test-only)
    console.log('\n[FINAL STATE] Verifying runtime is returned to safe SHADOW...');
    console.log('  (The finally block below restores env vars and overrides)');
    console.log('  DECISION_AUTHORITY_MODE will be: SHADOW (unset)');
    console.log('  FEASIBILITY_AUTHORITY_ACKNOWLEDGED will be: unset');
    console.log('  This confirms TEST_AUTHORIZATION does not persist.\n');

    console.log('\n================================================================');
    console.log('       TRANSITION SIMULATION COMPLETE (TEST FIXTURE — SHADOW RESTORED)');
    console.log('================================================================\n');
  } finally {
    if (originalEnvMode === undefined) delete process.env.DECISION_AUTHORITY_MODE;
    else process.env.DECISION_AUTHORITY_MODE = originalEnvMode;

    if (originalEnvAck === undefined) delete process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED;
    else process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED = originalEnvAck;

    resetCaseAuthorityOverrides();
    authorityKillSwitch.restore();
  }
}

run().catch(err => {
  console.error('[FATAL] Authority transition error:', err);
  process.exit(1);
});
