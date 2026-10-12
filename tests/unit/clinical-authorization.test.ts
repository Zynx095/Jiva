/**
 * Phase 1 — role permissions, explicit and backend-enforced:
 *  - ambulance-originated emergency creation (bound to the crew's own unit, no other new permission)
 *  - encounter / clinical-record permissions per role and scope (allow AND deny paths)
 *  - realtime/ledger delivery of encounter and clinical events (default deny, no management/admin
 *    access to clinical events)
 *  - identity mapping for the new CLINICIAN role (demo personas and Cognito claims)
 */
import { randomUUID } from 'crypto';
import { DEMO_USERS, CognitoAuthProvider, type AuthContext } from '../../packages/auth/src';
import type { AnyEvent } from '../../packages/event-schema/src';
import { authorizeEventSubmission, EXTERNAL_EVENT_TYPES } from '../../services/api/src/authorizationPolicy';
import {
  actorFromAuth,
  authorizeArrivalRecording,
  authorizeAuditRead,
  authorizeEncounterAction,
  authorizeRosterRead,
  canReceiveClinicalDomainEvent,
  encounterViewFor,
  type EncounterAction,
  type EncounterFacts,
} from '../../services/api/src/clinical/policy';
import { check, eq, ok, run } from './helpers/assert';

const P = (id: string): AuthContext => {
  const p = DEMO_USERS[id];
  if (!p) throw new Error(`missing persona ${id}`);
  return p;
};
const now = new Date().toISOString();
const ev = (eventType: string, payload: object, source: { type: string; id: string }, extra: object = {}) =>
  ({ eventId: randomUUID(), eventType, timestamp: now, version: '1.0', source, payload, ...extra }) as unknown as AnyEvent;
const emergency = (source: { type: string; id: string }, intake?: object, patientId = 'CASE-NEW-1') =>
  ev('patient.emergency.created', { condition: 'Chest pain', location: { latitude: 13.04, longitude: 77.59 }, severity: 'HIGH', ...(intake ? { intake } : {}) }, source, { patientId });

const allowed = (r: string | null) => r === null;

