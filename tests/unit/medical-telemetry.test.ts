/**
 * Phase 10 — medical telemetry: validated values and units, freshness, latest-per-type, the demo-only
 * simulated monitor, and the (not yet integrated) medical-device ingestion contract.
 */
import { DeviceObservationBatchSchema, MeasurementInputSchema, RecordTelemetryCommandSchema } from '../../packages/event-schema/src';
import {
  checkDeviceBatch, freshnessOf, latestByType, measurementsFromInputs, NO_DEVICE_REGISTRY, observationTimeProblem, simulatedReading, simulationAllowed,
  type DeviceRegistry,
} from '../../services/api/src/clinical/telemetry';
import { check, eq, ok, run } from './helpers/assert';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const valid = (o: Record<string, unknown>) => MeasurementInputSchema.safeParse(o).success;
const ctx = { batchId: 'VB-TEST01', encounterId: 'ENC-1', caseId: 'CASE-1', hospitalId: 'HOSP-BLR-001', source: 'MANUAL_CLINICIAN' as const, recordedAt: at(0), dataStatus: 'SYNTHETIC_DEMO' as const };

run('Phase 10 — medical telemetry', async () => {
  await check('values and units are validated per measurement type', () => {
    ok(valid({ type: 'HEART_RATE', value: 88, unit: 'bpm', observedAt: at(0) }), 'heart rate');
    ok(!valid({ type: 'HEART_RATE', value: 400, unit: 'bpm', observedAt: at(0) }), 'implausible heart rate');
    ok(!valid({ type: 'SPO2', value: 101, unit: '%', observedAt: at(0) }), 'SpO2 above 100');
    ok(!valid({ type: 'TEMPERATURE', value: 98.6, unit: 'degF', observedAt: at(0) }), 'wrong unit');
    ok(!valid({ type: 'BLOOD_PRESSURE', value: 80, secondaryValue: 90, unit: 'mmHg', observedAt: at(0) }), 'systolic below diastolic');
    ok(!valid({ type: 'BLOOD_GLUCOSE', value: 5, unit: 'mmol/L', observedAt: at(0) }), 'unknown type');
    ok(!RecordTelemetryCommandSchema.safeParse({ clientRequestId: '6f1c4e1e-8a51-4b3f-9a4c-0d6f3d2b1a90', measurements: [{ type: 'SPO2', value: 97, unit: '%', observedAt: at(0), source: 'MEDICAL_DEVICE' }] }).success, 'a client cannot claim a source');
    ok(!RecordTelemetryCommandSchema.safeParse({ clientRequestId: '6f1c4e1e-8a51-4b3f-9a4c-0d6f3d2b1a90', source: 'MEDICAL_DEVICE', measurements: [{ type: 'SPO2', value: 97, unit: '%', observedAt: at(0) }] }).success, '…not even at the top level');
  });

  await check('observation times: not in the future, not older than 24 hours', () => {
    eq(observationTimeProblem([{ type: 'SPO2', value: 97, unit: '%', observedAt: at(5) }], NOW), 'observedAt is in the future', 'future');
    eq(observationTimeProblem([{ type: 'SPO2', value: 97, unit: '%', observedAt: at(-25 * 60) }], NOW), 'observedAt is more than 24 hours ago', 'old');
    eq(observationTimeProblem([{ type: 'SPO2', value: 97, unit: '%', observedAt: at(-30) }], NOW), undefined, 'plausible');
  });

  await check('freshness: current up to 15 min, recent up to 2 h, then old', () => {
    eq(freshnessOf(at(-5), NOW), { ageSeconds: 300, freshness: 'FRESH' }, '5 min');
    eq(freshnessOf(at(-60), NOW).freshness, 'RECENT', '1 h');
    eq(freshnessOf(at(-180), NOW).freshness, 'OLD', '3 h');
  });

  await check('a batch keeps the source the server decided, and the latest value per type wins', () => {
    const batch = measurementsFromInputs([
      { type: 'HEART_RATE', value: 90, unit: 'bpm', observedAt: at(-20) },
      { type: 'HEART_RATE', value: 84, unit: 'bpm', observedAt: at(-2) },
      { type: 'BLOOD_PRESSURE', value: 128, secondaryValue: 84, unit: 'mmHg', observedAt: at(-2) },
    ], ctx);
    eq(batch.map(m => [m.measurementId, m.source, m.encounterId]), [['VB-TEST01-1', 'MANUAL_CLINICIAN', 'ENC-1'], ['VB-TEST01-2', 'MANUAL_CLINICIAN', 'ENC-1'], ['VB-TEST01-3', 'MANUAL_CLINICIAN', 'ENC-1']], 'ids and source');
    const latest = latestByType(batch, NOW);
    eq([latest.HEART_RATE?.value, latest.HEART_RATE?.freshness, latest.BLOOD_PRESSURE?.secondaryValue, latest.SPO2], [84, 'FRESH', 84, undefined], 'latest; nothing invented for missing types');
  });

  await check('the simulated monitor: demo mode only, deterministic, always within the validated ranges', () => {
    ok(simulationAllowed('DEMO') && !simulationAllowed('PRODUCTION'), 'gate');
    const a = simulatedReading('ENC-1|VB-1', new Date(NOW));
    eq(simulatedReading('ENC-1|VB-1', new Date(NOW)), a, 'same seed, same reading');
    ok(JSON.stringify(simulatedReading('ENC-1|VB-2', new Date(NOW))) !== JSON.stringify(a), 'another seed, another reading');
    for (let i = 0; i < 200; i++) {
      for (const m of simulatedReading(`seed-${i}`, new Date(NOW))) ok(MeasurementInputSchema.safeParse(m).success, `seed-${i} ${m.type} ${m.value}`);
    }
    eq(a.map(m => m.type), ['HEART_RATE', 'SPO2', 'BLOOD_PRESSURE', 'TEMPERATURE', 'RESPIRATORY_RATE'], 'one reading of each type');
  });

  await check('medical-device ingestion: a strict contract, refused while no device is integrated', () => {
    const batch = { deviceId: 'MON-7', sequence: 4, encounterId: 'ENC-1', measurements: [{ type: 'SPO2', value: 96, unit: '%', observedAt: at(0) }], sentAt: at(0) };
    ok(DeviceObservationBatchSchema.safeParse(batch).success, 'valid batch');
    ok(!DeviceObservationBatchSchema.safeParse({ ...batch, patientName: 'x' }).success, 'strict');
    const parsed = DeviceObservationBatchSchema.parse(batch);
    eq(checkDeviceBatch(parsed, NO_DEVICE_REGISTRY, NOW), { ok: false, code: 'NO_DEVICE_INTEGRATION' }, 'no registry today');
    const registry: DeviceRegistry = { binding: id => (id === 'MON-7' ? { deviceId: 'MON-7', hospitalId: 'HOSP-BLR-001', encounterId: 'ENC-1', lastSequence: 3 } : undefined) };
    eq(checkDeviceBatch(parsed, registry, NOW), { ok: true }, 'bound device, next sequence');
    eq(checkDeviceBatch({ ...parsed, encounterId: 'ENC-2' }, registry, NOW), { ok: false, code: 'NOT_BOUND_TO_ENCOUNTER' }, 'other encounter');
    eq(checkDeviceBatch({ ...parsed, sequence: 3 }, registry, NOW), { ok: false, code: 'REPLAYED_OR_OUT_OF_ORDER' }, 'replay');
    eq(checkDeviceBatch({ ...parsed, sentAt: at(30) }, registry, NOW), { ok: false, code: 'DEVICE_CLOCK_SKEW' }, 'clock skew');
  });
});
