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

// ------------------------------------------------------------------------------------------ phase 3

async function facilityDirectory(api: Api) {
  console.log('\n[Phase 3] Public facility directory');
  await reset(api);
  check('directory requires authentication → 401', (await api.get(undefined, '/api/directory/facilities')).status === 401);
  const all = await api.get(P.pat1, '/api/directory/facilities');
  check('directory readable by any authenticated role (public listing data)', all.status === 200 && all.json?.facilities?.length > 400, `${all.status}`);
  check('every listing is marked not connected, capacity unknown', all.json.facilities.every((f: any) => f.operational?.connectedToJiva === false && f.operational?.capacity === 'UNKNOWN'));
  check('response carries the not-connected note, sources and OSM attribution', /Not connected/.test(all.json.note) && all.json.sources.length >= 5 && /OpenStreetMap/.test(all.json.osmSnapshot?.attribution ?? ''));
  const located = await api.get(P.a1, '/api/directory/facilities?located=true&category=HOSPITAL');
  check('filters: located hospitals only', located.status === 200 && located.json.facilities.length > 0 && located.json.facilities.every((f: any) => f.location && f.category === 'HOSPITAL'));
  check('invalid category → 400', (await api.get(P.a1, '/api/directory/facilities?category=CASINO')).status === 400);

  const near = await api.get(P.a1, `/api/directory/facilities/near?lat=${SCENE.latitude}&lng=${SCENE.longitude}&limit=3&category=HOSPITAL`);
  const d = near.json?.results?.map((r: any) => r.straightLineKm) ?? [];
  check('nearby: straight-line distances, sorted, bounded, labelled as such', near.status === 200 && near.json.basis === 'STRAIGHT_LINE_DISTANCE' && d.length === 3 && d.every((x: number, i: number) => x <= 15 && (i === 0 || d[i - 1] <= x)), near.text.slice(0, 200));
  check('nearby: invalid coordinates → 400', (await api.get(P.a1, '/api/directory/facilities/near?lat=abc&lng=77.5')).status === 400);

  const network = (await api.get(P.mgmt, '/api/hospitals')).json as any[];
  check('directory facilities never enter the operational network (hospital store unchanged)', network.length === 4 && !network.some(h => /^FAC-/.test(h.hospitalId)));
  await api.post(P.a1, '/api/emergencies', intakeBody({ reportedSymptoms: ['Chest pain'], suspectedCause: undefined, requiredCapabilities: [] }));
  await api.waitFor(async () => ((await api.get(P.mgmt, '/api/events/history?limit=200')).json as any[]).some(e => e.eventType === 'hospital.acceptance.requested'), 5000);
  const hist = (await api.get(P.mgmt, '/api/events/history?limit=300')).json as any[];
  const asked = hist.filter(e => e.eventType === 'hospital.acceptance.requested').map(e => e.payload.hospitalId);
  const evaluated = hist.filter(e => e.eventType === 'hospital.candidate.generated').flatMap(e => e.payload.candidates.map((c: any) => c.hospitalId));
  check('referrals and candidate evaluation consider network hospitals only', asked.length > 0 && [...asked, ...evaluated].every(id => /^HOSP-BLR-00\d$/.test(id)), JSON.stringify([...new Set([...asked, ...evaluated])]));
}

// ------------------------------------------------------------------------------------------ phase 4

/** The open referral id for (case, hospital), read from the ledger as management. */
async function referralId(api: Api, caseId: string, hospitalId: string): Promise<string | undefined> {
  const hist = (await api.get(P.mgmt, '/api/events/history?limit=1000')).json as any[];
  return hist.find(e => e.eventType === 'hospital.acceptance.requested' && e.payload.caseId === caseId && e.payload.hospitalId === hospitalId)?.payload.requestId;
}

const answer = (caseId: string, hospitalId: string, requestId: string | undefined, status: string, o: Record<string, unknown> = {}) =>
  envelope('hospital.acceptance.received', {
    responseId: `R-${uuid().slice(0, 8)}`, requestId: requestId ?? 'AR-none', caseId, hospitalId, status,
    acceptedCapabilities: status === 'REJECTED' || status === 'UNAVAILABLE' ? [] : ['EMERGENCY', 'TRAUMA', 'ICU'], limitations: [],
    respondedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 30 * 60_000).toISOString(), responderRole: 'CLINICAL_COORDINATOR', source: 'SYNTHETIC_DEMO', ...o,
  }, { type: 'hospital', id: hospitalId });

