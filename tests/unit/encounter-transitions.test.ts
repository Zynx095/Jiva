/**
 * Phases 5–6 — pure encounter transitions: arrival creates the encounter (ARRIVED), only an ARRIVED
 * encounter can be handed over, and only a handed-over encounter can get a doctor — an active clinician
 * of the same hospital — with an auditable assignment history.
 */
import { randomUUID } from 'crypto';
import type { Practitioner } from '../../packages/domain-models/src';
import type { EncounterArrivalRecorded, EncounterDoctorAssigned, EncounterHandoverRecorded } from '../../packages/event-schema/src';
import { applyDoctorAssignment, applyHandover, encounterFromArrival } from '../../services/api/src/clinical/encounters';
import { check, eq, ok, run } from './helpers/assert';

const T = (min: number) => new Date(Date.parse('2026-10-12T10:00:00.000Z') + min * 60_000).toISOString();
const coordinator = { userId: 'demo-hosp-4', role: 'HOSPITAL' as const, hospitalId: 'HOSP-BLR-004' };
const ids = { encounterId: 'ENC-BLR-004-AAAA0001', caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-004' };

const arrival = (): EncounterArrivalRecorded => ({
  eventId: randomUUID(), eventType: 'encounter.arrival.recorded', timestamp: T(0), version: '1.0', source: { type: 'hospital', id: 'HOSP-BLR-004' },
  payload: { ...ids, ambulanceId: 'AMB-BLR-001', referralRequestId: 'AR-1', arrivedAt: T(0), recordedBy: coordinator, dataStatus: 'SYNTHETIC_DEMO', basis: 'HOSPITAL_CONFIRMED' },
});
const handover = (at = T(5), o: Partial<EncounterHandoverRecorded['payload']> = {}): EncounterHandoverRecorded => ({
  eventId: randomUUID(), eventType: 'encounter.handover.recorded', timestamp: at, version: '1.0', source: { type: 'hospital', id: 'HOSP-BLR-004' },
  payload: { ...ids, ambulanceId: 'AMB-BLR-001', handedOverAt: at, recordedBy: coordinator, ...o },
});
const assign = (practitionerId: string, previousPractitionerId?: string, at = T(10)): EncounterDoctorAssigned => ({
  eventId: randomUUID(), eventType: 'encounter.doctor.assigned', timestamp: at, version: '1.0', source: { type: 'hospital', id: 'HOSP-BLR-004' },
  payload: { ...ids, practitionerId, ...(previousPractitionerId ? { previousPractitionerId } : {}), reason: previousPractitionerId ? 'SHIFT_HANDOVER' : 'INITIAL_ASSIGNMENT', assignedAt: at, recordedBy: coordinator },
});
const doc = (practitionerId: string, o: Partial<Practitioner> = {}): Practitioner =>
  ({ practitionerId, hospitalId: 'HOSP-BLR-004', displayName: `Dr ${practitionerId}`, specialty: 'Emergency medicine', active: true, dataStatus: 'SYNTHETIC_DEMO', source: 'test', ...o });

run('Phases 5–6 — encounter transitions', async () => {
  const enc = encounterFromArrival(arrival(), { gpsArrivalAt: T(-1), referral: { requestId: 'AR-1', responseStatus: 'ACCEPTED' } });

  await check('arrival creates an ARRIVED encounter with actor, referral, GPS evidence and provenance', () => {
    eq([enc.status, enc.caseId, enc.hospitalId, enc.ambulanceId, enc.version], ['ARRIVED', 'CASE-BLR-876', 'HOSP-BLR-004', 'AMB-BLR-001', 1], 'basics');
    eq(enc.arrival.recordedBy, coordinator, 'actor');
    eq(enc.arrival.gpsArrivalAt, T(-1), 'GPS geofence kept as evidence only');
    eq(enc.referral?.requestId, 'AR-1', 'referral');
    eq(enc.dataStatus, 'SYNTHETIC_DEMO', 'provenance');
    ok(!enc.handover && !enc.assignedDoctor && enc.assignmentHistory.length === 0, 'nothing else yet');
  });

  await check('handover: ARRIVED → IN_CARE with the receiving actor; never twice; never before arrival; never for another encounter', () => {
    const t = applyHandover(enc, handover());
    ok(t.ok, 'handover applies');
    if (!t.ok) return;
    eq([t.next.status, t.next.handover?.handedOverAt, t.next.handover?.fromAmbulanceId, t.next.version], ['IN_CARE', T(5), 'AMB-BLR-001', 2], 'in care');
    const again = applyHandover(t.next, handover(T(6)));
    eq(again.ok ? 'ok' : again.reason, 'NOT_AWAITING_HANDOVER', 'duplicate handover');
    const early = applyHandover(enc, handover(T(-5)));
    eq(early.ok ? 'ok' : early.reason, 'HANDOVER_BEFORE_ARRIVAL', 'before arrival');
    const wrong = applyHandover(enc, handover(T(5), { caseId: 'CASE-BLR-877' }));
    eq(wrong.ok ? 'ok' : wrong.reason, 'ENCOUNTER_MISMATCH', 'another case');
  });

  await check('doctor assignment needs a handed-over encounter and an active clinician of the same hospital', () => {
    const r1 = applyDoctorAssignment(enc, assign('PRAC-BLR-004-01'), doc('PRAC-BLR-004-01'));
    eq(r1.ok ? 'ok' : r1.reason, 'NOT_HANDED_OVER', 'not before handover');
    const inCare = (applyHandover(enc, handover()) as { ok: true; next: typeof enc }).next;
    const other = applyDoctorAssignment(inCare, assign('PRAC-BLR-001-01'), doc('PRAC-BLR-001-01', { hospitalId: 'HOSP-BLR-001' }));
    eq(other.ok ? 'ok' : other.reason, 'PRACTITIONER_NOT_ELIGIBLE', 'doctor of another hospital');
    const inactive = applyDoctorAssignment(inCare, assign('PRAC-BLR-004-03'), doc('PRAC-BLR-004-03', { active: false }));
    eq(inactive.ok ? 'ok' : inactive.reason, 'PRACTITIONER_NOT_ELIGIBLE', 'inactive doctor');
    const unknown = applyDoctorAssignment(inCare, assign('PRAC-NOPE'), undefined);
    eq(unknown.ok ? 'ok' : unknown.reason, 'PRACTITIONER_NOT_ELIGIBLE', 'not on the roster');
  });

  await check('assignment history: who, when, why; reassignment closes the previous one; stale or repeated assignments rejected', () => {
    const inCare = (applyHandover(enc, handover()) as { ok: true; next: typeof enc }).next;
    const a1 = applyDoctorAssignment(inCare, assign('PRAC-BLR-004-01', undefined, T(10)), doc('PRAC-BLR-004-01'));
    ok(a1.ok, 'initial assignment');
    if (!a1.ok) return;
    eq([a1.next.assignedDoctor?.practitionerId, a1.next.assignedDoctor?.reason, a1.next.assignedDoctor?.assignedBy.userId, a1.next.assignmentHistory.length], ['PRAC-BLR-004-01', 'INITIAL_ASSIGNMENT', 'demo-hosp-4', 1], 'recorded');
    const same = applyDoctorAssignment(a1.next, assign('PRAC-BLR-004-01', 'PRAC-BLR-004-01'), doc('PRAC-BLR-004-01'));
    eq(same.ok ? 'ok' : same.reason, 'ALREADY_ASSIGNED', 'same doctor again');
    const stale = applyDoctorAssignment(a1.next, assign('PRAC-BLR-004-02'), doc('PRAC-BLR-004-02'));
    eq(stale.ok ? 'ok' : stale.reason, 'STALE_ASSIGNMENT', 'event not based on the current assignment');
    const a2 = applyDoctorAssignment(a1.next, assign('PRAC-BLR-004-02', 'PRAC-BLR-004-01', T(30)), doc('PRAC-BLR-004-02'));
    ok(a2.ok, 'reassignment');
    if (!a2.ok) return;
    eq(a2.next.assignedDoctor?.practitionerId, 'PRAC-BLR-004-02', 'current doctor');
    eq(a2.next.assignmentHistory.map(h => [h.practitionerId, h.endedAt ?? null]), [['PRAC-BLR-004-01', T(30)], ['PRAC-BLR-004-02', null]], 'history kept, previous ended');
  });
});