const ENC: EncounterFacts = { encounterId: 'ENC-1', caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-004', status: 'IN_CARE', assignedPractitionerId: 'PRAC-BLR-004-01' };
const ALL_ACTIONS: EncounterAction[] = [
  'encounter.read', 'handover.record', 'doctor.assign',
  'prescription.write', 'prescription.read', 'report.write', 'report.read',
  'document.write', 'document.read', 'telemetry.write', 'telemetry.read',
];
const decide = (persona: string, action: EncounterAction, opts: { patientVisible?: boolean; ambulanceCaseId?: string } = {}) => {
  const d = authorizeEncounterAction(P(persona), ENC, action, opts);
  return d.allowed ? 'ALLOW' : `${d.status}:${d.code}`;
};

run('Phase 1 — authorization policy', async () => {
  // ---------------------------------------------------------------- emergency creation
  await check('ambulance crew may report an emergency as its own unit', () => {
    ok(allowed(authorizeEventSubmission(P('demo-amb-1'), emergency({ type: 'ambulance', id: 'AMB-BLR-001' }))), 'own unit, no intake block');
    ok(allowed(authorizeEventSubmission(P('demo-amb-1'), emergency({ type: 'ambulance', id: 'AMB-BLR-001' }, { channel: 'AMBULANCE_CREW', locationMethod: 'MAP_PIN' }))), 'own unit, crew channel');
  });

  await check('ambulance crew may NOT report as another unit, as the system, or claim the dispatch channel', () => {
    ok(!allowed(authorizeEventSubmission(P('demo-amb-1'), emergency({ type: 'ambulance', id: 'AMB-BLR-002' }))), 'other unit');
    ok(!allowed(authorizeEventSubmission(P('demo-amb-1'), emergency({ type: 'system', id: 'dispatch' }))), 'system source');
    ok(!allowed(authorizeEventSubmission(P('demo-amb-1'), emergency({ type: 'ambulance', id: 'AMB-BLR-001' }, { channel: 'DISPATCH', locationMethod: 'MAP_PIN' }))), 'dispatch channel');
  });

  await check('existing emergency rules unchanged: management/admin and the patient themself; hospitals and clinicians denied', () => {
    ok(allowed(authorizeEventSubmission(P('demo-mgmt-1'), emergency({ type: 'system', id: 'dispatch' }))), 'management (legacy, no intake)');
    ok(allowed(authorizeEventSubmission(P('demo-admin'), emergency({ type: 'system', id: 'dispatch' }, { channel: 'DISPATCH', locationMethod: 'MANUAL_ENTRY' }))), 'admin, dispatch channel');
    ok(!allowed(authorizeEventSubmission(P('demo-mgmt-1'), emergency({ type: 'system', id: 'dispatch' }, { channel: 'AMBULANCE_CREW', locationMethod: 'MAP_PIN' }))), 'management cannot claim a crew report');
    ok(allowed(authorizeEventSubmission(P('demo-patient-1'), emergency({ type: 'patient', id: 'p' }, undefined, 'CASE-BLR-876'))), 'patient own case');
    ok(!allowed(authorizeEventSubmission(P('demo-patient-1'), emergency({ type: 'patient', id: 'p' }, undefined, 'CASE-BLR-877'))), 'patient other case');
    ok(!allowed(authorizeEventSubmission(P('demo-hosp-1'), emergency({ type: 'hospital', id: 'HOSP-BLR-001' }))), 'hospital');
    ok(!allowed(authorizeEventSubmission(P('demo-doc-1'), emergency({ type: 'clinician', id: 'PRAC-BLR-004-01' }))), 'clinician');
  });

  await check('the ambulance gains no other permission: no dispatch, no hospital answers, no capacity', () => {
    const dispatch = ev('ambulance.dispatched', { ambulanceId: 'AMB-BLR-001', caseId: 'CASE-1', destination: { latitude: 13, longitude: 77.6 }, estimatedEtaMinutes: 0 }, { type: 'ambulance', id: 'AMB-BLR-001' });
    ok(!allowed(authorizeEventSubmission(P('demo-amb-1'), dispatch)), 'self-dispatch');
    const answer = ev('hospital.acceptance.received', {
      responseId: 'R-1', requestId: 'AR-1', caseId: 'CASE-1', hospitalId: 'HOSP-BLR-001', status: 'ACCEPTED', acceptedCapabilities: [], limitations: [],
      respondedAt: now, validUntil: now, responderRole: 'X', source: 'SYNTHETIC_DEMO',
    }, { type: 'hospital', id: 'HOSP-BLR-001' });
    ok(!allowed(authorizeEventSubmission(P('demo-amb-1'), answer)), 'hospital answer');
    ok(!allowed(authorizeEventSubmission(P('demo-doc-3'), answer)), 'a clinician does not answer acceptance requests either');
  });

  await check('crew-reported assignments cannot be submitted by anyone (system-generated only)', () => {
    const crew = ev('ambulance.dispatched', { ambulanceId: 'AMB-BLR-001', caseId: 'CASE-1', destination: { latitude: 13, longitude: 77.6 }, estimatedEtaMinutes: 0, assignmentBasis: 'REPORTED_BY_CREW' }, { type: 'system', id: 'dispatch' });
    for (const id of ['demo-admin', 'demo-mgmt-1', 'demo-amb-1']) ok(!allowed(authorizeEventSubmission(P(id), crew)), `${id} denied`);
    const normal = ev('ambulance.dispatched', { ambulanceId: 'AMB-BLR-001', caseId: 'CASE-1', destination: { latitude: 13, longitude: 77.6 }, estimatedEtaMinutes: 8, assignmentBasis: 'DISPATCH' }, { type: 'system', id: 'dispatch' });
    ok(allowed(authorizeEventSubmission(P('demo-mgmt-1'), normal)), 'normal dispatch still allowed');
  });

  await check('encounter and clinical events are not externally submittable by ANY principal (commands only)', () => {
    const types = ['encounter.arrival.recorded', 'encounter.handover.recorded', 'encounter.doctor.assigned', 'clinical.prescription.recorded', 'clinical.report.recorded', 'clinical.document.stored', 'clinical.telemetry.recorded'];
    for (const t of types) {
      ok(!EXTERNAL_EVENT_TYPES.has(t), `${t} not external`);
      for (const id of Object.keys(DEMO_USERS)) {
        ok(!allowed(authorizeEventSubmission(P(id), ev(t, { caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-004' }, { type: 'hospital', id: 'HOSP-BLR-004' }))), `${id} may not submit ${t}`);
      }
    }
  });

  // ---------------------------------------------------------------- encounter / clinical matrix
  await check('assigned clinician: every clinical read/write allowed; lifecycle actions are not theirs', () => {
    for (const a of ALL_ACTIONS) {
      const expected = a === 'handover.record' || a === 'doctor.assign' ? '403:HOSPITAL_STAFF_ONLY' : 'ALLOW';
      eq(decide('demo-doc-1', a), expected, `demo-doc-1 ${a}`);
    }
  });

  await check('clinician at the SAME hospital but NOT assigned: nothing, not even existence (404)', () => {
    for (const a of ALL_ACTIONS) eq(decide('demo-doc-2', a), '404:NOT_FOUND', `demo-doc-2 ${a}`);
  });

  await check('clinician at ANOTHER hospital: 404 everywhere', () => {
    for (const a of ALL_ACTIONS) eq(decide('demo-doc-3', a), '404:NOT_FOUND', `demo-doc-3 ${a}`);
  });

  await check('hospital coordinator (same hospital): lifecycle + metadata only, no clinical content', () => {
    eq(decide('demo-hosp-4', 'encounter.read'), 'ALLOW', 'read encounter');
    eq(decide('demo-hosp-4', 'handover.record'), 'ALLOW', 'handover');
    eq(decide('demo-hosp-4', 'doctor.assign'), 'ALLOW', 'assign');
    for (const a of ['prescription.read', 'report.read', 'document.read', 'telemetry.read'] as EncounterAction[]) eq(decide('demo-hosp-4', a), '403:NO_CLINICAL_ACCESS', `coordinator ${a}`);
    for (const a of ['prescription.write', 'report.write', 'document.write', 'telemetry.write'] as EncounterAction[]) eq(decide('demo-hosp-4', a), '403:ASSIGNED_CLINICIAN_ONLY', `coordinator ${a}`);
  });

  await check('hospital coordinator of ANOTHER hospital: 404 everywhere (no cross-hospital doctor assignment or handover)', () => {
    for (const a of ALL_ACTIONS) eq(decide('demo-hosp-1', a), '404:NOT_FOUND', `demo-hosp-1 ${a}`);
  });

  await check('patient: reads own records (released only), never writes, never another patient\'s', () => {
    eq(decide('demo-patient-1', 'encounter.read'), 'ALLOW', 'own encounter');
    eq(decide('demo-patient-1', 'prescription.read'), 'ALLOW', 'own prescriptions');
    eq(decide('demo-patient-1', 'telemetry.read'), 'ALLOW', 'own measurements');
    eq(decide('demo-patient-1', 'report.read', { patientVisible: true }), 'ALLOW', 'released report');
    eq(decide('demo-patient-1', 'report.read', { patientVisible: false }), '404:NOT_RELEASED', 'unreleased report hidden');
    eq(decide('demo-patient-1', 'document.read', { patientVisible: false }), '404:NOT_RELEASED', 'unreleased document hidden');
    for (const a of ['prescription.write', 'report.write', 'document.write', 'telemetry.write'] as EncounterAction[]) eq(decide('demo-patient-1', a), '403:READ_ONLY', `patient ${a}`);
    eq(decide('demo-patient-1', 'handover.record'), '403:HOSPITAL_STAFF_ONLY', 'patient handover');
    for (const a of ALL_ACTIONS) eq(decide('demo-patient-2', a), '404:NOT_FOUND', `other patient ${a}`);
  });

  await check('ambulance: summary of its own case only; no clinical access; unrelated ambulance sees nothing', () => {
    eq(decide('demo-amb-1', 'encounter.read', { ambulanceCaseId: 'CASE-BLR-876' }), 'ALLOW', 'own case summary');
    eq(decide('demo-amb-1', 'prescription.read', { ambulanceCaseId: 'CASE-BLR-876' }), '403:NO_CLINICAL_ACCESS', 'no prescriptions');
    eq(decide('demo-amb-1', 'handover.record', { ambulanceCaseId: 'CASE-BLR-876' }), '403:HOSPITAL_STAFF_ONLY', 'crew cannot record the handover itself');
    eq(decide('demo-amb-2', 'encounter.read'), '404:NOT_FOUND', 'unrelated ambulance');
  });

  await check('management and admin: encounter summaries only, no clinical content, no lifecycle actions', () => {
    for (const id of ['demo-mgmt-1', 'demo-admin']) {
      eq(decide(id, 'encounter.read'), 'ALLOW', `${id} summary`);
      for (const a of ['prescription.read', 'report.read', 'document.read', 'telemetry.read'] as EncounterAction[]) eq(decide(id, a), '403:NO_CLINICAL_ACCESS', `${id} ${a}`);
      eq(decide(id, 'doctor.assign'), '403:HOSPITAL_STAFF_ONLY', `${id} cannot assign doctors`);
    }
  });

  await check('encounter projection per principal: FULL for staff, PATIENT view, SUMMARY for coordination, none when unrelated', () => {
    eq(encounterViewFor(P('demo-doc-1'), ENC), 'FULL', 'assigned clinician');
    eq(encounterViewFor(P('demo-hosp-4'), ENC), 'FULL', 'coordinator');
    eq(encounterViewFor(P('demo-patient-1'), ENC), 'PATIENT', 'patient');
    eq(encounterViewFor(P('demo-mgmt-1'), ENC), 'SUMMARY', 'management');
    eq(encounterViewFor(P('demo-amb-1'), ENC, 'CASE-BLR-876'), 'SUMMARY', 'crew');
    eq(encounterViewFor(P('demo-doc-2'), ENC), undefined, 'unassigned clinician');
    eq(encounterViewFor(P('demo-patient-2'), ENC), undefined, 'other patient');
  });

  await check('arrival recording, roster and audit permissions', () => {
    ok(authorizeArrivalRecording(P('demo-hosp-4'), 'HOSP-BLR-004').allowed, 'own hospital coordinator');
    const other = authorizeArrivalRecording(P('demo-hosp-1'), 'HOSP-BLR-004');
    ok(!other.allowed && other.code === 'OTHER_HOSPITAL', 'other hospital denied');
    for (const id of ['demo-doc-1', 'demo-amb-1', 'demo-mgmt-1', 'demo-admin', 'demo-patient-1']) ok(!authorizeArrivalRecording(P(id), 'HOSP-BLR-004').allowed, `${id} cannot record arrival`);
    ok(authorizeRosterRead(P('demo-hosp-4'), 'HOSP-BLR-004').allowed && authorizeRosterRead(P('demo-doc-1'), 'HOSP-BLR-004').allowed, 'own staff read roster');
    for (const id of ['demo-doc-3', 'demo-hosp-1', 'demo-mgmt-1', 'demo-patient-1']) ok(!authorizeRosterRead(P(id), 'HOSP-BLR-004').allowed, `${id} cannot read the 004 roster`);
    ok(authorizeAuditRead(P('demo-admin')).allowed, 'admin reads audit');
    for (const id of ['demo-mgmt-1', 'demo-hosp-4', 'demo-doc-1', 'demo-patient-1']) ok(!authorizeAuditRead(P(id)).allowed, `${id} cannot read audit`);
  });

  // ---------------------------------------------------------------- realtime / ledger delivery
  const lookup = (id: string) => (id === ENC.encounterId ? ENC : undefined);
  const base = { encounterId: ENC.encounterId, caseId: ENC.caseId, hospitalId: ENC.hospitalId };
  const receivers = (e: { eventType: string; payload: object }) =>
    Object.keys(DEMO_USERS).filter(id => canReceiveClinicalDomainEvent(P(id), e as never, lookup)).sort();

  await check('clinical record events reach only the patient (released records) and the assigned clinician', () => {
    eq(receivers({ eventType: 'clinical.prescription.recorded', payload: { ...base, patientVisible: true } }), ['demo-doc-1', 'demo-patient-1'], 'released prescription');
    eq(receivers({ eventType: 'clinical.report.recorded', payload: { ...base, patientVisible: false } }), ['demo-doc-1'], 'unreleased report');
  });

  await check('doctor assignment reaches the patient, the hospital and the clinicians it concerns; never management', () => {
    eq(receivers({ eventType: 'encounter.doctor.assigned', payload: { ...base, practitionerId: 'PRAC-BLR-004-01', previousPractitionerId: 'PRAC-BLR-004-02' } }),
      ['demo-doc-1', 'demo-doc-2', 'demo-hosp-4', 'demo-patient-1'], 'assignment receivers');
  });

  await check('arrival/handover reach coordination, the patient, the crew that brought them, the hospital and the assigned clinician', () => {
    eq(receivers({ eventType: 'encounter.arrival.recorded', payload: { ...base, ambulanceId: 'AMB-BLR-001' } }),
      ['demo-admin', 'demo-amb-1', 'demo-doc-1', 'demo-hosp-4', 'demo-mgmt-1', 'demo-patient-1'], 'arrival receivers');
  });

  await check('malformed clinical-domain events are delivered to nobody', () => {
    eq(receivers({ eventType: 'encounter.arrival.recorded', payload: { encounterId: 'ENC-1', hospitalId: 'HOSP-BLR-004' } }), [], 'missing case id');
    eq(receivers({ eventType: 'clinical.prescription.recorded', payload: { ...base, encounterId: 'ENC-UNKNOWN', patientVisible: false } }), [], 'unknown encounter');
  });

  // ---------------------------------------------------------------- identity
  await check('actor identity comes only from the principal', () => {
    eq(actorFromAuth(P('demo-doc-1')), { userId: 'demo-doc-1', role: 'CLINICIAN', hospitalId: 'HOSP-BLR-004', practitionerId: 'PRAC-BLR-004-01' }, 'clinician actor');
    eq(actorFromAuth(P('demo-hosp-4')), { userId: 'demo-hosp-4', role: 'HOSPITAL', hospitalId: 'HOSP-BLR-004' }, 'coordinator actor');
  });

  await check('every CLINICIAN persona is scoped to a hospital and a practitioner', () => {
    const clinicians = Object.values(DEMO_USERS).filter(u => u.role === 'CLINICIAN');
    ok(clinicians.length >= 2, 'clinician personas exist');
    for (const c of clinicians) ok(!!c.hospitalId && !!c.practitionerId && c.isDemo === true, `${c.userId} scoped`);
  });

  await check('Cognito: CLINICIAN group maps to the CLINICIAN role with its practitioner scope; HOSPITAL takes precedence', () => {
    const r = CognitoAuthProvider.parseClaims({ sub: 'u-1', 'cognito:groups': ['CLINICIAN'], 'custom:hospitalId': 'HOSP-BLR-004', 'custom:practitionerId': 'PRAC-BLR-004-01' });
    ok(r.authenticated && r.context?.role === 'CLINICIAN' && r.context.practitionerId === 'PRAC-BLR-004-01' && r.context.hospitalId === 'HOSP-BLR-004', 'clinician claims');
    const both = CognitoAuthProvider.parseClaims({ sub: 'u-2', 'cognito:groups': ['CLINICIAN', 'HOSPITAL'], 'custom:hospitalId': 'HOSP-BLR-004' });
    eq(both.context?.role, 'HOSPITAL', 'precedence');
  });
});
