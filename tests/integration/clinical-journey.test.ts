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

// ------------------------------------------------------------------------------------------ phases 5–6

/** A crew reports a case and hospital `hospitalId` accepts it: the crew is routed there. */
async function routedCase(api: Api, crewPersona: string, crewId: string, hospitalId: string, hospitalPersona: string): Promise<string> {
  const caseId = (await api.post(crewPersona, '/api/emergencies', intakeBody({ severity: 'CRITICAL', requiredCapabilities: [] }))).json?.caseId as string;
  await api.waitFor(async () => !!(await referralId(api, caseId, hospitalId)));
  await api.event(hospitalPersona, answer(caseId, hospitalId, await referralId(api, caseId, hospitalId), 'ACCEPTED'));
  await api.waitFor(async () => ((await api.get(P.mgmt, '/api/ambulances')).json as any[]).find(a => a.ambulanceId === crewId)?.destinationHospital === hospitalId);
  return caseId;
}

const arrive = (api: Api, persona: string, hospitalId: string, caseId: string, o: Record<string, unknown> = {}) =>
  api.post(persona, `/api/hospitals/${hospitalId}/arrivals`, { clientRequestId: uuid(), caseId, ...o });
const handover = (api: Api, persona: string, encounterId: string, o: Record<string, unknown> = {}) =>
  api.post(persona, `/api/encounters/${encounterId}/handover`, { clientRequestId: uuid(), ...o });
const assignDoctor = (api: Api, persona: string, encounterId: string, practitionerId: string, o: Record<string, unknown> = {}) =>
  api.post(persona, `/api/encounters/${encounterId}/doctor`, { clientRequestId: uuid(), practitionerId, ...o });

