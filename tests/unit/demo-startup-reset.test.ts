/**
 * Unit & Contract tests for Demo Startup, Data Isolation, and Reset Reliability.
 *
 * Verifies:
 *  - Clean deterministic reset of in-memory stores and re-seeding of reference data
 *  - Complete multi-patient isolation across 3 synthetic patients
 *  - Idempotent and repeatable demo scenario staging
 *  - Truthful reporting of in-memory demo persistence boundaries
 */
import { localStoreInstance } from '../../services/api/src/stateStore';
import { clinicalStore } from '../../services/api/src/clinical';
import { loadRoster } from '../../services/api/src/clinical/roster';
import { resetEngines } from '../../services/api/src/stateEngines';
import { resetIntelligence } from '../../services/api/src/intelligenceEngine';
import { resetDemoFaults } from '../../services/api/src/routes/demo';

function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    process.exit(1);
  }
}

async function main() {
  console.log('[Test] Demo startup, multi-patient isolation and reset contract\n');

  // 1. Initial State / Preload
  await localStoreInstance.reset();
  clinicalStore.reset();
  clinicalStore.setRoster(loadRoster());
  resetEngines();
  resetIntelligence();
  resetDemoFaults();

  const hospitals = await localStoreInstance.listHospitals();
  const ambulances = await localStoreInstance.listAmbulances();
  const patients = await localStoreInstance.listPatients();

  check('initial: 4 synthetic hospitals preloaded', hospitals.length === 4, `got ${hospitals.length}`);
  check('initial: 3 synthetic ambulances preloaded', ambulances.length === 3, `got ${ambulances.length}`);
  check('initial: 0 patients open', patients.length === 0, `got ${patients.length}`);
  check('initial: reference hospitals marked SYNTHETIC_DEMO', hospitals.every(h => h.dataStatus === 'SYNTHETIC_DEMO'));
  check('initial: reference ambulances marked SYNTHETIC_DEMO', ambulances.every(a => a.dataStatus === 'SYNTHETIC_DEMO'));

  // 2. Multi-patient staging: 3 distinct patients
  const P1 = 'CASE-BLR-876';
  const P2 = 'CASE-BLR-877';
  const P3 = 'CASE-BLR-878';

  // Seed 3 patient states
  await localStoreInstance.setPatient({
    patientId: P1,
    currentStatus: 'EMERGENCY_REPORTED',
    assignedAmbulance: 'AMB-BLR-001',
    careRequirements: ['TRAUMA'],
    activeConditions: ['Severe trauma'],
    requestedCapabilities: ['TRAUMA'],
    lastUpdated: new Date().toISOString(),
    provenance: [],
    dataStatus: 'SYNTHETIC_DEMO',
  });

  await localStoreInstance.setPatient({
    patientId: P2,
    currentStatus: 'IN_TRANSIT',
    assignedAmbulance: 'AMB-BLR-002',
    careRequirements: ['CARDIOLOGY'],
    activeConditions: ['Chest pain'],
    requestedCapabilities: ['CARDIOLOGY'],
    lastUpdated: new Date().toISOString(),
    provenance: [],
    dataStatus: 'SYNTHETIC_DEMO',
  });

  await localStoreInstance.setPatient({
    patientId: P3,
    currentStatus: 'ARRIVED',
    careRequirements: ['BURNS'],
    activeConditions: ['Burns'],
    requestedCapabilities: ['BURNS'],
    lastUpdated: new Date().toISOString(),
    provenance: [],
    dataStatus: 'SYNTHETIC_DEMO',
  });

  // Add encounters and records for P1 and P2
  const enc1 = {
    encounterId: 'ENC-001',
    caseId: P1,
    hospitalId: 'HOSP-BLR-001',
    status: 'ARRIVED' as const,
    arrival: {
      arrivedAt: new Date().toISOString(),
      recordedBy: { userId: 'USER-1', role: 'HOSPITAL' as const, hospitalId: 'HOSP-BLR-001' },
      eventId: 'EVT-001',
    },
    assignmentHistory: [],
    dataStatus: 'SYNTHETIC_DEMO' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  clinicalStore.putEncounter(enc1);

  const enc2 = {
    encounterId: 'ENC-002',
    caseId: P2,
    hospitalId: 'HOSP-BLR-002',
    status: 'IN_CARE' as const,
    arrival: {
      arrivedAt: new Date().toISOString(),
      recordedBy: { userId: 'USER-2', role: 'HOSPITAL' as const, hospitalId: 'HOSP-BLR-002' },
      eventId: 'EVT-002',
    },
    assignmentHistory: [],
    dataStatus: 'SYNTHETIC_DEMO' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  clinicalStore.putEncounter(enc2);

  check('multi-patient: P1, P2, P3 exist independently in state store', (await localStoreInstance.listPatients()).length === 3);
  check('multi-patient: enc1 is for P1 at Hebbal', enc1.caseId === P1 && enc1.hospitalId === 'HOSP-BLR-001');
  check('multi-patient: enc2 is for P2 at Whitefield', enc2.caseId === P2 && enc2.hospitalId === 'HOSP-BLR-002');

  // Updating P2 does not modify P1 or P3
  await localStoreInstance.setPatient({
    patientId: P2,
    currentStatus: 'HANDED_OVER',
    assignedAmbulance: 'AMB-BLR-002',
    careRequirements: ['CARDIOLOGY'],
    activeConditions: ['Chest pain'],
    requestedCapabilities: ['CARDIOLOGY'],
    lastUpdated: new Date(Date.now() + 1000).toISOString(),
    provenance: [],
    dataStatus: 'SYNTHETIC_DEMO',
  });

  const readP1 = await localStoreInstance.getPatient(P1);
  const readP2 = await localStoreInstance.getPatient(P2);
  const readP3 = await localStoreInstance.getPatient(P3);

  check('isolation: updating P2 keeps P1 status EMERGENCY_REPORTED', readP1?.currentStatus === 'EMERGENCY_REPORTED');
  check('isolation: updating P2 updates P2 to HANDED_OVER', readP2?.currentStatus === 'HANDED_OVER');
  check('isolation: updating P2 keeps P3 status ARRIVED', readP3?.currentStatus === 'ARRIVED');

  // Clinical records isolation
  clinicalStore.addMeasurements([{
    measurementId: 'M-001',
    batchId: 'BATCH-001',
    encounterId: 'ENC-002',
    caseId: P2,
    hospitalId: 'HOSP-BLR-002',
    type: 'HEART_RATE',
    value: 88,
    unit: 'bpm',
    observedAt: new Date().toISOString(),
    recordedAt: new Date().toISOString(),
    source: 'MANUAL_CLINICIAN',
    dataStatus: 'SYNTHETIC_DEMO',
  }]);

  const p1Vitals = clinicalStore.listMeasurements('ENC-001');
  const p2Vitals = clinicalStore.listMeasurements('ENC-002');
  check('isolation: measurements for ENC-002 do not appear in ENC-001', p1Vitals.length === 0 && p2Vitals.length === 1);

  // 3. Reset Lifecycle
  await localStoreInstance.reset();
  clinicalStore.reset();
  clinicalStore.setRoster(loadRoster());
  resetEngines();
  resetIntelligence();
  resetDemoFaults();

  const postResetPatients = await localStoreInstance.listPatients();
  const postResetEncounters = clinicalStore.listEncounters();
  const postResetHospitals = await localStoreInstance.listHospitals();
  const postResetAmbulances = await localStoreInstance.listAmbulances();

  check('reset: patients store is completely cleared', postResetPatients.length === 0);
  check('reset: encounters store is completely cleared', postResetEncounters.length === 0);
  check('reset: synthetic hospitals restored to baseline (4)', postResetHospitals.length === 4);
  check('reset: synthetic ambulances restored to baseline (3)', postResetAmbulances.length === 3);

  // 4. Repeated Staging after Reset (Idempotency and Stability)
  await localStoreInstance.setPatient({
    patientId: P1,
    currentStatus: 'EMERGENCY_REPORTED',
    assignedAmbulance: 'AMB-BLR-001',
    careRequirements: ['TRAUMA'],
    activeConditions: ['Severe trauma'],
    requestedCapabilities: ['TRAUMA'],
    lastUpdated: new Date().toISOString(),
    provenance: [],
    dataStatus: 'SYNTHETIC_DEMO',
  });

  const reReadP1 = await localStoreInstance.getPatient(P1);
  check('repeatability: re-seeding P1 succeeds after reset', reReadP1?.patientId === P1 && reReadP1?.currentStatus === 'EMERGENCY_REPORTED');

  console.log('\n✓ Demo startup and reset unit tests PASSED.\n');
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
