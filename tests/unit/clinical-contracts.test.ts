/**
 * Phase 1 — canonical event contracts and command bodies for the emergency intake and the in-hospital
 * clinical domain. Verifies that:
 *  - every existing producer's events still validate (backward compatibility)
 *  - the new structured intake fields validate and keep symptoms separate from the suspected cause
 *  - encounter/clinical events validate, and are STRICT: clinical content (e.g. a medication name)
 *    cannot be smuggled into an event payload
 *  - command bodies reject unknown fields, out-of-range values and client-supplied provenance
 */
import { randomUUID } from 'crypto';
import {
  AnyEventSchema,
  AmendPrescriptionCommandSchema,
  AssignDoctorCommandSchema,
  CAPABILITY_CODES,
  CreatePrescriptionCommandSchema,
  CreateReportCommandSchema,
  DocumentUploadIntentCommandSchema,
  EmergencyIntakeCommandSchema,
  MAX_DOCUMENT_BYTES,
  RecordArrivalCommandSchema,
  RecordTelemetryCommandSchema,
} from '../../packages/event-schema/src';
import { CAPABILITY_KEY } from '../../packages/feasibility/src/capabilityMap';
import { check, eq, ok, run } from './helpers/assert';

const now = new Date().toISOString();
const env = (eventType: string, payload: unknown, source = { type: 'system', id: 'test' }, extra: object = {}) =>
  ({ eventId: randomUUID(), eventType, timestamp: now, version: '1.0', source, payload, ...extra });
const valid = (e: unknown) => AnyEventSchema.safeParse(e).success;
const issues = (e: unknown) => {
  const r = AnyEventSchema.safeParse(e);
  return r.success ? [] : r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
};