async function arrivalAndHandover(api: Api): Promise<{ caseId: string; encounterId: string; gpsCase: string; gpsEncounter: string }> {
  console.log('\n[Phase 5] Hospital arrival, handover and encounter creation');
  await reset(api);
  const sockets = {
    patient: await api.socket(P.pat1), crew: await api.socket(P.a2), h1: await api.socket(P.h1), h2: await api.socket(P.h2),
    mgmt: await api.socket(P.mgmt), doc: await api.socket(P.doc3),
  };
  // The demo patient's own case (CASE-BLR-876), reported by AMB-BLR-002 and accepted by Hebbal (001).
  const caseId = (await api.post(P.a2, '/api/emergencies', intakeBody({ caseRef: 'CASE-BLR-876', severity: 'CRITICAL', requiredCapabilities: [] }))).json?.caseId as string;
  await api.waitFor(async () => !!(await referralId(api, caseId, 'HOSP-BLR-001')));
  await api.event(P.h1, answer(caseId, 'HOSP-BLR-001', await referralId(api, caseId, 'HOSP-BLR-001'), 'ACCEPTED'));
  await api.waitFor(async () => (await api.get(P.a2, '/api/ambulances')).json?.[0]?.destinationHospital === 'HOSP-BLR-001');

  // who may record an arrival
  const r2 = await arrive(api, P.h2, 'HOSP-BLR-001', caseId);
  check('another hospital cannot record an arrival here → 403', r2.status === 403 && r2.json?.code === 'OTHER_HOSPITAL', r2.text);
  for (const [name, persona] of [['clinician', P.doc3], ['ambulance crew', P.a2], ['patient', P.pat1], ['management', P.mgmt], ['admin', P.admin]] as const) {
    check(`${name} cannot record an arrival → 403`, (await arrive(api, persona, 'HOSP-BLR-001', caseId)).status === 403);
  }
  check('unauthenticated → 401', (await arrive(api, undefined as unknown as string, 'HOSP-BLR-001', caseId)).status === 401);
  const wrongHospital = await arrive(api, P.h4, 'HOSP-BLR-004', caseId);
  check('a hospital the case is not routed to / accepted by cannot claim it → 404 not_routed_here', wrongHospital.status === 404 && wrongHospital.json?.error === 'not_routed_here', wrongHospital.text);
  const unknown = await arrive(api, P.h1, 'HOSP-BLR-001', 'CASE-DOES-NOT-EXIST');
  check('unknown case reference answers the same (no existence oracle)', unknown.status === 404 && unknown.json?.error === 'not_routed_here');
  check('arrival in the future → 400', (await arrive(api, P.h1, 'HOSP-BLR-001', caseId, { arrivedAt: new Date(Date.now() + 10 * 60_000).toISOString() })).status === 400);
  check('arrival with a hospitalId in the body → 400 (hospital comes from the path and identity)', (await api.post(P.h1, '/api/hospitals/HOSP-BLR-001/arrivals', { clientRequestId: uuid(), caseId, hospitalId: 'HOSP-BLR-004' })).status === 400);

  // before any arrival record, the case is NOT in hospital care
  check('before arrival: no encounter exists for the patient', ((await api.get(P.pat1, '/api/encounters')).json as any[]).length === 0);

  const body = { clientRequestId: uuid(), caseId };
  const rec = await api.post(P.h1, '/api/hospitals/HOSP-BLR-001/arrivals', body);
  const encounterId: string = rec.json?.encounter?.encounterId;
  check('the destination hospital records the arrival → 201, encounter ARRIVED', rec.status === 201 && rec.json.encounter.status === 'ARRIVED' && /^ENC-BLR-001-[0-9A-F]{8}$/.test(encounterId), rec.text);
  check('encounter records actor, referral and ambulance', rec.json?.encounter?.arrival?.recordedBy?.userId === 'demo-hosp-1' && rec.json.encounter.referral?.requestId?.startsWith('AR-') && rec.json.encounter.ambulanceId === 'AMB-BLR-002');
  check('retry with the same clientRequestId → same result', (await api.post(P.h1, '/api/hospitals/HOSP-BLR-001/arrivals', body)).json?.encounter?.encounterId === encounterId);
  const dup = await arrive(api, P.h1, 'HOSP-BLR-001', caseId);
  check('a second arrival for the same case → 409 already_recorded (no duplicate encounter)', dup.status === 409 && dup.json?.error === 'already_recorded' && dup.json.encounterId === encounterId);
  const pat = (await api.get(P.mgmt, '/api/patients')).json.find((p: any) => p.patientId === caseId);
  check('case is ARRIVED and linked to the encounter (not yet in care)', pat?.currentStatus === 'ARRIVED' && pat.encounterId === encounterId);
  const amb = (await api.get(P.mgmt, '/api/ambulances')).json.find((a: any) => a.ambulanceId === 'AMB-BLR-002');
  check('the crew\'s unit is ARRIVED (authoritative arrival)', amb?.status === 'ARRIVED');
  const hist = (await api.get(P.mgmt, '/api/events/history?limit=500')).json as any[];
  check('ambulance.arrived carries basis HOSPITAL_CONFIRMED', hist.some(e => e.eventType === 'ambulance.arrived' && e.payload.caseId === caseId && e.payload.basis === 'HOSPITAL_CONFIRMED'));
  check('the case\'s other referrals were withdrawn (CASE_CLOSED)', hist.filter(e => e.eventType === 'hospital.acceptance.cancelled' && e.payload.caseId === caseId).every(e => e.payload.reason === 'CASE_CLOSED') && hist.some(e => e.eventType === 'hospital.acceptance.cancelled' && e.payload.caseId === caseId));

  // views
  const pv = (await api.get(P.pat1, '/api/encounters')).json as any[];
  check('patient sees their encounter (patient view: no staff user ids)', pv.length === 1 && pv[0].status === 'ARRIVED' && !('arrival' in pv[0]) && !JSON.stringify(pv[0]).includes('demo-hosp-1'));
  check('another patient sees nothing', ((await api.get(P.pat2, '/api/encounters')).json as any[]).length === 0);
  check('the crew sees a summary of its case encounter', (await api.get(P.a2, `/api/encounters/${encounterId}`)).json?.status === 'ARRIVED');
  check('management sees a summary (no doctor, no actors)', !('arrival' in ((await api.get(P.mgmt, `/api/encounters/${encounterId}`)).json ?? {})));
  check('another hospital cannot read it → 404', (await api.get(P.h2, `/api/encounters/${encounterId}`)).status === 404);
  check('an unassigned clinician at the same hospital cannot read it → 404', (await api.get(P.doc3, `/api/encounters/${encounterId}`)).status === 404);

  // handover
  check('another hospital cannot record the handover → 404', (await handover(api, P.h2, encounterId)).status === 404);
  check('the crew cannot record its own handover → 403', (await handover(api, P.a2, encounterId)).status === 403);
  check('the patient cannot record the handover → 403', (await handover(api, P.pat1, encounterId)).status === 403);
  check('an unassigned clinician cannot record it → 404', (await handover(api, P.doc3, encounterId)).status === 404);
  check('handover before the arrival time → 400', (await handover(api, P.h1, encounterId, { handedOverAt: new Date(Date.parse(rec.json.encounter.arrival.arrivedAt) - 60_000).toISOString() })).status === 400);
  const ho = await handover(api, P.h1, encounterId);
  check('the hospital records the handover → 200, encounter IN_CARE', ho.status === 200 && ho.json?.encounter?.status === 'IN_CARE' && ho.json.encounter.handover.recordedBy.userId === 'demo-hosp-1', ho.text);
  check('a second handover → 409 already_handed_over', (await handover(api, P.h1, encounterId)).json?.error === 'already_handed_over');
  check('case is HANDED_OVER (authoritative in-hospital care)', (await api.get(P.mgmt, '/api/patients')).json.find((p: any) => p.patientId === caseId)?.currentStatus === 'HANDED_OVER');
  const released = (await api.get(P.mgmt, '/api/ambulances')).json.find((a: any) => a.ambulanceId === 'AMB-BLR-002');
  check('the crew is released for the next job (AVAILABLE, no case)', released?.status === 'AVAILABLE' && !released.assignedPatient && !released.destinationHospital);
  check('…and can report a new emergency', (await api.post(P.a2, '/api/emergencies', intakeBody())).status === 202);
  check('the hospital still sees its patient after the crew left', ((await api.get(P.h1, '/api/patients')).json as any[]).some(p => p.patientId === caseId));

  await new Promise(r => setTimeout(r, 300));
  const got = (s: { events: any[] }, type: string) => s.events.some(e => e.eventType === type && e.payload.encounterId === encounterId);
  check('realtime: patient, crew, hospital and management receive arrival and handover', ['patient', 'crew', 'h1', 'mgmt'].every(k => got(sockets[k as keyof typeof sockets], 'encounter.arrival.recorded') && got(sockets[k as keyof typeof sockets], 'encounter.handover.recorded')));
  check('realtime: another hospital and an unassigned clinician receive nothing', !got(sockets.h2, 'encounter.arrival.recorded') && !got(sockets.doc, 'encounter.arrival.recorded'));
  const copy = (s: { events: any[] }) => s.events.find(e => e.eventType === 'encounter.arrival.recorded' && e.payload.encounterId === encounterId);
  check("the patient's, crew's and management's copies name the role only, never the staff member",
    ['patient', 'crew', 'mgmt'].every(k => { const c = copy(sockets[k as keyof typeof sockets]); return c?.payload.recordedBy?.role === 'HOSPITAL' && !('userId' in c.payload.recordedBy) && !JSON.stringify(c).includes('demo-hosp-1'); }));
  check("…the hospital's own staff see who recorded it", copy(sockets.h1)?.payload.recordedBy?.userId === 'demo-hosp-1');
  const ledgerCopy = ((await api.get(P.mgmt, '/api/events/history?limit=500')).json as any[]).find(e => e.eventType === 'encounter.handover.recorded' && e.payload.encounterId === encounterId);
  check('…and so does the ledger read for management', !!ledgerCopy && !('userId' in ledgerCopy.payload.recordedBy));
  const forged = envelope('encounter.handover.recorded', { encounterId, caseId, hospitalId: 'HOSP-BLR-001', handedOverAt: new Date().toISOString(), recordedBy: { userId: 'demo-hosp-1', role: 'HOSPITAL', hospitalId: 'HOSP-BLR-001' } }, { type: 'hospital', id: 'HOSP-BLR-001' });
  check('encounter events cannot be submitted directly, even by the hospital → 403 (commands only)', (await api.event(P.h1, forged)).status === 403);

  // a GPS geofence alone never creates an encounter
  const gpsCase = await routedCase(api, P.a1, 'AMB-BLR-001', 'HOSP-BLR-004', P.h4);
  const h4 = ((await api.get(P.mgmt, '/api/hospitals')).json as any[]).find(h => h.hospitalId === 'HOSP-BLR-004');
  const gps = await api.event(P.a1, envelope('ambulance.location.updated', { ambulanceId: 'AMB-BLR-001', coordinates: { latitude: h4.location.latitude, longitude: h4.location.longitude }, speedKmh: 5 }, { type: 'ambulance', id: 'AMB-BLR-001' }));
  check('crew GPS at the destination accepted → 202', gps.status === 202, gps.text);
  const gpsArrived = await api.waitFor(async () => (await api.get(P.mgmt, '/api/ambulances')).json.find((a: any) => a.ambulanceId === 'AMB-BLR-001')?.status === 'ARRIVED');
  check('GPS geofence marks the unit ARRIVED (derived signal)…', gpsArrived);
  check('…but creates no encounter and no in-hospital care', ((await api.get(P.mgmt, `/api/encounters?caseId=${gpsCase}`)).json as any[]).length === 0 && (await api.get(P.mgmt, '/api/patients')).json.find((p: any) => p.patientId === gpsCase)?.currentStatus === 'ARRIVED');
  const gpsRec = await arrive(api, P.h4, 'HOSP-BLR-004', gpsCase);
  check('hospital confirmation creates the encounter, keeping the GPS time as evidence', gpsRec.status === 201 && !!gpsRec.json.encounter.arrival.gpsArrivalAt, gpsRec.text);

  // diversion: the receiving hospital's record wins over the routed destination
  const divCase = (await api.post(P.a3, '/api/emergencies', intakeBody({ severity: 'CRITICAL', requiredCapabilities: [] }))).json?.caseId as string;
  await api.waitFor(async () => !!(await referralId(api, divCase, 'HOSP-BLR-001')) && !!(await referralId(api, divCase, 'HOSP-BLR-004')));
  await api.event(P.h1, answer(divCase, 'HOSP-BLR-001', await referralId(api, divCase, 'HOSP-BLR-001'), 'ACCEPTED'));
  await api.waitFor(async () => ((await api.get(P.mgmt, '/api/ambulances')).json as any[]).find(a => a.ambulanceId === 'AMB-BLR-003')?.destinationHospital === 'HOSP-BLR-001');
  await api.event(P.h4, answer(divCase, 'HOSP-BLR-004', await referralId(api, divCase, 'HOSP-BLR-004'), 'ACCEPTED'));
  const div = await arrive(api, P.h4, 'HOSP-BLR-004', divCase);
  check('diversion: a hospital that accepted the case records its arrival although the crew was routed elsewhere → 201', div.status === 201, div.text);
  const a3 = ((await api.get(P.mgmt, '/api/ambulances')).json as any[]).find(a => a.ambulanceId === 'AMB-BLR-003');
  check('…the crew is ARRIVED at the receiving hospital (no route kept to the routed one)', a3?.status === 'ARRIVED' && a3.destinationHospital === 'HOSP-BLR-004' && !a3.activeRoute, JSON.stringify({ status: a3?.status, dest: a3?.destinationHospital }));
  const divHist = (await api.get(P.mgmt, '/api/events/history?limit=1000')).json as any[];
  check('…ambulance.arrived names the receiving hospital; the referral to the routed hospital is withdrawn',
    divHist.some(e => e.eventType === 'ambulance.arrived' && e.payload.caseId === divCase && e.payload.hospitalId === 'HOSP-BLR-004' && e.payload.basis === 'HOSPITAL_CONFIRMED') &&
    divHist.some(e => e.eventType === 'hospital.acceptance.cancelled' && e.payload.caseId === divCase && e.payload.hospitalId === 'HOSP-BLR-001' && e.payload.reason === 'CASE_CLOSED'));
  check('…and the case points to the receiving hospital', (await api.get(P.mgmt, '/api/patients')).json.find((p: any) => p.patientId === divCase)?.assignedHospital === 'HOSP-BLR-004');
  check('the bypassed hospital can no longer record an arrival for the case → 404 not_routed_here', (await arrive(api, P.h1, 'HOSP-BLR-001', divCase)).json?.error === 'not_routed_here');
  for (const s of Object.values(sockets)) s.s.close();
  return { caseId, encounterId, gpsCase, gpsEncounter: gpsRec.json?.encounter?.encounterId };
}

