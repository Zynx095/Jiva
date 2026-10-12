/**
 * Phase 11 — operational vs demo mode: one switch, no synthetic data in operational mode, labelled
 * synthetic data in demo mode, and a plain statement of what is (not) integrated.
 */
import { randomUUID } from 'crypto';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { provenanceReport, runtimeMode } from '../../services/api/src/mode';
import { loadRoster } from '../../services/api/src/clinical/roster';
import { patientFromEmergency, type DerivedRequirement } from '../../services/api/src/intake';
import { simulationAllowed } from '../../services/api/src/clinical/telemetry';
import type { PatientEmergencyCreated } from '../../packages/event-schema/src';
import { check, eq, ok, run } from './helpers/assert';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const OPERATIONAL = { JIVA_ENVIRONMENT: 'production', AWS_LAMBDA_FUNCTION_NAME: undefined, USE_CANONICAL: undefined };
const DEMO = { JIVA_ENVIRONMENT: 'demo', AWS_LAMBDA_FUNCTION_NAME: undefined, USE_CANONICAL: undefined };

const emergency: PatientEmergencyCreated = {
  eventId: randomUUID(), eventType: 'patient.emergency.created', timestamp: new Date().toISOString(), version: '1.0',
  source: { type: 'ambulance', id: 'AMB-BLR-001' },
  payload: { condition: 'Reported: chest pain', location: { latitude: 12.97, longitude: 77.59 }, severity: 'HIGH' },
} as PatientEmergencyCreated;
const requirement: DerivedRequirement = { required: ['EMERGENCY'], ruleDerived: ['EMERGENCY'], reporterRequested: [] };

run('Phase 11 — operational vs demo mode', async () => {
  await check('one switch: production (or AWS Lambda) is OPERATIONAL, anything else DEMO', () => {
    eq(withEnv({ JIVA_ENVIRONMENT: 'production', AWS_LAMBDA_FUNCTION_NAME: undefined }, runtimeMode), 'OPERATIONAL', 'production');
    eq(withEnv({ JIVA_ENVIRONMENT: 'prod', AWS_LAMBDA_FUNCTION_NAME: undefined }, runtimeMode), 'OPERATIONAL', 'prod');
    eq(withEnv({ JIVA_ENVIRONMENT: undefined, AWS_LAMBDA_FUNCTION_NAME: 'jiva-ingestion' }, runtimeMode), 'OPERATIONAL', 'on AWS Lambda');
    eq(withEnv({ JIVA_ENVIRONMENT: 'demo', AWS_LAMBDA_FUNCTION_NAME: 'x' }, runtimeMode), 'DEMO', 'explicit demo');
    eq(withEnv({ JIVA_ENVIRONMENT: undefined, AWS_LAMBDA_FUNCTION_NAME: undefined }, runtimeMode), 'DEMO', 'local default');
  });

  await check('operational mode loads no synthetic hospitals, ambulances or clinicians', async () => {
    await withEnvAsync(OPERATIONAL, async () => {
      const store = new LocalStateStore();
      await store.preloadData();
      eq([(await store.listHospitals()).length, (await store.listAmbulances()).length], [0, 0], 'empty network');
      eq(loadRoster().length, 0, 'no roster');
      ok(!simulationAllowed(), 'no simulated measurements');
    });
  });

  await check('demo mode loads the synthetic network, every element labelled SYNTHETIC_DEMO', async () => {
    await withEnvAsync(DEMO, async () => {
      const store = new LocalStateStore();
      await store.preloadData();
      const hospitals = await store.listHospitals();
      const ambulances = await store.listAmbulances();
      ok(hospitals.length === 4 && hospitals.every(h => h.dataStatus === 'SYNTHETIC_DEMO'), 'hospitals');
      ok(ambulances.length === 3 && ambulances.every(a => a.dataStatus === 'SYNTHETIC_DEMO'), 'ambulances');
      ok(loadRoster().length > 0 && loadRoster().every(p => p.dataStatus === 'SYNTHETIC_DEMO'), 'roster');
    });
  });

  await check('cases are marked as demo cases in demo mode only', () => {
    eq(withEnv(DEMO, () => patientFromEmergency(emergency, 'CASE-1', requirement).dataStatus), 'SYNTHETIC_DEMO', 'demo');
    eq(withEnv(OPERATIONAL, () => patientFromEmergency(emergency, 'CASE-1', requirement).dataStatus), undefined, 'operational');
  });

  await check('the provenance report states what is synthetic and that no live integration exists', () => {
    const inputs = { hospitals: 4, syntheticHospitals: 4, ambulances: 3, syntheticAmbulances: 3, clinicians: 7, mappingProvider: 'mock', mappingSynthetic: true, aiProvider: 'MockAIProvider' };
    const demo = withEnv(DEMO, () => provenanceReport(inputs));
    eq([demo.mode, demo.providers.auth, demo.providers.telemetry.simulator, demo.datasets.clinicians.dataStatus, demo.providers.mapping.synthetic, demo.providers.ai.synthetic], ['DEMO', 'DEMO_PERSONAS', true, 'SYNTHETIC_DEMO', true, true], 'demo');
    ok(/synthetic/i.test(demo.statement) && /Nothing shown is real/.test(demo.statement), 'demo statement');
    const op = withEnv(OPERATIONAL, () => provenanceReport({ ...inputs, hospitals: 0, syntheticHospitals: 0, ambulances: 0, syntheticAmbulances: 0, clinicians: 0 }));
    eq([op.mode, op.providers.auth, op.providers.telemetry.simulator, op.datasets.clinicians.dataStatus], ['OPERATIONAL', 'COGNITO_JWT', false, 'NONE'], 'operational');
    ok(Object.values(demo.liveIntegrations).every(v => v === false) && Object.values(op.liveIntegrations).every(v => v === false), 'no live integration is claimed in either mode');
  });
});