async function referralsAndAcceptance(api: Api) {
  console.log('\n[Phase 4] Hospital referrals and explicit acceptance');
  await reset(api);
  const crew = await api.socket(P.a1);
  const otherCrew = await api.socket(P.a2);
  const created = await api.post(P.a1, '/api/emergencies', intakeBody({ severity: 'CRITICAL', requiredCapabilities: [] }));
  const caseId: string = created.json?.caseId;
  await api.waitFor(async () => !!(await referralId(api, caseId, 'HOSP-BLR-004')));

  // the four kinds of information, kept apart
  const ov = await api.get(P.a1, `/api/cases/${caseId}/referrals`);
  const row = (id: string) => ov.json?.rows?.find((r: any) => r.hospitalId === id);
  check('crew reads the referral overview of its case', ov.status === 200 && ov.json.rows.length === 4, `${ov.status}`);
  check('listed (directory-level) vs assessed: incapable H3 lists neither trauma nor ICU and was not referred',
    JSON.stringify(row('HOSP-BLR-003')?.listed.missingRequired) === JSON.stringify(['TRAUMA', 'ICU']) && row('HOSP-BLR-003')?.referral.state === 'NOT_REQUESTED' && row('HOSP-BLR-003')?.assessment?.eligibility === 'INELIGIBLE');
  check('capable hospitals hold an outstanding, case-specific referral with a 15-minute deadline',
    ['HOSP-BLR-001', 'HOSP-BLR-002', 'HOSP-BLR-004'].every(h => row(h)?.referral.state === 'OUTSTANDING' && Math.round((Date.parse(row(h).referral.expiresAt) - Date.parse(row(h).referral.requestedAt)) / 60_000) === 15));
  check('no answer is assumed: no hospital has an answer yet', ov.json.rows.every((r: any) => !r.answer));
  check('capacity is a report, not a verification (seed / demo data is never "verified")', ov.json.rows.every((r: any) => r.capacity.verified === false && ['SEED', 'SYNTHETIC_DEMO'].includes(r.capacity.provenance)));
  check('patients do not see hospital answers → 403', (await api.get(P.pat1, `/api/cases/${caseId}/referrals`)).status === 403);
  check('an unrelated crew → 404', (await api.get(P.a2, `/api/cases/${caseId}/referrals`)).status === 404);
  check('a never-asked hospital → 404', (await api.get(P.h3, `/api/cases/${caseId}/referrals`)).status === 404);
  const h1view = await api.get(P.h1, `/api/cases/${caseId}/referrals`);
  check('a referred hospital sees only its own row', h1view.status === 200 && h1view.json.rows.length === 1 && h1view.json.rows[0].hospitalId === 'HOSP-BLR-001');

  // correlation: the right case, the right referral, possible times
  const r1 = await referralId(api, caseId, 'HOSP-BLR-001');
  check('answer naming another referral id → 409 request_mismatch', (await api.event(P.h1, answer(caseId, 'HOSP-BLR-001', 'AR-invented', 'ACCEPTED'))).json?.error === 'request_mismatch');
  const other = await api.post(P.a2, '/api/emergencies', intakeBody({ severity: 'CRITICAL', requiredCapabilities: [] }));
  const otherCase: string = other.json?.caseId;
  await api.waitFor(async () => !!(await referralId(api, otherCase, 'HOSP-BLR-001')));
  const crossCase = await api.event(P.h1, answer(otherCase, 'HOSP-BLR-001', r1, 'ACCEPTED'));
  check('an acceptance for one case cannot use another case\'s referral → 409', crossCase.status === 409 && crossCase.json?.error === 'request_mismatch', crossCase.text);
  check('answer dated in the future → 400', (await api.event(P.h1, answer(caseId, 'HOSP-BLR-001', r1, 'ACCEPTED', { respondedAt: new Date(Date.now() + 10 * 60_000).toISOString() }))).status === 400);
  check('acceptance valid for 7 hours → 400', (await api.event(P.h1, answer(caseId, 'HOSP-BLR-001', r1, 'ACCEPTED', { validUntil: new Date(Date.now() + 7 * 3600_000).toISOString() }))).status === 400);
  check('a clinician cannot answer for the hospital → 403', (await api.event(P.doc3, answer(caseId, 'HOSP-BLR-001', r1, 'ACCEPTED'))).status === 403);

  // explicit answers drive the destination
  check('H2 declines (REJECTED) → 202', (await api.event(P.h2, answer(caseId, 'HOSP-BLR-002', await referralId(api, caseId, 'HOSP-BLR-002'), 'REJECTED', { limitations: ['No ICU bed'] }))).status === 202);
  const acc = answer(caseId, 'HOSP-BLR-001', r1, 'ACCEPTED');
  check('H1 accepts its own referral → 202', (await api.event(P.h1, acc)).status === 202);
  const routed = await api.waitFor(async () => (await api.get(P.a1, '/api/ambulances')).json?.[0]?.destinationHospital === 'HOSP-BLR-001');
  check('the crew is routed to the hospital that explicitly accepted', routed);
  const ov2 = await api.get(P.mgmt, `/api/cases/${caseId}/referrals`);
  const r2 = (id: string) => ov2.json.rows.find((r: any) => r.hospitalId === id);
  check('overview: H1 answer ACCEPTED, current, provenance from the principal (demo → SYNTHETIC_DEMO)', r2('HOSP-BLR-001')?.answer?.status === 'ACCEPTED' && r2('HOSP-BLR-001').answer.current && r2('HOSP-BLR-001').answer.provenance === 'SYNTHETIC_DEMO' && r2('HOSP-BLR-001').answer.requestId === r1);
  check('overview: H2 refusal recorded with its limits', r2('HOSP-BLR-002')?.answer?.status === 'REJECTED' && r2('HOSP-BLR-002').answer.limitations[0] === 'No ICU bed');
  check('the other case is untouched by H1\'s acceptance of this case', !(await api.get(P.mgmt, `/api/cases/${otherCase}/referrals`)).json.rows.some((r: any) => r.answer));

  // duplicates and conflicts
  check('exact duplicate delivery → duplicate_ignored', (await api.event(P.h1, acc)).json?.status === 'duplicate_ignored');
  const conflicting = { ...acc, eventId: uuid(), payload: { ...(acc.payload as object), status: 'REJECTED' } };
  check('conflicting re-use of a responseId is accepted for audit but changes no decision', (await api.event(P.h1, conflicting)).status === 202);
  await new Promise(r => setTimeout(r, 400));
  check('…the crew keeps its destination', (await api.get(P.a1, '/api/ambulances')).json?.[0]?.destinationHospital === 'HOSP-BLR-001');
  check('…and the conflicting envelope is kept in the audit ledger', ((await api.get(P.mgmt, '/api/events/history?limit=1000')).json as any[]).some(e => e.eventId === conflicting.eventId));

  // "busy / unable to accept any patient" is part of the domain: UNAVAILABLE
  const r4 = await referralId(api, caseId, 'HOSP-BLR-004');
  check('H4 answers UNAVAILABLE (cannot take any patient now) → 202', (await api.event(P.h4, answer(caseId, 'HOSP-BLR-004', r4, 'UNAVAILABLE', { limitations: ['ED at capacity'] }))).status === 202);
  await api.waitFor(async () => ((await api.get(P.mgmt, '/api/hospitals')).json as any[]).find(h => h.hospitalId === 'HOSP-BLR-004')?.operationalState.acceptance === 'UNAVAILABLE');
  check('…recorded hospital-wide (legacy semantics) and visible in the overview', (await api.get(P.mgmt, `/api/cases/${caseId}/referrals`)).json.rows.find((r: any) => r.hospitalId === 'HOSP-BLR-004')?.answer?.status === 'UNAVAILABLE');

  // a short-lived acceptance lapses: case-scoped expiry reaches this crew only
  const shortCase = (await api.post(P.a3, '/api/emergencies', intakeBody({ severity: 'CRITICAL', requiredCapabilities: [] }))).json?.caseId as string;
  const shortCrew = await api.socket(P.a3);
  await api.waitFor(async () => !!(await referralId(api, shortCase, 'HOSP-BLR-001')));
  check('short acceptance (2 s) → 202', (await api.event(P.h1, answer(shortCase, 'HOSP-BLR-001', await referralId(api, shortCase, 'HOSP-BLR-001'), 'ACCEPTED', { validUntil: new Date(Date.now() + 2000).toISOString() }))).status === 202);
  const lapsed = await api.waitFor(async () => shortCrew.events.some(e => e.eventType === 'hospital.acceptance.expired' && e.payload.caseId === shortCase && e.payload.kind === 'RESPONSE_VALIDITY'), 8000);
  check('the lapse is announced to that case\'s crew (case-scoped, RESPONSE_VALIDITY)', lapsed);
  check('…and not to another case\'s crew', !crew.events.some(e => e.eventType === 'hospital.acceptance.expired' && e.payload.caseId === shortCase) && !otherCrew.events.some(e => e.eventType === 'hospital.acceptance.expired' && e.payload.caseId === shortCase));
  const ov3 = await api.get(P.mgmt, `/api/cases/${shortCase}/referrals`);
  check('overview marks the lapsed answer as not current', ov3.json.rows.find((r: any) => r.hospitalId === 'HOSP-BLR-001')?.answer?.current === false);
  check('the first case keeps its valid destination at the same hospital', (await api.get(P.a1, '/api/ambulances')).json?.[0]?.destinationHospital === 'HOSP-BLR-001');
  for (const s of [crew, otherCrew, shortCrew]) s.s.close();
}

// ------------------------------------------------------------------------------------------

async function main() {
  console.log('[Test] Emergency-to-care journey against a real API on :4101');
  const api = await startApi(4101);
  try {
    await emergencyIntake(api);
    await facilityDirectory(api);
    await referralsAndAcceptance(api);
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