const location = { latitude: 13.0431, longitude: 77.5891 };
const actor = { userId: 'demo-doc-1', role: 'CLINICIAN', hospitalId: 'HOSP-BLR-004', practitionerId: 'PRAC-BLR-004-01' };
const hash = 'a'.repeat(64);
const ref = { encounterId: 'ENC-BLR-004-1A2B3C4D', caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-004', recordedAt: now, recordedBy: actor };

run('Phase 1 — event contracts and command bodies', async () => {
  // ---------------------------------------------------------------- emergency intake event
  await check('legacy patient.emergency.created (condition/location/severity only) still validates', () => {
    ok(valid(env('patient.emergency.created', { condition: 'Severe polytrauma', location, severity: 'CRITICAL' }, { type: 'system', id: 'dispatch' }, { patientId: 'CASE-1' })), 'legacy emergency');
  });

  await check('structured intake: symptoms and suspected cause are separate fields; text is trimmed', () => {
    const r = AnyEventSchema.safeParse(env('patient.emergency.created', {
      condition: 'Suspected: road traffic accident · Reported: chest pain',
      location, severity: 'HIGH',
      reportedSymptoms: ['  chest pain ', 'bleeding from left leg'],
      suspectedCause: 'Road traffic accident',
      requestedCapabilities: ['TRAUMA', 'ORTHOPAEDICS'],
      notes: 'Conscious, talking.',
      intake: { channel: 'AMBULANCE_CREW', locationMethod: 'MAP_PIN', locationAccuracyMeters: 25 },
    }, { type: 'ambulance', id: 'AMB-BLR-001' }));
    ok(r.success, `extended emergency: ${JSON.stringify(issues(r))}`);
    if (r.success && r.data.eventType === 'patient.emergency.created') {
      eq(r.data.payload.reportedSymptoms, ['chest pain', 'bleeding from left leg'], 'symptoms trimmed, order kept');
      eq(r.data.payload.suspectedCause, 'Road traffic accident', 'suspected cause kept separately');
    }
  });

  await check('intake fields are validated (unknown capability, empty/oversized lists, control chars, unknown intake keys)', () => {
    const base = { condition: 'x', location, severity: 'LOW' };
    ok(!valid(env('patient.emergency.created', { ...base, requestedCapabilities: ['TELEPORTATION'] })), 'unknown capability rejected');
    ok(!valid(env('patient.emergency.created', { ...base, reportedSymptoms: [] })), 'empty symptom list rejected');
    ok(!valid(env('patient.emergency.created', { ...base, reportedSymptoms: Array.from({ length: 21 }, (_, i) => `s${i}`) })), '21 symptoms rejected');
    ok(!valid(env('patient.emergency.created', { ...base, notes: 'bad\u0007bell' })), 'control character rejected');
    ok(!valid(env('patient.emergency.created', { ...base, notes: 'x'.repeat(1001) })), 'oversized notes rejected');
    ok(!valid(env('patient.emergency.created', { ...base, intake: { channel: 'AMBULANCE_CREW', locationMethod: 'MAP_PIN', reporterName: 'x' } })), 'unknown intake key rejected (strict)');
    ok(!valid(env('patient.emergency.created', { ...base, intake: { channel: 'AMBULANCE_CREW', locationMethod: 'GUESS' } })), 'unknown location method rejected');
  });

  await check('dispatch / arrival / requirement extensions are optional and enumerated', () => {
    const d = { ambulanceId: 'AMB-BLR-001', caseId: 'CASE-1', destination: location, estimatedEtaMinutes: 0 };
    ok(valid(env('ambulance.dispatched', d)), 'legacy dispatch');
    ok(valid(env('ambulance.dispatched', { ...d, assignmentBasis: 'REPORTED_BY_CREW' })), 'crew-reported assignment');
    ok(!valid(env('ambulance.dispatched', { ...d, assignmentBasis: 'SELF' })), 'unknown basis rejected');
    ok(valid(env('ambulance.arrived', { ambulanceId: 'AMB-BLR-001', hospitalId: 'HOSP-BLR-004', caseId: 'CASE-1' })), 'legacy arrival signal');
    ok(valid(env('ambulance.arrived', { ambulanceId: 'AMB-BLR-001', hospitalId: 'HOSP-BLR-004', basis: 'HOSPITAL_CONFIRMED' })), 'hospital-confirmed arrival signal');
    ok(valid(env('care.requirement.created', {
      requirementId: 'REQ-1', caseId: 'CASE-1', requiredCapabilities: ['EMERGENCY', 'TRAUMA'], optionalCapabilities: [], severity: 'HIGH', createdAt: now,
      capabilitySources: { ruleDerived: ['EMERGENCY'], reporterRequested: ['TRAUMA'] },
    })), 'requirement with capability sources');
  });

  await check('capability codes in the event contract match the feasibility capability map exactly', () => {
    eq([...CAPABILITY_CODES].sort(), Object.keys(CAPABILITY_KEY).sort(), 'capability code sets');
  });

  // ---------------------------------------------------------------- encounter / clinical events
  await check('encounter lifecycle events validate', () => {
    ok(valid(env('encounter.arrival.recorded', {
      encounterId: ref.encounterId, caseId: ref.caseId, hospitalId: ref.hospitalId, ambulanceId: 'AMB-BLR-001', referralRequestId: 'AR-1234abcd',
      arrivedAt: now, recordedBy: { userId: 'demo-hosp-4', role: 'HOSPITAL', hospitalId: 'HOSP-BLR-004' }, basis: 'HOSPITAL_CONFIRMED',
    }, { type: 'hospital', id: 'HOSP-BLR-004' })), 'arrival');
    ok(valid(env('encounter.handover.recorded', {
      encounterId: ref.encounterId, caseId: ref.caseId, hospitalId: ref.hospitalId, ambulanceId: 'AMB-BLR-001', handedOverAt: now,
      recordedBy: { userId: 'demo-hosp-4', role: 'HOSPITAL', hospitalId: 'HOSP-BLR-004' },
    }, { type: 'hospital', id: 'HOSP-BLR-004' })), 'handover');
    ok(valid(env('encounter.doctor.assigned', {
      encounterId: ref.encounterId, caseId: ref.caseId, hospitalId: ref.hospitalId, practitionerId: 'PRAC-BLR-004-01', reason: 'INITIAL_ASSIGNMENT', assignedAt: now,
      recordedBy: { userId: 'demo-hosp-4', role: 'HOSPITAL', hospitalId: 'HOSP-BLR-004' },
    }, { type: 'hospital', id: 'HOSP-BLR-004' })), 'doctor assignment');
  });

  await check('an arrival event can only be HOSPITAL_CONFIRMED (GPS never creates an encounter)', () => {
    ok(!valid(env('encounter.arrival.recorded', {
      encounterId: ref.encounterId, caseId: ref.caseId, hospitalId: ref.hospitalId, arrivedAt: now,
      recordedBy: { userId: 'telemetry-engine', role: 'SYSTEM' }, basis: 'GPS_GEOFENCE',
    })), 'GPS-based arrival rejected');
  });

  await check('clinical record events validate with references only', () => {
    ok(valid(env('clinical.prescription.recorded', { prescriptionId: 'RX-1', ...ref, version: 1, action: 'CREATED', status: 'ACTIVE', contentHash: hash, patientVisible: true }, { type: 'clinician', id: 'PRAC-BLR-004-01' })), 'prescription');
    ok(valid(env('clinical.report.recorded', { reportId: 'DR-1', ...ref, version: 1, action: 'CREATED', category: 'IMAGING', status: 'FINAL', documentCount: 1, contentHash: hash, patientVisible: false }, { type: 'clinician', id: 'PRAC-BLR-004-01' })), 'report');
    ok(valid(env('clinical.document.stored', { documentId: 'DOC-1', ...ref, category: 'ECG', contentType: 'application/pdf', sizeBytes: 2048, sha256: hash, patientVisible: true }, { type: 'clinician', id: 'PRAC-BLR-004-01' })), 'document');
    ok(valid(env('clinical.telemetry.recorded', { batchId: 'TEL-1', ...ref, source: 'MANUAL_CLINICIAN', measurementCount: 2, measurementTypes: ['HEART_RATE', 'SPO2'], observedFrom: now, observedTo: now, patientVisible: true }, { type: 'clinician', id: 'PRAC-BLR-004-01' })), 'telemetry');
  });

  await check('clinical events are strict: content cannot be smuggled into the bus (medication, values, findings, file data)', () => {
    const rx = { prescriptionId: 'RX-1', ...ref, version: 1, action: 'CREATED', status: 'ACTIVE', contentHash: hash, patientVisible: true };
    ok(!valid(env('clinical.prescription.recorded', { ...rx, medication: 'Morphine 10 mg' })), 'medication name rejected');
    ok(!valid(env('clinical.telemetry.recorded', { batchId: 'TEL-1', ...ref, source: 'MANUAL_CLINICIAN', measurementCount: 1, measurementTypes: ['HEART_RATE'], observedFrom: now, observedTo: now, patientVisible: true, values: [72] })), 'measurement values rejected');
    ok(!valid(env('clinical.report.recorded', { reportId: 'DR-1', ...ref, version: 1, action: 'CREATED', category: 'LABORATORY', status: 'FINAL', documentCount: 0, contentHash: hash, patientVisible: true, findings: 'Hb 9.1' })), 'findings rejected');
    ok(!valid(env('clinical.document.stored', { documentId: 'DOC-1', ...ref, category: 'ECG', contentType: 'application/pdf', sizeBytes: 10, sha256: hash, patientVisible: true, data: 'JVBERi0x' })), 'file content rejected');
    ok(!valid(env('clinical.prescription.recorded', { ...rx, recordedBy: { ...actor, name: 'Dr X' } })), 'extra actor field rejected');
  });

  await check('clinical events reject malformed hashes, versions, roles and missing actors', () => {
    const rx = { prescriptionId: 'RX-1', ...ref, version: 1, action: 'CREATED', status: 'ACTIVE', contentHash: hash, patientVisible: true };
    ok(!valid(env('clinical.prescription.recorded', { ...rx, contentHash: 'A'.repeat(64) })), 'uppercase hash rejected');
    ok(!valid(env('clinical.prescription.recorded', { ...rx, version: 0 })), 'version 0 rejected');
    ok(!valid(env('clinical.prescription.recorded', { ...rx, recordedBy: { userId: 'x', role: 'ROOT' } })), 'unknown actor role rejected');
    const { recordedBy: _omit, ...noActor } = rx;
    ok(!valid(env('clinical.prescription.recorded', noActor)), 'missing actor rejected');
    ok(!valid(env('clinical.prescription.recorded', { ...rx, caseId: '../../etc/passwd' })), 'unsafe identifier rejected');
    ok(!valid(env('clinical.telemetry.recorded', { batchId: 'TEL-1', ...ref, source: 'BROWSER', measurementCount: 1, measurementTypes: ['HEART_RATE'], observedFrom: now, observedTo: now, patientVisible: true })), 'unknown telemetry source rejected');
  });

  await check('unknown event types are still rejected by the discriminated union', () => {
    ok(!valid(env('clinical.record.deleted', { recordId: 'x' })), 'unknown type');
  });

  // ---------------------------------------------------------------- command bodies
  const intake = {
    clientRequestId: randomUUID(),
    location: { latitude: 13.0431, longitude: 77.5891, method: 'MAP_PIN' },
    severity: 'HIGH',
    reportedSymptoms: ['chest pain'],
  };

  await check('emergency intake command: minimal body valid; capabilities default to []', () => {
    const r = EmergencyIntakeCommandSchema.safeParse(intake);
    ok(r.success, 'minimal intake');
    if (r.success) eq(r.data.requiredCapabilities, [], 'default capabilities');
    ok(EmergencyIntakeCommandSchema.safeParse({ ...intake, caseRef: 'CASE-BLR-876', suspectedCause: 'Cardiac', requiredCapabilities: ['CARDIOLOGY'], notes: 'n' }).success, 'full intake');
  });

  await check('emergency intake command: rejects bad case refs, impossible coordinates, unknown fields and missing symptoms', () => {
    ok(!EmergencyIntakeCommandSchema.safeParse({ ...intake, caseRef: 'case-1; drop' }).success, 'bad case ref');
    ok(!EmergencyIntakeCommandSchema.safeParse({ ...intake, location: { ...intake.location, latitude: 95 } }).success, 'latitude out of range');
    ok(!EmergencyIntakeCommandSchema.safeParse({ ...intake, location: { ...intake.location, longitude: Number.NaN } }).success, 'NaN longitude');
    ok(!EmergencyIntakeCommandSchema.safeParse({ ...intake, patientName: 'Asha' }).success, 'identity fields are not accepted');
    ok(!EmergencyIntakeCommandSchema.safeParse({ ...intake, reportedSymptoms: [] }).success, 'at least one symptom');
    ok(!EmergencyIntakeCommandSchema.safeParse({ ...intake, clientRequestId: 'not-a-uuid' }).success, 'idempotency key must be a uuid');
  });

  await check('arrival / doctor commands: hospital and identity are never taken from the body', () => {
    ok(RecordArrivalCommandSchema.safeParse({ clientRequestId: randomUUID(), caseId: 'CASE-BLR-876' }).success, 'arrival');
    ok(!RecordArrivalCommandSchema.safeParse({ clientRequestId: randomUUID(), caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-001' }).success, 'hospitalId in body rejected');
    ok(!RecordArrivalCommandSchema.safeParse({ clientRequestId: randomUUID() }).success, 'caseId required');
    ok(AssignDoctorCommandSchema.safeParse({ clientRequestId: randomUUID(), practitionerId: 'PRAC-BLR-004-01' }).success, 'assignment');
    ok(!AssignDoctorCommandSchema.safeParse({ clientRequestId: randomUUID(), practitionerId: 'PRAC-BLR-004-01', assignedBy: 'demo-admin' }).success, 'actor in body rejected');
  });

  await check('prescription commands: required content, enumerated route, amendments need a reason and version', () => {
    const rx = { clientRequestId: randomUUID(), medication: 'Paracetamol', strength: '500 mg', dose: '1 tablet', route: 'ORAL', frequency: 'every 8 hours', duration: '3 days' };
    ok(CreatePrescriptionCommandSchema.safeParse(rx).success, 'create');
    const { dose: _d, ...noDose } = rx;
    ok(!CreatePrescriptionCommandSchema.safeParse(noDose).success, 'dose required');
    ok(!CreatePrescriptionCommandSchema.safeParse({ ...rx, route: 'TELEPATHIC' }).success, 'route enumerated');
    ok(!AmendPrescriptionCommandSchema.safeParse({ ...rx, expectedVersion: 1 }).success, 'amendment without reason rejected');
    ok(AmendPrescriptionCommandSchema.safeParse({ ...rx, expectedVersion: 1, changeReason: 'Dose adjusted for renal function' }).success, 'amendment');
  });

  await check('report command: bounded findings and attachment count', () => {
    const rep = { clientRequestId: randomUUID(), category: 'IMAGING', title: 'Chest X-ray', effectiveAt: now, status: 'FINAL', patientVisible: true };
    ok(CreateReportCommandSchema.safeParse(rep).success, 'report');
    ok(!CreateReportCommandSchema.safeParse({ ...rep, findings: 'x'.repeat(4001) }).success, 'findings bounded');
    ok(!CreateReportCommandSchema.safeParse({ ...rep, documentIds: Array.from({ length: 11 }, (_, i) => `DOC-${i}`) }).success, 'attachments bounded');
    ok(!CreateReportCommandSchema.safeParse({ ...rep, status: 'AMENDED' }).success, 'AMENDED is derived, not chosen');
  });

  await check('document upload intent: type allow-list, size limit, lowercase sha256', () => {
    const doc = { clientRequestId: randomUUID(), category: 'IMAGING', title: 'Chest X-ray', fileName: 'cxr.png', contentType: 'image/png', sizeBytes: 1024, sha256: hash, patientVisible: true };
    ok(DocumentUploadIntentCommandSchema.safeParse(doc).success, 'intent');
    ok(!DocumentUploadIntentCommandSchema.safeParse({ ...doc, contentType: 'text/html' }).success, 'html rejected');
    ok(!DocumentUploadIntentCommandSchema.safeParse({ ...doc, sizeBytes: MAX_DOCUMENT_BYTES + 1 }).success, 'too large');
    ok(!DocumentUploadIntentCommandSchema.safeParse({ ...doc, sizeBytes: 0 }).success, 'empty file');
    ok(!DocumentUploadIntentCommandSchema.safeParse({ ...doc, sha256: hash.toUpperCase() }).success, 'uppercase hash');
  });

  await check('telemetry command: unit must match the type, values must be plausible, source is never client-supplied', () => {
    const m = (x: object) => RecordTelemetryCommandSchema.safeParse({ clientRequestId: randomUUID(), measurements: [{ observedAt: now, ...x }] }).success;
    ok(m({ type: 'HEART_RATE', value: 72, unit: 'bpm' }), 'heart rate');
    ok(m({ type: 'BLOOD_PRESSURE', value: 120, secondaryValue: 80, unit: 'mmHg' }), 'blood pressure');
    ok(m({ type: 'TEMPERATURE', value: 37.2, unit: 'degC' }), 'temperature');
    ok(!m({ type: 'HEART_RATE', value: 72, unit: '%' }), 'wrong unit');
    ok(!m({ type: 'SPO2', value: 120, unit: '%' }), 'SpO2 above 100');
    ok(!m({ type: 'BLOOD_PRESSURE', value: 70, secondaryValue: 90, unit: 'mmHg' }), 'systolic below diastolic');
    ok(!m({ type: 'TEMPERATURE', value: 98.6, unit: 'degC' }), 'Fahrenheit value in Celsius field');
    ok(!m({ type: 'GLUCOSE', value: 5, unit: 'mmol/L' }), 'unsupported type');
    ok(!RecordTelemetryCommandSchema.safeParse({ clientRequestId: randomUUID(), source: 'MEDICAL_DEVICE', measurements: [{ type: 'HEART_RATE', value: 72, unit: 'bpm', observedAt: now }] }).success, 'client-supplied source rejected');
    ok(!RecordTelemetryCommandSchema.safeParse({ clientRequestId: randomUUID(), measurements: Array.from({ length: 21 }, () => ({ type: 'HEART_RATE', value: 72, unit: 'bpm', observedAt: now })) }).success, 'batch size bounded');
  });
});