async function doctorAssignment(api: Api, ctx: { caseId: string; encounterId: string; gpsEncounter: string }) {
  console.log('\n[Phase 6] Doctor assignment');
  const { encounterId } = ctx;
  const roster = await api.get(P.h1, '/api/hospitals/HOSP-BLR-001/clinicians');
  check('hospital reads its roster: synthetic demo clinicians, labelled', roster.status === 200 && roster.json.length === 2 && roster.json.every((p: any) => p.dataStatus === 'SYNTHETIC_DEMO' && p.hospitalId === 'HOSP-BLR-001'));
  check('a clinician of the hospital can read the roster', (await api.get(P.doc3, '/api/hospitals/HOSP-BLR-001/clinicians')).status === 200);
  for (const [name, persona] of [['another hospital', P.h2], ['management', P.mgmt], ['patient', P.pat1], ['crew', P.a1]] as const) {
    check(`${name} cannot read the roster → 403`, (await api.get(persona, '/api/hospitals/HOSP-BLR-001/clinicians')).status === 403);
  }

  check('no doctor before handover → 409 not_handed_over', (await assignDoctor(api, P.h4, ctx.gpsEncounter, 'PRAC-BLR-004-01')).json?.error === 'not_handed_over');
  const foreign = await assignDoctor(api, P.h1, encounterId, 'PRAC-BLR-004-01');
  check('a doctor of another hospital cannot be assigned → 422', foreign.status === 422 && foreign.json?.error === 'practitioner_not_eligible', foreign.text);
  check('another hospital cannot assign on this encounter → 404', (await assignDoctor(api, P.h2, encounterId, 'PRAC-BLR-001-01')).status === 404);
  check('a clinician cannot assign doctors → 404 (unassigned) ', (await assignDoctor(api, P.doc3, encounterId, 'PRAC-BLR-001-01')).status === 404);
  check('management cannot assign doctors → 403', (await assignDoctor(api, P.mgmt, encounterId, 'PRAC-BLR-001-01')).status === 403);
  check('first assignment cannot claim a reassignment reason → 400', (await assignDoctor(api, P.h1, encounterId, 'PRAC-BLR-001-01', { reason: 'SHIFT_HANDOVER' })).status === 400);

  const docSock = await api.socket(P.doc3);
  const mgmtSock = await api.socket(P.mgmt);
  const a1 = await assignDoctor(api, P.h1, encounterId, 'PRAC-BLR-001-01');
  check('the hospital assigns its doctor → 200 with who/when/why', a1.status === 200 && a1.json.encounter.assignedDoctor.practitionerId === 'PRAC-BLR-001-01' && a1.json.encounter.assignedDoctor.reason === 'INITIAL_ASSIGNMENT' && a1.json.encounter.assignedDoctor.assignedBy.userId === 'demo-hosp-1', a1.text);
  check('same doctor again → 409 already_assigned', (await assignDoctor(api, P.h1, encounterId, 'PRAC-BLR-001-01')).json?.error === 'already_assigned');
  check('the assigned doctor now sees the encounter', (await api.get(P.doc3, `/api/encounters/${encounterId}`)).json?.assignedDoctor?.practitionerId === 'PRAC-BLR-001-01');
  const pv = (await api.get(P.pat1, `/api/encounters/${encounterId}`)).json;
  check('the patient sees their doctor (name and specialty, no staff ids)', pv?.assignedDoctor?.displayName === 'Dr. Ravi Kumar' && !('assignedBy' in pv.assignedDoctor));
  check('management summary does not include the doctor', !('assignedDoctor' in ((await api.get(P.mgmt, `/api/encounters/${encounterId}`)).json ?? {})));
  await new Promise(r => setTimeout(r, 300));
  check('realtime: the doctor is notified; management is not', docSock.events.some(e => e.eventType === 'encounter.doctor.assigned' && e.payload.encounterId === encounterId) && !mgmtSock.events.some(e => e.eventType === 'encounter.doctor.assigned'));

  const a2 = await assignDoctor(api, P.h1, encounterId, 'PRAC-BLR-001-02', { reason: 'SHIFT_HANDOVER' });
  check('reassignment keeps the history and closes the previous assignment', a2.status === 200 && a2.json.encounter.assignmentHistory.length === 2 && !!a2.json.encounter.assignmentHistory[0].endedAt && a2.json.encounter.assignedDoctor.reason === 'SHIFT_HANDOVER');
  check('the previous doctor loses access', (await api.get(P.doc3, `/api/encounters/${encounterId}`)).status === 404);
  await new Promise(r => setTimeout(r, 300));
  check('…and is told (realtime, previous practitioner)', docSock.events.some(e => e.eventType === 'encounter.doctor.assigned' && e.payload.previousPractitionerId === 'PRAC-BLR-001-01'));
  const workload = (await api.get(P.h1, '/api/hospitals/HOSP-BLR-001/clinicians')).json as any[];
  check('roster shows current workload', workload.find(p => p.practitionerId === 'PRAC-BLR-001-02')?.activeEncounters === 1 && workload.find(p => p.practitionerId === 'PRAC-BLR-001-01')?.activeEncounters === 0);

  // inactive clinician (Indiranagar roster) on the GPS case once handed over
  await handover(api, P.h4, ctx.gpsEncounter);
  check('an inactive clinician cannot be assigned → 422', (await assignDoctor(api, P.h4, ctx.gpsEncounter, 'PRAC-BLR-004-03')).status === 422);
  check('an active Indiranagar clinician can', (await assignDoctor(api, P.h4, ctx.gpsEncounter, 'PRAC-BLR-004-01')).status === 200);
  docSock.s.close();
  mgmtSock.s.close();
  // hand the case back to the original doctor (demo-doc-3) for the clinical phases
  check('reassign back to demo-doc-3 for the clinical record phases', (await assignDoctor(api, P.h1, encounterId, 'PRAC-BLR-001-01', { reason: 'REASSIGNMENT' })).status === 200);
}

// ------------------------------------------------------------------------------------------

async function main() {
  console.log('[Test] Emergency-to-care journey against a real API on :4101');
  const api = await startApi(4101);
  try {
    await emergencyIntake(api);
    await facilityDirectory(api);
    await referralsAndAcceptance(api);
    const journey = await arrivalAndHandover(api);
    await doctorAssignment(api, journey);
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
