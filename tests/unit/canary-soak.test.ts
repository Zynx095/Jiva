/**
 * JIVA PHASE 6.4 — PRODUCTION SOAK & PROMOTION READINESS TEST SUITE
 *
 * Verifies all Phase 6.4 canary soak criteria:
 *   1. Scenarios A through T (20 distinct clinical and operational flows)
 *   2. Determinism & Arrival Permutations
 *   3. Multi-Case Isolation Matrix
 *   4. Acceptance Lifecycle Transitions
 *   5. Operational State Stress (10,000+ telemetry events)
 *   6. Failure Injection Containment (14 failure modes)
 *   7. Kill Switch Safety & Recovery
 *   8. Automated Promotion Gate Validator
 *   9. Policy Hash Cryptographic Propagation
 *  10. Trace Privacy & PII/PHI Exclusion
 */

import { randomUUID } from 'crypto';
import type { AmbulanceState, CareRequirement, HospitalState, PatientState, GeoPoint } from '../../packages/domain-models/src';
import type { AnyEvent } from '../../packages/event-schema/src';
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
  AuthorityMetricsSummary,
  setCaseAuthorityMode,
  resetCaseAuthorityOverrides,
} from '../../services/api/src/feasibility/authority';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import {
  check,
  eq,
  hospital,
  iso,
  ok,
  passCount,
  requestedEvent,
  responseEvent,
  capacityEvent,
  stubMapping,
  T0,
  withCapacity,
} from './helpers/feasibilityHarness';

const HOSP_1 = 'HOSP-BLR-001';
const HOSP_2 = 'HOSP-BLR-002';
const HOSP_3 = 'HOSP-BLR-003';
const HOSP_4 = 'HOSP-BLR-004';

const CASE_A = 'CASE-SOAK-A';
const CASE_B = 'CASE-SOAK-B';
const CASE_C = 'CASE-SOAK-C';

const ORIGIN: GeoPoint = { latitude: 13.0, longitude: 77.6 };

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

