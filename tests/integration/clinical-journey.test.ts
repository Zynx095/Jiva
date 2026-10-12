/**
 * Runtime integration suite for the emergency-to-care journey (phases 2–13), against a REAL API
 * process on :4101 (mock mapping, demo personas). Each section exercises one workflow end to end over
 * HTTP and Socket.IO, including the authorization and failure paths.
 */
import { check, envelope, results, startApi, uuid, type Api } from './helpers/api';

const P = {
  admin: 'demo-admin', mgmt: 'demo-mgmt-1',
  h1: 'demo-hosp-1', h2: 'demo-hosp-2', h3: 'demo-hosp-3', h4: 'demo-hosp-4',
  a1: 'demo-amb-1', a2: 'demo-amb-2', a3: 'demo-amb-3',
  pat1: 'demo-patient-1', pat2: 'demo-patient-2',
  doc1: 'demo-doc-1', doc2: 'demo-doc-2', doc3: 'demo-doc-3',
};

const SCENE = { latitude: 13.0431, longitude: 77.5891 };

const intakeBody = (o: Record<string, unknown> = {}) => ({
  clientRequestId: uuid(),
  location: { ...SCENE, method: 'MAP_PIN' },
  severity: 'HIGH',
  reportedSymptoms: ['Bleeding', 'Leg deformity'],
  suspectedCause: 'Road traffic accident',
  requiredCapabilities: ['VENTILATOR'],
  notes: 'Conscious and talking.',
  ...o,
});

async function reset(api: Api) {
  const r = await api.post(P.admin, '/api/demo/reset');
  if (r.status !== 200) throw new Error(`reset failed: ${r.status}`);
}

// ------------------------------------------------------------------------------------------ phase 2

