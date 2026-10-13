/**
 * Handover notes: typed by the hospital user recording the handover, kept with the encounter for the
 * hospital team and the assigned clinician only — never on the event stream, never shown to the patient or
 * to network coordination.
 */
import { randomUUID } from 'crypto';
import type { HospitalEncounter } from '../../packages/domain-models/src';
import { EncounterHandoverRecordedSchema, RecordHandoverCommandSchema } from '../../packages/event-schema/src';
import { projectEncounter } from '../../services/api/src/clinical/views';
import { check, eq, ok, run } from './helpers/assert';

const now = new Date().toISOString();
const enc = {
  encounterId: 'ENC-BLR-001-ABCD1234', caseId: 'CASE-1', hospitalId: 'HOSP-BLR-001', status: 'IN_CARE',
  arrival: { arrivedAt: now, recordedBy: { role: 'HOSPITAL', userId: 'demo-hosp-1' }, eventId: 'e1' },
  handover: { handedOverAt: now, recordedBy: { role: 'HOSPITAL', userId: 'demo-hosp-1' }, eventId: 'e2', notes: 'Phone and wallet handed to the ward; daughter informed.' },
  assignmentHistory: [], dataStatus: 'SYNTHETIC_DEMO', createdAt: now, updatedAt: now, version: 2,
} as unknown as HospitalEncounter;

run('Handover notes', async () => {
  await check('the command accepts optional, bounded notes', () => {
    ok(RecordHandoverCommandSchema.safeParse({ clientRequestId: randomUUID() }).success, 'no notes');
    ok(RecordHandoverCommandSchema.safeParse({ clientRequestId: randomUUID(), notes: 'Belongings handed over' }).success, 'notes');
    ok(!RecordHandoverCommandSchema.safeParse({ clientRequestId: randomUUID(), notes: 'x'.repeat(1001) }).success, 'at most 1000 characters');
  });

  await check('the handover event cannot carry them (content-free)', () => {
    const e = {
      eventId: randomUUID(), eventType: 'encounter.handover.recorded', timestamp: now, version: '1.0', source: { type: 'hospital', id: 'HOSP-BLR-001' },
      payload: { encounterId: enc.encounterId, caseId: 'CASE-1', hospitalId: 'HOSP-BLR-001', handedOverAt: now, recordedBy: { role: 'HOSPITAL', userId: 'demo-hosp-1' }, dataStatus: 'SYNTHETIC_DEMO', notes: 'leak' },
    };
    ok(!EncounterHandoverRecordedSchema.safeParse(e).success, 'notes refused on the event');
  });

  await check('hospital and clinician see the notes; the patient and network coordination do not', () => {
    eq((projectEncounter(enc, 'FULL') as HospitalEncounter).handover?.notes, enc.handover!.notes, 'FULL (hospital, assigned clinician)');
    ok(!JSON.stringify(projectEncounter(enc, 'PATIENT')).includes('daughter'), 'PATIENT');
    ok(!JSON.stringify(projectEncounter(enc, 'SUMMARY')).includes('daughter'), 'SUMMARY (management, admin, crew)');
  });
});