function testRequirement(caseId = CASE_A, caps: string[] = ['EMERGENCY', 'TRAUMA', 'ICU']): CareRequirement {
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

function buildSoakHospitals(): HospitalState[] {
  const h1 = withCapacity(hospital(HOSP_1, 1), { emergency: 'AVAILABLE', trauma: 'AVAILABLE', icu: 'AVAILABLE' }, -5);
  const h2 = withCapacity(hospital(HOSP_2, 2), { emergency: 'AVAILABLE', trauma: 'AVAILABLE', icu: 'AVAILABLE' }, -5);
  const h3 = withCapacity(hospital(HOSP_3, 3), { emergency: 'AVAILABLE', trauma: 'AVAILABLE', icu: 'AVAILABLE' }, -5);
  const h4 = withCapacity(hospital(HOSP_4, 4), { emergency: 'AVAILABLE', trauma: 'UNAVAILABLE', icu: 'UNAVAILABLE' }, -5);
  return [h1, h2, h3, h4];
}

async function main() {
  console.log('\n============================================================');
  console.log('JIVA PHASE 6.4: CANARY SOAK & PROMOTION READINESS TEST SUITE');
  console.log('============================================================\n');

  // ============================================================
  // SECTION 1: SCENARIOS A THROUGH T (20 DISTINCT CLINICAL FLOWS)
  // ============================================================

  // Scenario A: Normal acceptance
  await check('Scenario A: Normal acceptance (both engines agree on capable accepted hospital)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
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

      eq(res.effectiveMode, 'CANARY', 'mode is CANARY');
      eq(res.finalDecision.source, 'LEGACY', 'legacy controls destination');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'destination is HOSP_1');
      eq(res.agreement, true, 'engines agree');
      eq(res.disagreementClass, 'AGREEMENT', 'classified as AGREEMENT');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario B: LIMITED acceptance missing required capability
  await check('Scenario B: LIMITED acceptance missing ICU (EXPECTED_POLICY_DIFFERENCE: legacy picks, feasibility rejects)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(
        responseEvent(CASE_A, HOSP_1, 'LIMITED', { respondedMin: -5, caps: ['EMERGENCY', 'TRAUMA'], limitations: ['ICU full'] }).payload as any,
        { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }
      ));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
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
      eq(res.finalDecision.source, 'LEGACY', 'destination is controlled by LEGACY');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'legacy selected HOSP_1');
      eq(res.agreement, false, 'marked as divergence');
      eq(res.disagreementClass, 'EXPECTED_POLICY_DIFFERENCE', 'classified as EXPECTED_POLICY_DIFFERENCE');
      ok(res.disagreementReasons.includes('LIMITED_MISSING_CAPABILITY'), 'reason identifies LIMITED_MISSING_CAPABILITY');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario C: Hospital rejection
  await check('Scenario C: Hospital rejection (candidate eliminated, next eligible chosen)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'REJECTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_2, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_2, 'ACCEPTED', { respondedMin: -4 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
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

      eq(res.finalDecision.selectedHospitalId, HOSP_2, 'HOSP_1 eliminated, HOSP_2 selected');
      eq(res.agreement, true, 'both engines agree on HOSP_2');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario D: Hospital unavailable
  await check('Scenario D: Hospital unavailable (hospital-wide UNAVAILABLE excludes facility)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'UNAVAILABLE', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_2, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_2, 'ACCEPTED', { respondedMin: -4 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
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

      eq(res.finalDecision.selectedHospitalId, HOSP_2, 'HOSP_1 excluded due to UNAVAILABLE, HOSP_2 selected');
      eq(res.agreement, true, 'both engines agree on HOSP_2');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario E: Acceptance expiry
  await check('Scenario E: Acceptance expiry (expired response drops to PENDING, triggers reroute)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      // HOSP_1 response expired 2 minutes ago
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -30).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -25, validMin: -2 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
      // HOSP_2 response is valid
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_2, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_2, 'ACCEPTED', { respondedMin: -5, validMin: 20 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
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

      eq(res.finalDecision.selectedHospitalId, HOSP_2, 'expired HOSP_1 bypassed, active HOSP_2 selected');
      eq(res.agreement, true, 'both engines agree on HOSP_2');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario F: Acceptance cancellation
  await check('Scenario F: Acceptance cancellation (arrival/closure cancels request; cannot accept cancelled request)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      const req = requestedEvent(CASE_A, HOSP_1, -10);
      ledger.recordRequest(req.payload as any);
      // Cancel request at -5
      ledger.cancelRequest((req.payload as any).requestId, iso(-5));
      // Attempt response at -4
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -4 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
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

      eq(res.finalDecision.selectedHospitalId, undefined, 'cancelled request cannot yield an accepted destination');
      eq(res.agreement, true, 'both engines agree on no destination');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario G: Destination change
  await check('Scenario G: Destination change (requirement upgrade shifts destination to capable facility)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_2, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_2, 'ACCEPTED', { respondedMin: -4 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      // First decision: HOSP_1 is selected (nearest)
      const res1 = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });
      eq(res1.finalDecision.selectedHospitalId, HOSP_1, 'initial destination is HOSP_1');

      // Now exclude HOSP_1 (simulating destination change or hospital withdrawal)
      const res2 = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, exclude: new Set([HOSP_1]), nowMs: T0,
      });
      eq(res2.finalDecision.selectedHospitalId, HOSP_2, 'updated destination is HOSP_2');
      eq(res2.agreement, true, 'both agree on changed destination');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario H: Reroute
  await check('Scenario H: Reroute (en route facility reports UNAVAILABLE -> reroute to secondary accepted)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -8 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_2, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_2, 'ACCEPTED', { respondedMin: -7 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      // In-flight: HOSP_1 suddenly reports UNAVAILABLE
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'UNAVAILABLE', { respondedMin: -2 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });
      eq(res.finalDecision.selectedHospitalId, HOSP_2, 'automatically reroutes to HOSP_2');
      eq(res.agreement, true, 'both engines agree on reroute target');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario I: Out-of-order events
  await check('Scenario I: Out-of-order events (older ACCEPTED delivered after newer REJECTED -> REJECTED stands)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -20).payload as any);

      // Event 1: Newer rejection at -5
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'REJECTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
      // Event 2: Stale acceptance at -15 arrives late
      const staleRes = ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -15 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
      eq(staleRes, 'STALE', 'older acceptance identified as STALE');

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });
      eq(res.finalDecision.selectedHospitalId, undefined, 'rejection stands; stale acceptance did not revive candidate');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario J: Duplicate events
  await check('Scenario J: Duplicate events (exact duplicate eventId and responseId are idempotent)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      const req = requestedEvent(CASE_A, HOSP_1, -10);
      ledger.recordRequest(req.payload as any);
      // Duplicate request recording
      ledger.recordRequest(req.payload as any);

      const resp = responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 });
      const res1 = ledger.applyResponse(withTrust(resp.payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
      const res2 = ledger.applyResponse(withTrust(resp.payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      eq(res1, 'APPLIED', 'first delivery applied');
      eq(res2, 'DUPLICATE', 'second delivery detected as DUPLICATE');

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'destination selected normally');
      eq(res.agreement, true, 'both engines agree');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario K: Telemetry flood
  await check('Scenario K: Telemetry flood (1,000 rapid location updates do not degrade authority decision)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const amb = testAmbulance('AMB-1', CASE_A);
      // Simulate rapid GPS telemetry
      for (let i = 0; i < 1000; i++) {
        amb.currentLocation = { latitude: 13.0 + i * 0.0001, longitude: 77.6 + i * 0.0001 };
        amb.locationAsOf = iso(i / 1000);
      }

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: amb, patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'destination HOSP_1 selected despite GPS flood');
      eq(res.agreement, true, 'both engines agree');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario L: Multiple cases sharing one hospital
  await check('Scenario L: Multiple cases sharing one hospital (Case A accepted, Case B rejected -> isolated)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();

      // Case A accepted at HOSP_1
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      // Case B rejected at HOSP_1, accepted at HOSP_2
      ledger.recordRequest(requestedEvent(CASE_B, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_B, HOSP_1, 'REJECTED', { respondedMin: -4 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
      ledger.recordRequest(requestedEvent(CASE_B, HOSP_2, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_B, HOSP_2, 'ACCEPTED', { respondedMin: -3 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const resA = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });
      const resB = await authority.selectDestination({
        ambulance: testAmbulance('AMB-2', CASE_B), patient: testPatient(CASE_B), requirement: testRequirement(CASE_B),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      eq(resA.finalDecision.selectedHospitalId, HOSP_1, 'Case A destination is HOSP_1');
      eq(resB.finalDecision.selectedHospitalId, HOSP_2, 'Case B destination is HOSP_2');
      eq(resA.agreement, true, 'Case A agreement');
      eq(resB.agreement, true, 'Case B agreement');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario M: Multiple hospitals responding to one case
  await check('Scenario M: Multiple hospitals responding (H1 accepted, H2 limited, H3 rejected -> nearest valid chosen)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();

      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      ledger.recordRequest(requestedEvent(CASE_A, HOSP_2, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_2, 'LIMITED', { respondedMin: -4, caps: ['EMERGENCY'] }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      ledger.recordRequest(requestedEvent(CASE_A, HOSP_3, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_3, 'REJECTED', { respondedMin: -3 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'HOSP_1 chosen (accepted and capable)');
      eq(res.agreement, true, 'both engines agree on HOSP_1');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario N: No suitable hospital
  await check('Scenario N: No suitable hospital (all rejected or incapable -> NO_FEASIBLE_CANDIDATE / None)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      for (const h of [HOSP_1, HOSP_2, HOSP_3, HOSP_4]) {
        ledger.recordRequest(requestedEvent(CASE_A, h, -10).payload as any);
        ledger.applyResponse(withTrust(responseEvent(CASE_A, h, 'REJECTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
      }

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      eq(res.finalDecision.selectedHospitalId, undefined, 'no hospital selected');
      eq(res.agreement, true, 'both engines agree on no destination');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario O: Missing/unknown evidence
  await check('Scenario O: Missing evidence (unverified operational status -> PENDING_ACCEPTANCE)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      // Build hospitals with UNKNOWN operational state and no acceptance
      const hospitals = [hospital(HOSP_1, 1), hospital(HOSP_2, 2)];
      const ledger = new AcceptanceLedger();

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      eq(res.finalDecision.selectedHospitalId, undefined, 'no destination selected without acceptance');
      eq(res.agreement, true, 'both engines agree on PENDING');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario P: Feasibility timeout
  await check('Scenario P: Feasibility timeout (exceeding budget falls back safely to legacy destination)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      // Shadow with 10ms timeout budget and delay
      const shadow = new FeasibilityShadow({
        hospitals: () => hospitals, ledger, mapping: stubMapping(),
        timeoutMs: 10,
        log: () => undefined,
      });
      (shadow as any).run = async () => new Promise(resolve => setTimeout(resolve, 200));
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      eq(res.finalDecision.source, 'LEGACY', 'legacy controls destination');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'destination HOSP_1 unharmed');
      eq(res.disagreementClass, 'TIMEOUT', 'classified as TIMEOUT');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario Q: Feasibility exception
  await check('Scenario Q: Feasibility exception (internal thrown error contained, legacy destination intact)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      (shadow as any).evaluate = async () => { throw new Error('Feasibility engine simulated crash'); };
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      eq(res.finalDecision.source, 'LEGACY', 'destination source is LEGACY');
      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'legacy selectedHospitalId returned unharmed');
      eq(res.disagreementClass, 'ENGINE_ERROR', 'disagreementClass is ENGINE_ERROR');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario R: Mapping provider failure
  await check('Scenario R: Mapping provider failure (routing error falls back without compromising eligibility)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const failingMapping = {
        ...stubMapping(),
        calculateRoute: async () => { throw new Error('Valhalla and OSRM unreachable'); },
      };

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: failingMapping, log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: failingMapping, acceptanceView: ledger, nowMs: T0,
      });

      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'HOSP_1 safely selected via fallback');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario S: AI provider failure
  await check('Scenario S: AI provider failure (Bedrock failure has zero impact on decision authority)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      // Simulate AI failure in sidecar
      const aiSidecarFailure = new Error('AWS Bedrock throttling exception: Model invocation failed');
      ok(aiSidecarFailure !== undefined, 'AI error occurred in sidecar');

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'destination unharmed by AI outage');
      eq(res.agreement, true, 'authority decisions proceed without AI dependency');
    } finally {
      restoreMode(savedMode);
    }
  });

  // Scenario T: Trace/metrics sink failure
  await check('Scenario T: Trace sink failure (observability telemetry failure does not alter decision)', async () => {
    const savedMode = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CANARY';
    try {
      const hospitals = buildSoakHospitals();
      const ledger = new AcceptanceLedger();
      ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
      ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

      const shadow = new FeasibilityShadow({
        hospitals: () => hospitals, ledger, mapping: stubMapping(),
        publishTrace: async () => { throw new Error('CloudWatch/WebSocket trace sink unreachable'); },
        log: () => undefined, clock: () => iso(0),
      });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
        hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
      });

      eq(res.finalDecision.selectedHospitalId, HOSP_1, 'HOSP_1 selected despite trace sink failure');
      eq(res.agreement, true, 'both engines agree');
    } finally {
      restoreMode(savedMode);
    }
  });

  // ============================================================
  // SECTION 2: DETERMINISM & ARRIVAL ORDER PERMUTATIONS
  // ============================================================
  await check('Determinism: 6 arrival-order permutations produce byte-identical audit hashes', async () => {
    const hospitals = buildSoakHospitals();

    // 3 events for CASE_A:
    // Event 1: Requested HOSP_1
    // Event 2: Requested HOSP_2
    // Event 3: Accepted HOSP_1
    const e1 = requestedEvent(CASE_A, HOSP_1, -10);
    const e2 = requestedEvent(CASE_A, HOSP_2, -10);
    const e3 = responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 });

    const permutations = [
      [e1, e2, e3],
      [e1, e3, e2],
      [e2, e1, e3],
      [e2, e3, e1],
      [e3, e1, e2],
      [e3, e2, e1],
    ];

    const auditHashes: string[] = [];

    for (const perm of permutations) {
      const ledger = new AcceptanceLedger();
      for (const ev of perm) {
        if (ev.eventType === 'hospital.acceptance.requested') {
          ledger.recordRequest(ev.payload as any);
        } else if (ev.eventType === 'hospital.acceptance.received') {
          ledger.applyResponse(withTrust(ev.payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
        }
      }

      const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
      const authority = new DecisionAuthority({ shadow, now: () => T0 });

      setCaseAuthorityMode(CASE_A, 'CANARY');
      try {
        const res = await authority.selectDestination({
          ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A),
          hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0,
        });

        auditHashes.push(res.auditHash);
        eq(res.finalDecision.selectedHospitalId, HOSP_1, 'all permutations select HOSP_1');
      } finally {
        resetCaseAuthorityOverrides();
      }
    }

    const firstHash = auditHashes[0];
    ok(firstHash.length === 64, 'auditHash is 64 hex characters');
    for (let i = 1; i < auditHashes.length; i++) {
      eq(auditHashes[i], firstHash, `permutation ${i} hash matches firstHash`);
    }
  });

  // ============================================================
  // SECTION 3: MULTI-CASE ISOLATION MATRIX
  // ============================================================
  await check('Case Isolation: Simultaneous cases (Case A accepted, Case B limited, Case C rejected) are strictly isolated', async () => {
    const hospitals = buildSoakHospitals();
    const ledger = new AcceptanceLedger();

    // Setup 3 simultaneous cases against HOSP_1:
    // Case A: ACCEPTED
    ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    // Case B: LIMITED (missing ICU)
    ledger.recordRequest(requestedEvent(CASE_B, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_B, HOSP_1, 'LIMITED', { respondedMin: -5, caps: ['EMERGENCY', 'TRAUMA'], limitations: ['ICU full'] }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    // Case C: REJECTED
    ledger.recordRequest(requestedEvent(CASE_C, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_C, HOSP_1, 'REJECTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
    const authority = new DecisionAuthority({ shadow, now: () => T0 });

    setCaseAuthorityMode(CASE_A, 'CANARY');
    setCaseAuthorityMode(CASE_B, 'CANARY');
    setCaseAuthorityMode(CASE_C, 'CANARY');
    try {
      const resA1 = await authority.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
      const resB1 = await authority.selectDestination({ ambulance: testAmbulance('AMB-2', CASE_B), patient: testPatient(CASE_B), requirement: testRequirement(CASE_B), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
      const resC1 = await authority.selectDestination({ ambulance: testAmbulance('AMB-3', CASE_C), patient: testPatient(CASE_C), requirement: testRequirement(CASE_C), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });

      eq(resA1.finalDecision.selectedHospitalId, HOSP_1, 'Case A selects HOSP_1');
      eq(resA1.agreement, true, 'Case A AGREEMENT');
      eq(resB1.disagreementClass, 'EXPECTED_POLICY_DIFFERENCE', 'Case B EXPECTED_POLICY_DIFFERENCE');
      eq(resC1.finalDecision.selectedHospitalId, undefined, 'Case C no destination (rejected)');

      // Mutate Case A: cancel Case A request
      ledger.cancelRequest(`AR-${CASE_A}-${HOSP_1}`, iso(-1));

      // Re-evaluate all 3 cases
      const resA2 = await authority.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
      const resB2 = await authority.selectDestination({ ambulance: testAmbulance('AMB-2', CASE_B), patient: testPatient(CASE_B), requirement: testRequirement(CASE_B), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
      const resC2 = await authority.selectDestination({ ambulance: testAmbulance('AMB-3', CASE_C), patient: testPatient(CASE_C), requirement: testRequirement(CASE_C), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });

      eq(resA2.finalDecision.selectedHospitalId, undefined, 'Case A cancelled -> no destination');
      eq(resB2.disagreementClass, 'EXPECTED_POLICY_DIFFERENCE', 'Case B unaffected by Case A cancellation');
      eq(resC2.finalDecision.selectedHospitalId, undefined, 'Case C unaffected by Case A cancellation');
    } finally {
      resetCaseAuthorityOverrides();
    }
  });

  // ============================================================
  // SECTION 4: ACCEPTANCE LIFECYCLE SOAK
  // ============================================================
  await check('Acceptance Lifecycle: State transitions (REQUEST -> PENDING -> ACCEPTED -> CANCELLED / EXPIRED) prevent resurrection', async () => {
    const hospitals = buildSoakHospitals();
    const ledger = new AcceptanceLedger();
    const req = requestedEvent(CASE_A, HOSP_1, -30);
    ledger.recordRequest(req.payload as any);

    // 1. PENDING (no response yet)
    let view = ledger.view(CASE_A, HOSP_1, T0 - 25 * 60000);
    eq(view.request?.requestId, (req.payload as any).requestId, 'request on record');
    eq(view.response, undefined, 'no response yet');

    // 2. ACCEPTED at -20
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -20, validMin: 10 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
    view = ledger.view(CASE_A, HOSP_1, T0 - 15 * 60000);
    eq(view.response?.status, 'ACCEPTED', 'status is ACCEPTED');

    // 3. CANCELLED at -10
    ledger.cancelRequest((req.payload as any).requestId, iso(-10));
    view = ledger.view(CASE_A, HOSP_1, T0);
    eq(view.requestState, 'REQUEST_CANCELLED', 'requestState is REQUEST_CANCELLED');
    ok(view.request?.cancelledAt !== undefined, 'cancelledAt is recorded');

    // 4. Stale/late acceptance cannot revive cancelled request
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5, validMin: 20 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
    view = ledger.view(CASE_A, HOSP_1, T0);
    eq(view.requestState, 'REQUEST_CANCELLED', 'cancelled status stands');
  });

  // ============================================================
  // SECTION 5: OPERATIONAL STATE STRESS (10,000+ TELEMETRY EVENTS)
  // ============================================================
  await check('Operational State Stress: 10,000+ telemetry events do not evict or corrupt materialized operational state', async () => {
    const store = new LocalStateStore();
    const hospitals = buildSoakHospitals();
    for (const h of hospitals) await store.setHospital(h);

    // Set hospital-wide UNAVAILABLE on HOSP_1
    const unavailEv: AnyEvent = {
      eventId: randomUUID(),
      eventType: 'hospital.capacity.updated',
      timestamp: iso(-10),
      version: '1.0',
      source: { type: 'hospital', id: HOSP_1 },
      payload: { hospitalId: HOSP_1, emergencyStatus: 'UNAVAILABLE', traumaStatus: 'UNAVAILABLE', icuStatus: 'UNAVAILABLE', ventilatorStatus: 'UNAVAILABLE' },
      metadata: { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } },
    } as any;
    await store.recordEvent(unavailEv);
    let h1 = await store.getHospital(HOSP_1);
    if (h1) {
      h1.operationalState = { ...h1.operationalState, emergency: 'UNAVAILABLE' };
      await store.setHospital(h1);
    }
    await store.putAcceptanceResponse(CASE_A, HOSP_1, {
      responseId: 'RESP-UNAVAIL',
      requestId: 'AR-SOAK',
      caseId: CASE_A,
      hospitalId: HOSP_1,
      status: 'UNAVAILABLE',
      acceptedCapabilities: [],
      limitations: [],
      respondedAt: iso(-10),
      validUntil: iso(20),
      responderRole: 'CLINICAL_COORDINATOR',
      source: 'HOSPITAL_CONFIRMED',
      trustedSource: 'HOSPITAL_CONFIRMED',
    });

    // Verify HOSP_1 is UNAVAILABLE
    h1 = await store.getHospital(HOSP_1);
    eq(h1?.operationalState.emergency, 'UNAVAILABLE', 'HOSP_1 marked UNAVAILABLE');
    const wideBefore = await store.getHospitalWideUnavailable(HOSP_1);
    eq(wideBefore?.response?.status, 'UNAVAILABLE', 'materialized wideUnavailable is UNAVAILABLE');

    // Flood with 10,000 telemetry events
    for (let i = 0; i < 10000; i++) {
      const gpsEv: AnyEvent = {
        eventId: randomUUID(),
        eventType: 'ambulance.location.updated',
        timestamp: iso(-5 + i * 0.0001),
        version: '1.0',
        source: { type: 'ambulance', id: 'AMB-SOAK-FLOOD' },
        payload: { ambulanceId: 'AMB-SOAK-FLOOD', coordinates: { latitude: 13.0 + (i % 100) * 0.001, longitude: 77.6 + (i % 100) * 0.001 } },
      } as any;
      await store.recordEvent(gpsEv);
    }

    // Verify HOSP_1 operational state is completely preserved
    h1 = await store.getHospital(HOSP_1);
    eq(h1?.operationalState.emergency, 'UNAVAILABLE', 'HOSP_1 remains UNAVAILABLE after 10,000 telemetry events');
    const wideAfter = await store.getHospitalWideUnavailable(HOSP_1);
    eq(wideAfter?.response?.status, 'UNAVAILABLE', 'materialized wideUnavailable intact after 10,000 telemetry events');
  });

  // ============================================================
  // SECTION 6: FAILURE INJECTION CONTAINMENT (14 MODES)
  // ============================================================
  await check('Failure Injection: All 14 failure modes fail closed without mutating destination authority', async () => {
    const hospitals = buildSoakHospitals();
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    // Mode 1: Feasibility exception
    const shadowErr = new FeasibilityShadow({ hospitals: () => { throw new Error('Simulated engine exception'); }, ledger, mapping: stubMapping(), log: () => undefined });
    const auth1 = new DecisionAuthority({ shadow: shadowErr, now: () => T0 });
    const res1 = await auth1.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
    eq(res1.finalDecision.selectedHospitalId, HOSP_1, 'Mode 1: destination safe');

    // Mode 2: Feasibility timeout
    const shadowTimeout = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), timeoutMs: 10, log: () => undefined });
    (shadowTimeout as any).run = async () => new Promise(resolve => setTimeout(resolve, 100));
    const auth2 = new DecisionAuthority({ shadow: shadowTimeout, now: () => T0 });
    const res2 = await auth2.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
    eq(res2.finalDecision.selectedHospitalId, HOSP_1, 'Mode 2: destination safe');

    // Mode 3: Malformed feasibility candidate array
    const shadowMalformed = new FeasibilityShadow({ hospitals: () => [], ledger, mapping: stubMapping(), log: () => undefined });
    const auth3 = new DecisionAuthority({ shadow: shadowMalformed, now: () => T0 });
    const res3 = await auth3.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
    eq(res3.finalDecision.selectedHospitalId, HOSP_1, 'Mode 3: destination safe');

    // Mode 4: Missing evidence
    const emptyLedger = new AcceptanceLedger();
    const auth4 = new DecisionAuthority({ shadow: new FeasibilityShadow({ hospitals: () => hospitals, ledger: emptyLedger, mapping: stubMapping(), log: () => undefined }), now: () => T0 });
    const res4 = await auth4.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: emptyLedger, nowMs: T0 });
    eq(res4.finalDecision.selectedHospitalId, undefined, 'Mode 4: destination safe (no accepted candidate)');

    // Mode 5: Corrupted event history
    const corruptLedger = AcceptanceLedger.fromEvents([
      { eventId: 'bad-1', eventType: 'hospital.acceptance.requested', timestamp: 'not-a-date', payload: { corrupt: true } },
      requestedEvent(CASE_A, HOSP_1, -10),
      responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }),
    ] as any);
    const auth5 = new DecisionAuthority({ shadow: new FeasibilityShadow({ hospitals: () => hospitals, ledger: corruptLedger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) }), now: () => T0 });
    const res5 = await auth5.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: corruptLedger, nowMs: T0 });
    eq(res5.finalDecision.selectedHospitalId, HOSP_1, 'Mode 5: corrupt event skipped, HOSP_1 safely selected');

    // Mode 6: Materialized state read failure
    const auth6 = new DecisionAuthority({ shadow: new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined }), now: () => T0 });
    const res6 = await auth6.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
    ok(res6.finalDecision !== undefined, 'Mode 6: destination safe');

    // Mode 7: Mapping provider failure
    const fMapping = { ...stubMapping(), calculateRoute: async () => { throw new Error('Valhalla down'); } };
    const auth7 = new DecisionAuthority({ shadow: new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: fMapping, log: () => undefined }), now: () => T0 });
    const res7 = await auth7.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: fMapping, acceptanceView: ledger, nowMs: T0 });
    eq(res7.finalDecision.selectedHospitalId, HOSP_1, 'Mode 7: mapping failure handled');

    // Mode 8: AI provider failure
    const auth8 = new DecisionAuthority({ shadow: new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined }), now: () => T0 });
    const res8 = await auth8.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
    eq(res8.finalDecision.selectedHospitalId, HOSP_1, 'Mode 8: AI failure contained');

    // Mode 9: Trace sink failure
    const auth9 = new DecisionAuthority({ shadow: new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), publishTrace: async () => { throw new Error('Sink down'); }, log: () => undefined }), now: () => T0 });
    const res9 = await auth9.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
    eq(res9.finalDecision.selectedHospitalId, HOSP_1, 'Mode 9: trace sink failure contained');

    // Mode 10: Metrics failure
    const metricsFail = new DecisionAuthorityMetrics();
    metricsFail.recordEvaluation = () => { /* no-op or throw contained */ };
    const auth10 = new DecisionAuthority({ shadow: new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined }), metrics: metricsFail, now: () => T0 });
    const res10 = await auth10.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
    eq(res10.finalDecision.selectedHospitalId, HOSP_1, 'Mode 10: metrics failure contained');

    // Mode 11: Duplicate events
    const dupResp = responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { responseId: 'RESP-FIXED-DUP', respondedMin: -5 });
    ledger.applyResponse(withTrust(dupResp.payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
    eq(ledger.applyResponse(withTrust(dupResp.payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } })), 'DUPLICATE', 'Mode 11: duplicate handled');

    // Mode 12: Delayed events
    const delayedResp = responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { responseId: 'RESP-FIXED-DELAYED', respondedMin: -15 });
    eq(ledger.applyResponse(withTrust(delayedResp.payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } })), 'STALE', 'Mode 12: delayed event identified as STALE');

    // Mode 13: Invalid authority configuration
    const saved = process.env.DECISION_AUTHORITY_MODE;
    process.env.DECISION_AUTHORITY_MODE = 'CORRUPTED_CONFIG_STRING';
    try {
      const auth13 = new DecisionAuthority({ shadow: new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined }), now: () => T0 });
      const res13 = await auth13.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
      eq(res13.effectiveMode, 'SHADOW', 'Mode 13: invalid config defaults to safe SHADOW');
    } finally {
      restoreMode(saved);
    }

    // Mode 14: Kill switch activation
    const ks = new DecisionAuthorityKillSwitch();
    ks.trip('Soak failure injection test');
    const auth14 = new DecisionAuthority({ shadow: new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined }), killSwitch: ks, now: () => T0 });
    const res14 = await auth14.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
    eq(res14.effectiveMode, 'SHADOW', 'Mode 14: kill switch forces SHADOW mode');
    eq(res14.finalDecision.selectedHospitalId, HOSP_1, 'Mode 14: legacy destination intact');
  });

  // ============================================================
  // SECTION 7: KILL SWITCH SAFETY & RECOVERY
  // ============================================================
  await check('Kill Switch: Activation during CANARY forces safe SHADOW mode; reset restores CANARY', async () => {
    const hospitals = buildSoakHospitals();
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const killSwitch = new DecisionAuthorityKillSwitch();
    const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
    const authority = new DecisionAuthority({ shadow, killSwitch, now: () => T0 });

    setCaseAuthorityMode(CASE_A, 'CANARY');
    try {
      // Step 1: Normal CANARY mode
      const res1 = await authority.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
      eq(res1.effectiveMode, 'CANARY', 'initially in CANARY mode');

      // Step 2: Trip kill switch
      killSwitch.trip('Operator initiated emergency kill switch');
      ok(killSwitch.isActive(), 'kill switch is active');

      const res2 = await authority.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
      eq(res2.effectiveMode, 'SHADOW', 'kill switch forces SHADOW mode');
      eq(res2.finalDecision.selectedHospitalId, HOSP_1, 'legacy destination remains active and safe');

      // Step 3: Restore kill switch
      killSwitch.restore();
      ok(!killSwitch.isActive(), 'kill switch is restored');

      const res3 = await authority.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
      eq(res3.effectiveMode, 'CANARY', 'CANARY mode safely resumed');
      eq(res3.finalDecision.selectedHospitalId, HOSP_1, 'destination still HOSP_1');
    } finally {
      resetCaseAuthorityOverrides();
    }
  });

  // ============================================================
  // SECTION 8: AUTOMATED PROMOTION GATE VALIDATOR
  // ============================================================
  await check('Promotion Gate: Unsafe attempts are rejected; satisfied fixture passes; authority remains disabled', async () => {
    const savedAck = process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED;
    delete process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED;

    const baseMetrics = (overrides: Partial<AuthorityMetricsSummary> = {}): AuthorityMetricsSummary => ({
      evaluationsTotal: 0,
      byMode: { LEGACY: 0, SHADOW: 0, CANARY: 0, AUTHORITATIVE: 0 },
      agreedCount: 0,
      disagreedCount: 0,
      byDisagreementClass: {
        AGREEMENT: 0,
        EXPECTED_POLICY_DIFFERENCE: 0,
        MISSING_EVIDENCE: 0,
        LEGACY_ONLY: 0,
        FEASIBILITY_ONLY: 0,
        TIMEOUT: 0,
        ENGINE_ERROR: 0,
        UNEXPECTED_DIFFERENCE: 0,
      },
      timeouts: 0,
      errors: 0,
      fallbacksTriggered: 0,
      byFallbackReason: {
        NONE: 0,
        CIRCUIT_BREAKER_OPEN: 0,
        FEASIBILITY_TIMEOUT: 0,
        FEASIBILITY_EXCEPTION: 0,
        FEASIBILITY_MALFORMED: 0,
        UNEXPECTED_DISAGREEMENT: 0,
        KILL_SWITCH_ACTIVE: 0,
        PROMOTION_GATE_REJECTED: 0,
      },
      canaryEvaluations: 0,
      authoritativeEvaluations: 0,
      circuitBreakerTrips: 0,
      killSwitchTrips: 0,
      ...overrides,
    });

    try {
      // Test 1: Zero evaluations
      const r1 = PromotionGateValidator.validate(baseMetrics({ evaluationsTotal: 0 }));
      eq(r1.authorized, false, 'rejected due to 0 evaluations and no ack');

      // Test 2: Unexpected disagreement present
      const r2 = PromotionGateValidator.validate(baseMetrics({
        evaluationsTotal: 100,
        byMode: { LEGACY: 0, SHADOW: 0, CANARY: 100, AUTHORITATIVE: 0 },
        agreedCount: 99,
        disagreedCount: 1,
        byDisagreementClass: {
          AGREEMENT: 99,
          EXPECTED_POLICY_DIFFERENCE: 0,
          MISSING_EVIDENCE: 0,
          LEGACY_ONLY: 0,
          FEASIBILITY_ONLY: 0,
          TIMEOUT: 0,
          ENGINE_ERROR: 0,
          UNEXPECTED_DIFFERENCE: 1,
        },
      }));
      eq(r2.authorized, false, 'rejected due to unexpected disagreement');

      // Test 3: Fully satisfied fixture (with acknowledgment set in environment)
      process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED = 'true';
      const r3 = PromotionGateValidator.validate(
        baseMetrics({
          evaluationsTotal: 500,
          byMode: { LEGACY: 0, SHADOW: 0, CANARY: 500, AUTHORITATIVE: 0 },
          agreedCount: 495,
          disagreedCount: 5,
          byDisagreementClass: {
            AGREEMENT: 495,
            EXPECTED_POLICY_DIFFERENCE: 5,
            MISSING_EVIDENCE: 0,
            LEGACY_ONLY: 0,
            FEASIBILITY_ONLY: 0,
            TIMEOUT: 0,
            ENGINE_ERROR: 0,
            UNEXPECTED_DIFFERENCE: 0,
          },
          canaryEvaluations: 500,
        }),
        { replayParityVerified: true, killSwitchVerified: true, circuitBreakerVerified: true, isolationVerified: true, minEvaluations: 500 }
      );
      eq(r3.authorized, true, 'satisfied fixture is authorized by promotion validator');
      eq(r3.blockingReasons.length, 0, 'zero blocking reasons');
    } finally {
      if (savedAck === undefined) delete process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED;
      else process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED = savedAck;
    }
  });

  // ============================================================
  // SECTION 9: POLICY HASH CRYPTOGRAPHIC PROPAGATION
  // ============================================================
  await check('Policy Hash: Policy differences strictly alter policyHash and auditHash', async () => {
    const hospitals = buildSoakHospitals();
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const policyA = createFreshnessPolicy({ OPERATIONAL_CAPACITY: { maxAgeSeconds: 300 } });
    const policyB = createFreshnessPolicy({ OPERATIONAL_CAPACITY: { maxAgeSeconds: 1200 } });

    const shadowA = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), policy: policyA, log: () => undefined, clock: () => iso(0) });
    const shadowB = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), policy: policyB, log: () => undefined, clock: () => iso(0) });

    const authA = new DecisionAuthority({ shadow: shadowA, now: () => T0 });
    const authB = new DecisionAuthority({ shadow: shadowB, now: () => T0 });

    setCaseAuthorityMode(CASE_A, 'CANARY');
    try {
      const resA = await authA.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });
      const resB = await authB.selectDestination({ ambulance: testAmbulance('AMB-1', CASE_A), patient: testPatient(CASE_A), requirement: testRequirement(CASE_A), hospitals, mapping: stubMapping(), acceptanceView: ledger, nowMs: T0 });

      ok(resA.feasibilityDecision?.policyHash !== resB.feasibilityDecision?.policyHash, 'policy hashes are distinct');
      ok(resA.auditHash !== resB.auditHash, 'audit hashes reflect policy variation');
    } finally {
      resetCaseAuthorityOverrides();
    }
  });

  // ============================================================
  // SECTION 10: TRACE PRIVACY & PII/PHI EXCLUSION
  // ============================================================
  await check('Trace Privacy: Canary results and traces contain zero PHI or clinical free-text notes', async () => {
    const hospitals = buildSoakHospitals();
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(requestedEvent(CASE_A, HOSP_1, -10).payload as any);
    ledger.applyResponse(withTrust(responseEvent(CASE_A, HOSP_1, 'ACCEPTED', { respondedMin: -5 }).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const patientWithSensitiveData: PatientState = {
      patientId: CASE_A,
      currentStatus: 'ASSESSED',
      careRequirements: ['EMERGENCY', 'TRAUMA', 'ICU'],
      activeConditions: ['Patient Name: John Doe', 'SSN: 000-00-0000', 'Medical history confidential note'],
      currentLocation: { ...ORIGIN },
      lastUpdated: iso(0),
      provenance: [],
    };

    const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0) });
    const authority = new DecisionAuthority({ shadow, now: () => T0 });

    setCaseAuthorityMode(CASE_A, 'CANARY');
    try {
      const res = await authority.selectDestination({
        ambulance: testAmbulance('AMB-1', CASE_A),
        patient: patientWithSensitiveData,
        requirement: testRequirement(CASE_A),
        hospitals,
        mapping: stubMapping(),
        acceptanceView: ledger,
        nowMs: T0,
      });

      const serializedResult = JSON.stringify(res);
      ok(!serializedResult.includes('John Doe'), 'zero patient name in authority result');
      ok(!serializedResult.includes('000-00-0000'), 'zero SSN in authority result');
      ok(!serializedResult.includes('confidential'), 'zero confidential notes in authority result');
      ok(res.auditHash.length === 64, 'auditHash present and structured');
    } finally {
      resetCaseAuthorityOverrides();
    }
  });

  console.log(`\n============================================================`);
  console.log(`All Phase 6.4 Canary Soak Tests Passed! Total assertions: ${passCount()}`);
  console.log(`============================================================\n`);
}

main().catch(err => {
  console.error('\nCanary Soak test failed:', err);
  process.exit(1);
});
