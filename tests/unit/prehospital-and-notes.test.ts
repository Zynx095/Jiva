/**
 * Ambulance pre-hospital record (vital signs with time, source and quality, unavailable vital signs with a
 * reason, symptom narrative) and internal clinical notes: contracts, pure rules, the authorization matrix
 * and realtime delivery (content-free events, default deny).
 */
import { randomUUID } from 'crypto';
import { DEMO_USERS, type AuthContext } from '../../packages/auth/src';
import {
  AnyEventSchema, CreateClinicalNoteCommandSchema, EmergencyIntakeCommandSchema, PrehospitalClinicalSchema, RecordPrehospitalCommandSchema,
  type PrehospitalClinical,
} from '../../packages/event-schema/src';
import {
  authorizeEncounterAction, authorizePrehospitalAction, canReceiveClinicalDomainEvent, type EncounterFacts, type PrehospitalFacts,
} from '../../services/api/src/clinical/policy';
import {
  latestPrehospital, prehospitalEntry, prehospitalEventPayload, prehospitalTimeProblem, projectPrehospitalEntry, type EntryContext,
} from '../../services/api/src/clinical/prehospital';
import { amendNote, createNote, type RecordMeta } from '../../services/api/src/clinical/records';
import { check, eq, ok, run } from './helpers/assert';

const P = (id: string): AuthContext => DEMO_USERS[id];
const NOW = Date.parse('2026-10-13T10:00:00.000Z');
const T = (min: number) => new Date(NOW + min * 60_000).toISOString();
const crewActor = { userId: 'demo-amb-2', role: 'AMBULANCE' as const, ambulanceId: 'AMB-BLR-002' };
const ctx = (o: Partial<EntryContext> = {}): EntryContext => ({
  entryId: 'PH-000000000001', caseId: 'CASE-BLR-876', ambulanceId: 'AMB-BLR-002', recordedAt: T(0), recordedBy: crewActor, source: 'MANUAL_CREW', dataStatus: 'SYNTHETIC_DEMO', eventId: randomUUID(), ...o,
});
const input = (o: Partial<PrehospitalClinical> = {}): PrehospitalClinical => ({
  measurements: [
    { type: 'HEART_RATE', value: 118, unit: 'bpm', observedAt: T(-5) },
    { type: 'SPO2', value: 91, unit: '%', observedAt: T(-5), quality: 'QUESTIONABLE' },
  ],
  unavailable: [{ type: 'BLOOD_PRESSURE', reason: 'EQUIPMENT_UNAVAILABLE' }],
  symptomDescription: 'Crushing chest pain radiating to the left arm, sweating.',
  symptomOnsetAt: T(-40),
  ...o,
});

