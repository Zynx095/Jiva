/**
 * Correcting a manually entered vital sign: the original is never edited in place — it is withdrawn (with
 * who, when and why) and, for a correction, replaced by a new value of the same type and time. Withdrawn
 * values never count as the latest value; simulated readings cannot be corrected.
 */
import { randomUUID } from 'crypto';
import { ClinicalTelemetryRecordedSchema, CorrectMeasurementCommandSchema, MeasurementInputSchema } from '../../packages/event-schema/src';
import { LocalClinicalStore } from '../../services/api/src/clinical/store';
import { correctionRefusal, latestByType, measurementsFromInputs, replacementInput } from '../../services/api/src/clinical/telemetry';
import { check, eq, ok, run } from './helpers/assert';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const ctx = (batchId: string, source: 'MANUAL_CLINICIAN' | 'DEVICE_SIMULATED' = 'MANUAL_CLINICIAN') =>
  ({ batchId, encounterId: 'ENC-1', caseId: 'CASE-1', hospitalId: 'HOSP-BLR-001', source, recordedAt: at(0), dataStatus: 'SYNTHETIC_DEMO' as const });
const actor = { role: 'CLINICIAN' as const, userId: 'demo-doc-3', practitionerId: 'PRAC-BLR-001-01' };

run('Vital-sign corrections', async () => {
  await check('the command needs a reason; the replacement is optional (omitted = withdraw as entered in error)', () => {
    const id = randomUUID();
    ok(CorrectMeasurementCommandSchema.safeParse({ clientRequestId: id, reason: 'Typed 140 instead of 104', replacement: { value: 104 } }).success, 'correction');
    ok(CorrectMeasurementCommandSchema.safeParse({ clientRequestId: id, reason: 'Wrong patient' }).success, 'withdrawal');
    ok(!CorrectMeasurementCommandSchema.safeParse({ clientRequestId: id, replacement: { value: 104 } }).success, 'reason required');
    ok(!CorrectMeasurementCommandSchema.safeParse({ clientRequestId: id, reason: 'x', replacement: { value: 104 }, source: 'MEDICAL_DEVICE' }).success, 'no extra fields');
  });

  await check('a replacement keeps the type, unit, time and quality flag, and is checked against the same rules', () => {
    const [hr] = measurementsFromInputs([{ type: 'HEART_RATE', value: 140, unit: 'bpm', observedAt: at(-10), quality: 'QUESTIONABLE' }], ctx('VB-A'));
    const input = replacementInput(hr, { value: 104 });
    eq(input, { type: 'HEART_RATE', value: 104, unit: 'bpm', observedAt: at(-10), quality: 'QUESTIONABLE' }, 'same measurement, new value');
    ok(MeasurementInputSchema.safeParse(input).success, 'valid');
    ok(!MeasurementInputSchema.safeParse(replacementInput(hr, { value: 900 })).success, 'an implausible correction is refused too');
    const [bp] = measurementsFromInputs([{ type: 'BLOOD_PRESSURE', value: 128, secondaryValue: 84, unit: 'mmHg', observedAt: at(-10) }], ctx('VB-B'));
    ok(!MeasurementInputSchema.safeParse(replacementInput(bp, { value: 128 })).success, 'blood pressure needs both values');
    ok(MeasurementInputSchema.safeParse(replacementInput(bp, { value: 122, secondaryValue: 80 })).success, 'blood pressure correction');
  });

  await check('only hand-entered values can be corrected, and only once', () => {
    const [manual] = measurementsFromInputs([{ type: 'SPO2', value: 97, unit: '%', observedAt: at(-5) }], ctx('VB-C'));
    const [simulated] = measurementsFromInputs([{ type: 'SPO2', value: 97, unit: '%', observedAt: at(-5) }], ctx('VB-D', 'DEVICE_SIMULATED'));
    eq(correctionRefusal(manual), undefined, 'manual value');
    eq(correctionRefusal(simulated), 'NOT_CORRECTABLE', 'simulated reading');
    eq(correctionRefusal({ ...manual, withdrawn: { at: at(0), by: actor, reason: 'x' } }), 'ALREADY_WITHDRAWN', 'withdrawn');
  });

  await check('a withdrawn value stays in the history but is never the latest value', () => {
    const store = new LocalClinicalStore();
    const [wrong] = measurementsFromInputs([{ type: 'HEART_RATE', value: 140, unit: 'bpm', observedAt: at(-2) }], ctx('VB-E'));
    const [older] = measurementsFromInputs([{ type: 'HEART_RATE', value: 96, unit: 'bpm', observedAt: at(-30) }], ctx('VB-F'));
    store.addMeasurements([older, wrong]);
    eq(latestByType(store.listMeasurements('ENC-1'), NOW).HEART_RATE?.value, 140, 'before: the wrong value is latest');
    const updated = store.setMeasurementWithdrawn('ENC-1', wrong.measurementId, { at: at(0), by: actor, reason: 'Entered in error' });
    eq(updated?.withdrawn?.reason, 'Entered in error', 'marked with the reason');
    eq(store.listMeasurements('ENC-1').length, 2, 'nothing deleted');
    eq(latestByType(store.listMeasurements('ENC-1'), NOW).HEART_RATE?.value, 96, 'after: the previous valid value is latest');
    store.setMeasurementWithdrawn('ENC-1', wrong.measurementId, undefined);
    eq(store.listMeasurements('ENC-1').find(m => m.measurementId === wrong.measurementId)?.withdrawn, undefined, 'the mark can be undone (rollback when the event fails)');
    eq(store.setMeasurementWithdrawn('ENC-2', wrong.measurementId, { at: at(0), by: actor, reason: 'x' }), undefined, 'another encounter cannot reach it');
  });

  await check('the content-free event says what happened to which measurement', () => {
    const base = {
      eventId: randomUUID(), eventType: 'clinical.telemetry.recorded', timestamp: at(0), version: '1.0', source: { type: 'clinician', id: 'PRAC-BLR-001-01' },
      payload: { batchId: 'VB-G', encounterId: 'ENC-1', caseId: 'CASE-1', hospitalId: 'HOSP-BLR-001', recordedAt: at(0), recordedBy: actor, dataStatus: 'SYNTHETIC_DEMO', source: 'MANUAL_CLINICIAN', measurementCount: 1, measurementTypes: ['HEART_RATE'], observedFrom: at(-2), observedTo: at(-2), patientVisible: true },
    };
    ok(ClinicalTelemetryRecordedSchema.safeParse(base).success, 'plain record (legacy shape)');
    ok(ClinicalTelemetryRecordedSchema.safeParse({ ...base, payload: { ...base.payload, action: 'CORRECTED', corrects: 'VB-E-1' } }).success, 'correction');
    ok(!ClinicalTelemetryRecordedSchema.safeParse({ ...base, payload: { ...base.payload, action: 'EDITED' } }).success, 'unknown action');
  });
});