async function emergencyIntake(api: Api) {
  console.log('\n[Phase 2] Ambulance emergency intake');
  await reset(api);
  const crew = await api.socket(P.a1);
  const otherPatient = await api.socket(P.pat2);

  const body = intakeBody();
  const created = await api.post(P.a1, '/api/emergencies', body);
  check('crew intake → 202 with a server-assigned case reference', created.status === 202 && /^CASE-[0-9A-F]{8}$/.test(created.json?.caseId ?? ''), `${created.status} ${created.text}`);
  check('local projection confirmed: case exists and this crew is assigned', created.json?.projected === true && created.json?.assignedToThisAmbulance === true, created.text);
  const caseId: string = created.json?.caseId;

  const pats = await api.get(P.a1, '/api/patients');
  const p = pats.json?.find((x: any) => x.patientId === caseId);
  check('crew sees the case it reported (authoritative state)', !!p, JSON.stringify(pats.json));
  check('symptoms and suspected cause are stored separately', JSON.stringify(p?.reportedSymptoms) === JSON.stringify(['Bleeding', 'Leg deformity']) && p?.suspectedCause === 'Road traffic accident', JSON.stringify(p));
  check('legacy condition labels the cause as suspected (no diagnosis)', p?.activeConditions?.[0] === 'Suspected: Road traffic accident · Reported: Bleeding, Leg deformity', p?.activeConditions?.[0]);
  check('care requirement = rule-based assessment + requested care', JSON.stringify(p?.careRequirements) === JSON.stringify(['EMERGENCY', 'TRAUMA', 'ICU', 'VENTILATOR']), JSON.stringify(p?.careRequirements));
  check('intake provenance recorded (crew, map pin)', p?.intake?.channel === 'AMBULANCE_CREW' && p?.intake?.reportedByAmbulanceId === 'AMB-BLR-001' && p?.intake?.locationMethod === 'MAP_PIN', JSON.stringify(p?.intake));
  check('no identity fields were collected', !('name' in (p || {})) && !('patientName' in (p || {})));

  const amb = (await api.get(P.a1, '/api/ambulances')).json?.[0];
  check('reporting crew is assigned ON_SCENE', amb?.assignedPatient === caseId && amb?.status === 'ON_SCENE', JSON.stringify(amb));

  const asked = await api.waitFor(async () => (await api.get(P.h1, '/api/hospitals/HOSP-BLR-001/requests')).json.some((r: any) => r.caseId === caseId));
  check('downstream coordination: capable hospital received a referral', asked);
  check('incapable hospital (H3) was not asked', !(await api.get(P.h3, '/api/hospitals/HOSP-BLR-003/requests')).json.some((r: any) => r.caseId === caseId));

  const ledger = (await api.get(P.mgmt, '/api/events/history?limit=500')).json as any[];
  const em = ledger.find(e => e.eventType === 'patient.emergency.created' && e.patientId === caseId);
  check('canonical event recorded with the crew as its source', em?.source?.type === 'ambulance' && em?.source?.id === 'AMB-BLR-001');
  const assignment = ledger.find(e => e.eventType === 'ambulance.dispatched' && e.payload?.caseId === caseId);
  check('crew assignment is an auditable system event caused by the report', assignment?.payload?.assignmentBasis === 'REPORTED_BY_CREW' && assignment?.source?.type === 'system' && assignment?.causationId === em?.eventId, JSON.stringify(assignment));

  // idempotency
  const retry = await api.post(P.a1, '/api/emergencies', body);
  check('retry with the same clientRequestId returns the original result (no second case)', retry.status === 202 && retry.json?.caseId === caseId);
  const ledger2 = (await api.get(P.mgmt, '/api/events/history?limit=500')).json as any[];
  check('exactly one emergency event for the case', ledger2.filter(e => e.eventType === 'patient.emergency.created' && e.patientId === caseId).length === 1);
  const reused = await api.post(P.a1, '/api/emergencies', { ...body, severity: 'LOW' });
  check('clientRequestId reused for a different request → 422', reused.status === 422 && reused.json?.error === 'idempotency_key_reused', `${reused.status}`);

  // state checks
  const busy = await api.post(P.a1, '/api/emergencies', intakeBody());
  check('busy crew cannot open a second case → 409 ambulance_busy (names the open case)', busy.status === 409 && busy.json?.error === 'ambulance_busy' && busy.json?.caseId === caseId, busy.text);
  const dup = await api.post(P.a2, '/api/emergencies', intakeBody({ caseRef: caseId }));
  check('case reference already open → 409 case_exists', dup.status === 409 && dup.json?.error === 'case_exists', dup.text);
  const linked = await api.post(P.a2, '/api/emergencies', intakeBody({ caseRef: 'CASE-BLR-876' }));
  check('patient-shared case reference is used as the case id', linked.status === 202 && linked.json?.caseId === 'CASE-BLR-876', linked.text);
  const patView = await api.get(P.pat1, '/api/patients');
  check('the patient with that reference sees their case', patView.json?.length === 1 && patView.json[0].patientId === 'CASE-BLR-876');
  const far = await api.post(P.a3, '/api/emergencies', intakeBody({ location: { latitude: 19.076, longitude: 72.8777, method: 'MANUAL_ENTRY' } }));
  check('location outside the service area → 422', far.status === 422 && far.json?.error === 'outside_service_area', far.text);

  // validation
  const noSymptoms = await api.post(P.a3, '/api/emergencies', intakeBody({ reportedSymptoms: [] }));
  check('missing symptoms → 400 with the field path', noSymptoms.status === 400 && noSymptoms.json?.issues?.some((i: any) => i.path === 'reportedSymptoms'), noSymptoms.text);
  check('identity fields rejected → 400', (await api.post(P.a3, '/api/emergencies', intakeBody({ patientName: 'Asha' }))).status === 400);
  check('unknown capability rejected → 400', (await api.post(P.a3, '/api/emergencies', intakeBody({ requiredCapabilities: ['MAGIC'] }))).status === 400);
  check('malformed JSON → 400', (await api.req('POST', '/api/emergencies', P.a3, undefined, { raw: '{bad' })).status === 400);

  // roles
  check('unauthenticated → 401', (await api.post(undefined, '/api/emergencies', intakeBody())).status === 401);
  for (const [name, persona] of [['patient', P.pat1], ['hospital', P.h1], ['clinician', P.doc1], ['management', P.mgmt]] as const) {
    check(`${name} cannot use the crew intake → 403`, (await api.post(persona, '/api/emergencies', intakeBody())).status === 403);
  }

  // generic event endpoint (shared with the AWS ingestion lambda)
  const viaEvents = envelope('patient.emergency.created', { condition: 'Reported: seizure', location: SCENE, severity: 'MEDIUM', reportedSymptoms: ['seizure'], intake: { channel: 'AMBULANCE_CREW', locationMethod: 'DEVICE_GPS' } }, { type: 'ambulance', id: 'AMB-BLR-003' }, { patientId: 'CASE-EV-1' });
  check('crew may also submit the canonical event as its own unit → 202', (await api.event(P.a3, viaEvents)).status === 202);
  check('crew cannot report as another unit → 403', (await api.event(P.a3, { ...viaEvents, eventId: uuid(), patientId: 'CASE-EV-2', source: { type: 'ambulance', id: 'AMB-BLR-001' } })).status === 403);
  check('crew cannot report as the system → 403', (await api.event(P.a3, { ...viaEvents, eventId: uuid(), patientId: 'CASE-EV-3', source: { type: 'system', id: 'dispatch' } })).status === 403);
  check('crew cannot claim the dispatch channel → 403', (await api.event(P.a3, { ...viaEvents, eventId: uuid(), patientId: 'CASE-EV-4', payload: { ...viaEvents.payload as object, intake: { channel: 'DISPATCH', locationMethod: 'DEVICE_GPS' } } })).status === 403);
  check('crew cannot dispatch itself → 403', (await api.event(P.a3, envelope('ambulance.dispatched', { ambulanceId: 'AMB-BLR-003', caseId: 'CASE-EV-1', destination: SCENE, estimatedEtaMinutes: 0 }, { type: 'ambulance', id: 'AMB-BLR-003' }))).status === 403);

  // realtime
  await api.waitFor(async () => crew.events.some(e => e.eventType === 'hospital.acceptance.requested' && e.payload.caseId === caseId), 3000);
  check('crew receives its case events in realtime (requirement, referrals)', crew.events.some(e => e.eventType === 'care.requirement.created' && e.payload.caseId === caseId) && crew.events.some(e => e.eventType === 'hospital.acceptance.requested'));
  check('crew does not receive the other crew\'s case', !crew.events.some(e => JSON.stringify(e).includes('CASE-BLR-876')));
  check('an unrelated patient receives nothing about the case', !otherPatient.events.some(e => JSON.stringify(e).includes(caseId)));
  crew.s.close();
  otherPatient.s.close();
}

// ------------------------------------------------------------------------------------------

async function main() {
  console.log('[Test] Emergency-to-care journey against a real API on :4101');
  const api = await startApi(4101);
  try {
    await emergencyIntake(api);
    check('API process still healthy at the end', (await api.get(undefined, '/api/health')).status === 200);
    check('no handler crashes logged', !/Handler for .* failed|Uncaught exception|Unhandled rejection/.test(api.log()), api.log().match(/.*(failed|Uncaught|Unhandled).*/g)?.slice(0, 3).join('\n'));
  } finally {
    api.stop();
  }
  const { passes, failures } = results();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('✓ Emergency-to-care journey PASSED.');
  process.exit(0);
}

main().catch(err => { console.error('✗ Emergency-to-care journey crashed:', err); process.exit(1); });