const ENC: EncounterFacts = { encounterId: 'ENC-1', caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-004', status: 'IN_CARE', assignedPractitionerId: 'PRAC-BLR-004-01' };
const facts = (o: Partial<PrehospitalFacts> = {}): PrehospitalFacts => ({ caseId: 'CASE-BLR-876', attendingAmbulanceId: 'AMB-BLR-002', encounters: [ENC], ...o });
const decide = (persona: string, action: 'prehospital.write' | 'prehospital.read', f = facts()) => {
  const d = authorizePrehospitalAction(P(persona), f, action);
  return d.allowed ? 'ALLOW' : `${d.status}:${d.code}`;
};

run('Pre-hospital record and clinical notes', async () => {
  await check('contracts: vital signs with ranges and an optional quality flag, unavailable ones with a reason, a narrative', () => {
    ok(PrehospitalClinicalSchema.safeParse(input()).success, 'complete record');
    ok(PrehospitalClinicalSchema.safeParse({ symptomOnsetAt: T(-10) }).success, 'onset time alone');
    ok(!PrehospitalClinicalSchema.safeParse({}).success, 'empty record refused');
    ok(!PrehospitalClinicalSchema.safeParse(input({ unavailable: [{ type: 'HEART_RATE', reason: 'NOT_MEASURED' }] })).success, 'measured and unavailable at once');
    ok(!PrehospitalClinicalSchema.safeParse(input({ unavailable: [{ type: 'TEMPERATURE', reason: 'NOT_MEASURED' }, { type: 'TEMPERATURE', reason: 'UNABLE_TO_OBTAIN' }] })).success, 'listed twice');
    ok(!PrehospitalClinicalSchema.safeParse(input({ measurements: [{ type: 'SPO2', value: 91, unit: '%', observedAt: T(0), quality: 'GOOD' } as never] })).success, 'unknown quality');
    ok(!PrehospitalClinicalSchema.safeParse(input({ measurements: [{ type: 'HEART_RATE', value: 900, unit: 'bpm', observedAt: T(0) }] })).success, 'implausible value');
    ok(!PrehospitalClinicalSchema.safeParse({ ...input(), source: 'MEDICAL_DEVICE' }).success, 'a client cannot claim a source');
    ok(!PrehospitalClinicalSchema.safeParse({ ...input(), unavailable: [{ type: 'SPO2', reason: 'BROKEN' }] }).success, 'unknown reason');
    ok(!RecordPrehospitalCommandSchema.safeParse(input()).success, 'the en-route command needs an idempotency key');
    ok(RecordPrehospitalCommandSchema.safeParse({ clientRequestId: randomUUID(), ...input() }).success, 'en-route command');
    const intake = { clientRequestId: randomUUID(), location: { latitude: 13.04, longitude: 77.59, method: 'MAP_PIN' }, severity: 'HIGH', reportedSymptoms: ['Chest pain'] };
    ok(EmergencyIntakeCommandSchema.safeParse({ ...intake, clinical: input() }).success, 'intake with a clinical record');
    ok(!EmergencyIntakeCommandSchema.safeParse({ ...intake, clinical: {} }).success, 'intake with an empty clinical record');
  });

  await check('entries keep values, times, quality and reasons; times must be plausible', () => {
    const e = prehospitalEntry(input(), ctx());
    eq(e.observations.map(o => [o.type, o.status, o.value ?? null, o.quality ?? null, o.unavailableReason ?? null]),
      [['HEART_RATE', 'MEASURED', 118, null, null], ['SPO2', 'MEASURED', 91, 'QUESTIONABLE', null], ['BLOOD_PRESSURE', 'NOT_AVAILABLE', null, null, 'EQUIPMENT_UNAVAILABLE']], 'observations');
    eq([e.source, e.symptomOnsetAt, e.dataStatus], ['MANUAL_CREW', T(-40), 'SYNTHETIC_DEMO'], 'source, onset, provenance');
    eq(prehospitalTimeProblem(input(), NOW), undefined, 'plausible');
    eq(prehospitalTimeProblem(input({ measurements: [{ type: 'HEART_RATE', value: 80, unit: 'bpm', observedAt: T(5) }] }), NOW), 'observedAt is in the future', 'future observation');
    eq(prehospitalTimeProblem(input({ measurements: [{ type: 'HEART_RATE', value: 80, unit: 'bpm', observedAt: T(-25 * 60) }] }), NOW), 'observedAt is more than 24 hours ago', 'stale observation');
    eq(prehospitalTimeProblem(input({ symptomOnsetAt: T(10) }), NOW), 'symptomOnsetAt is in the future', 'future onset');
    eq(prehospitalTimeProblem(input({ symptomOnsetAt: T(-31 * 24 * 60) }), NOW), 'symptomOnsetAt is more than 30 days ago', 'onset bound');
  });

  await check('latest value per type comes from measured values only (an unavailable reading never hides a value)', () => {
    const first = prehospitalEntry(input(), ctx());
    const later = prehospitalEntry({ measurements: [{ type: 'HEART_RATE', value: 104, unit: 'bpm', observedAt: T(-1) }], unavailable: [{ type: 'SPO2', reason: 'UNABLE_TO_OBTAIN' }] }, ctx({ entryId: 'PH-000000000002', recordedAt: T(0) }));
    const latest = latestPrehospital([first, later], NOW);
    eq([latest.HEART_RATE?.value, latest.SPO2?.value, latest.SPO2?.quality, latest.BLOOD_PRESSURE], [104, 91, 'QUESTIONABLE', undefined], 'latest');
    eq(latest.HEART_RATE?.freshness, 'FRESH', 'freshness');
  });

  await check('events and projections: counts, types and times only; the crew member is never named', () => {
    const e = prehospitalEntry(input(), ctx());
    const payload = prehospitalEventPayload(e);
    eq([payload.measurementCount, payload.measurementTypes, payload.unavailableCount, payload.narrative, payload.observedFrom], [2, ['HEART_RATE', 'SPO2'], 1, true, T(-5)], 'payload');
    const event = { eventId: randomUUID(), eventType: 'clinical.prehospital.recorded', timestamp: T(0), version: '1.0', source: { type: 'ambulance', id: 'AMB-BLR-002' }, patientId: 'CASE-BLR-876', payload };
    ok(AnyEventSchema.safeParse(event).success, 'valid canonical event');
    ok(!JSON.stringify(event).includes('118') && !JSON.stringify(event).includes('Crushing'), 'no value and no narrative in the event');
    ok(!AnyEventSchema.safeParse({ ...event, payload: { ...payload, values: [118] } }).success, 'values refused by the contract');
    ok(!AnyEventSchema.safeParse({ ...event, payload: { ...payload, symptomDescription: 'x' } }).success, 'narrative refused by the contract');
    const projected = projectPrehospitalEntry(e);
    eq(projected.recordedBy, { role: 'AMBULANCE', ambulanceId: 'AMB-BLR-002' }, 'unit, not the user');
    ok(!('eventId' in projected), 'internal ids dropped');
  });

  await check('authorization: the attending crew writes; crew, assigned clinician and patient read; others 403/404', () => {
    eq(['write', 'read'].map(a => decide('demo-amb-2', `prehospital.${a}` as never)), ['ALLOW', 'ALLOW'], 'attending crew');
    eq(decide('demo-amb-2', 'prehospital.write', facts({ attendingAmbulanceId: undefined })), '404:NOT_FOUND', 'released after the handover');
    eq(decide('demo-amb-1', 'prehospital.read'), '404:NOT_FOUND', 'another crew');
    eq([decide('demo-doc-1', 'prehospital.read'), decide('demo-doc-1', 'prehospital.write')], ['ALLOW', '403:ATTENDING_CREW_ONLY'], 'assigned clinician');
    eq(decide('demo-doc-2', 'prehospital.read'), '404:NOT_FOUND', 'unassigned clinician of the same hospital');
    eq(decide('demo-doc-3', 'prehospital.read'), '404:NOT_FOUND', 'clinician of another hospital');
    eq([decide('demo-patient-1', 'prehospital.read'), decide('demo-patient-1', 'prehospital.write')], ['ALLOW', '403:ATTENDING_CREW_ONLY'], 'own patient');
    eq(decide('demo-patient-2', 'prehospital.read'), '404:NOT_FOUND', 'another patient');
    eq(decide('demo-hosp-4', 'prehospital.read'), '403:NO_CLINICAL_ACCESS', 'coordinator of the receiving hospital');
    eq(decide('demo-hosp-1', 'prehospital.read'), '404:NOT_FOUND', 'coordinator of another hospital');
    eq([decide('demo-mgmt-1', 'prehospital.read'), decide('demo-admin', 'prehospital.read')], ['403:NO_CLINICAL_ACCESS', '403:NO_CLINICAL_ACCESS'], 'network coordination and administrators');
  });

  await check('delivery: the recording crew, the patient and the assigned clinician only', () => {
    const payload = prehospitalEventPayload(prehospitalEntry(input(), ctx()));
    const event = { eventType: 'clinical.prehospital.recorded', payload };
    const receives = (id: string) => canReceiveClinicalDomainEvent(P(id), event, () => undefined, c => (c === 'CASE-BLR-876' ? [ENC] : []));
    eq(['demo-amb-2', 'demo-patient-1', 'demo-doc-1'].map(receives), [true, true, true], 'recipients');
    eq(['demo-amb-1', 'demo-patient-2', 'demo-doc-2', 'demo-doc-3', 'demo-hosp-4', 'demo-mgmt-1', 'demo-admin'].map(receives), [false, false, false, false, false, false, false], 'everyone else');
    eq(canReceiveClinicalDomainEvent(P('demo-doc-1'), event, () => undefined), false, 'no case lookup → default deny');
  });

  await check('clinical notes: versioned, append-only, internal to the care team (patients get 403, others 403/404)', () => {
    const meta = (min: number): RecordMeta => ({ encounterId: 'ENC-1', caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-004', actor: { userId: 'demo-doc-1', role: 'CLINICIAN', hospitalId: 'HOSP-BLR-004', practitionerId: 'PRAC-BLR-004-01' }, at: T(min), eventId: randomUUID(), dataStatus: 'SYNTHETIC_DEMO' });
    const n1 = createNote('NOTE-1', { noteType: 'PROGRESS', title: 'Ward round', text: 'Comfortable at rest.' }, meta(0));
    eq([n1.current.version, n1.current.action], [1, 'CREATED'], 'v1');
    const same = amendNote(n1, 1, { noteType: 'PROGRESS', title: 'Ward round', text: 'Comfortable at rest.' }, 'x', meta(1));
    eq(same.ok ? 'ok' : same.code, 'no_change', 'no change');
    const stale = amendNote(n1, 2, { noteType: 'PROGRESS', title: 'Ward round', text: 'Pain improved.' }, 'Update', meta(1));
    eq(stale.ok ? 'ok' : stale.code, 'version_conflict', 'stale');
    const n2 = amendNote(n1, 1, { noteType: 'PROGRESS', title: 'Ward round', text: 'Pain improved.' }, 'Update', meta(2));
    ok(n2.ok && n2.record.history.length === 2 && n2.record.history[0].text === 'Comfortable at rest.', 'append-only');
    const decideNote = (persona: string, action: 'note.read' | 'note.write') => {
      const d = authorizeEncounterAction(P(persona), ENC, action);
      return d.allowed ? 'ALLOW' : `${d.status}:${d.code}`;
    };
    eq([decideNote('demo-doc-1', 'note.read'), decideNote('demo-doc-1', 'note.write')], ['ALLOW', 'ALLOW'], 'assigned clinician');
    eq([decideNote('demo-patient-1', 'note.read'), decideNote('demo-patient-1', 'note.write')], ['403:INTERNAL_NOTES', '403:READ_ONLY'], 'own patient');
    eq([decideNote('demo-hosp-4', 'note.read'), decideNote('demo-doc-2', 'note.read'), decideNote('demo-mgmt-1', 'note.read')], ['403:NO_CLINICAL_ACCESS', '404:NOT_FOUND', '403:NO_CLINICAL_ACCESS'], 'others');
    const ref = { encounterId: 'ENC-1', caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-004', recordedAt: T(0), recordedBy: { userId: 'demo-doc-1', role: 'CLINICIAN', hospitalId: 'HOSP-BLR-004', practitionerId: 'PRAC-BLR-004-01' } };
    const noteEvent = (o: Record<string, unknown>) => ({ eventId: randomUUID(), eventType: 'clinical.note.recorded', timestamp: T(0), version: '1.0', source: { type: 'clinician', id: 'PRAC-BLR-004-01' }, payload: { noteId: 'NOTE-1', ...ref, version: 1, action: 'CREATED', noteType: 'PROGRESS', contentHash: 'a'.repeat(64), patientVisible: false, ...o } });
    ok(AnyEventSchema.safeParse(noteEvent({})).success, 'note event');
    ok(!AnyEventSchema.safeParse(noteEvent({ patientVisible: true })).success, 'a note event can never be released to the patient');
    ok(!AnyEventSchema.safeParse(noteEvent({ text: 'Pain improved.' })).success, 'no note text in the event');
    ok(!CreateClinicalNoteCommandSchema.safeParse({ clientRequestId: randomUUID(), noteType: 'DIAGNOSIS', title: 't', text: 'x' }).success, 'unknown note type');
    ok(!CreateClinicalNoteCommandSchema.safeParse({ clientRequestId: randomUUID(), noteType: 'PROGRESS', title: 't', text: 'x'.repeat(8001) }).success, 'bounded text');
  });
});
