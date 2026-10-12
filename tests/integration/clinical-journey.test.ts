/**
 * Runtime integration suite for the emergency-to-care journey (phases 2–13), against a REAL API
 * process on :4101 (mock mapping, demo personas). Each section exercises one workflow end to end over
 * HTTP and Socket.IO, including the authorization and failure paths.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
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

// ------------------------------------------------------------------------------------------ phase 7

const RX = { medication: 'Amoxicillin', strength: '500 mg', dose: '1 capsule', route: 'ORAL', frequency: 'Every 8 hours', duration: '5 days' };
const prescribe = (api: Api, persona: string, encounterId: string, o: Record<string, unknown> = {}) =>
  api.post(persona, `/api/encounters/${encounterId}/prescriptions`, { clientRequestId: uuid(), ...RX, ...o });
const reportBody = (o: Record<string, unknown> = {}) => ({
  clientRequestId: uuid(), category: 'LABORATORY', title: 'Complete blood count', findings: 'Hb 13.1 g/dL; WBC 9.8 x10^9/L', conclusion: 'Within normal limits',
  effectiveAt: new Date(Date.now() - 10 * 60_000).toISOString(), documentIds: [], patientVisible: false, status: 'PRELIMINARY', ...o,
});

async function clinicalRecords(api: Api, ctx: { caseId: string; encounterId: string; gpsEncounter: string }) {
  console.log('\n[Phase 7] Clinical records and prescriptions');
  const { encounterId } = ctx;
  const sock = { doc: await api.socket(P.doc3), patient: await api.socket(P.pat1), mgmt: await api.socket(P.mgmt), h1: await api.socket(P.h1) };

  // who may write
  const coord = await prescribe(api, P.h1, encounterId);
  check('the hospital coordinator cannot prescribe → 403 ASSIGNED_CLINICIAN_ONLY', coord.status === 403 && coord.json?.code === 'ASSIGNED_CLINICIAN_ONLY', coord.text);
  check('the patient cannot write clinical records → 403 READ_ONLY', (await prescribe(api, P.pat1, encounterId)).json?.code === 'READ_ONLY');
  check('a clinician of another hospital → 404', (await prescribe(api, P.doc1, encounterId)).status === 404);
  check('management → 403', (await prescribe(api, P.mgmt, encounterId)).status === 403);
  check('the released crew → 404', (await prescribe(api, P.a2, encounterId)).status === 404);
  check('unauthenticated → 401', (await prescribe(api, undefined as unknown as string, encounterId)).status === 401);

  // validation
  check('missing dose → 400 with the field', (await prescribe(api, P.doc3, encounterId, { dose: undefined })).json?.issues?.some((i: any) => i.path === 'dose'));
  check('unknown route → 400', (await prescribe(api, P.doc3, encounterId, { route: 'SNORTED' })).status === 400);
  check('unknown field (author override) → 400', (await prescribe(api, P.doc3, encounterId, { recordedBy: { userId: 'someone-else' } })).status === 400);
  check('over-long medication name → 400', (await prescribe(api, P.doc3, encounterId, { medication: 'x'.repeat(200) })).status === 400);
  check('control characters → 400', (await prescribe(api, P.doc3, encounterId, { instructions: 'take\u0000now' })).status === 400);

  // create
  const body = { clientRequestId: uuid(), ...RX };
  const created = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, body);
  const rx = created.json?.prescription;
  check('the assigned doctor prescribes → 201, ACTIVE v1, author from the principal', created.status === 201 && rx?.current?.status === 'ACTIVE' && rx.current.version === 1 && rx.current.recordedBy.userId === 'demo-doc-3' && rx.current.author.displayName === 'Dr. Ravi Kumar', created.text);
  check('retry with the same clientRequestId → same prescription', (await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, body)).json?.prescription?.prescriptionId === rx?.prescriptionId);
  check('the same key with a different body → 422', (await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, { ...body, dose: '2 capsules' })).status === 422);
  check('the server list has exactly one prescription (the response is backed by stored state)', ((await api.get(P.doc3, `/api/encounters/${encounterId}/prescriptions`)).json as any[]).length === 1);

  // reads
  const pv = (await api.get(P.pat1, `/api/encounters/${encounterId}/prescriptions`)).json as any[];
  check('the patient reads their prescription: medication, prescriber name, no staff ids', pv?.length === 1 && pv[0].medication === 'Amoxicillin' && pv[0].prescribedBy?.displayName === 'Dr. Ravi Kumar' && !JSON.stringify(pv).includes('demo-doc-3') && !('history' in pv[0]));
  check('another patient → 404', (await api.get(P.pat2, `/api/encounters/${encounterId}/prescriptions`)).status === 404);
  check('the hospital coordinator cannot read clinical content → 403', (await api.get(P.h1, `/api/encounters/${encounterId}/prescriptions`)).json?.code === 'NO_CLINICAL_ACCESS');
  check('management cannot read clinical content → 403', (await api.get(P.mgmt, `/api/encounters/${encounterId}/prescriptions`)).status === 403);
  check('a clinician of another hospital → 404', (await api.get(P.doc1, `/api/encounters/${encounterId}/prescriptions`)).status === 404);

  // amend / discontinue
  const rxId = rx?.prescriptionId;
  const amendBody = (o: Record<string, unknown> = {}) => ({ clientRequestId: uuid(), expectedVersion: 1, changeReason: 'Weight-based dose', ...RX, dose: '2 capsules', ...o });
  check('amending without a reason → 400', (await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/amend`, amendBody({ changeReason: undefined }))).status === 400);
  const stale = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/amend`, amendBody({ expectedVersion: 7 }));
  check('a stale edit → 409 version_conflict with the current version', stale.status === 409 && stale.json?.error === 'version_conflict' && stale.json.currentVersion === 1, stale.text);
  check('the coordinator cannot amend → 403', (await api.post(P.h1, `/api/encounters/${encounterId}/prescriptions/${rxId}/amend`, amendBody())).status === 403);
  const amended = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/amend`, amendBody());
  check('amend → v2 AMENDED, v1 kept in the history', amended.status === 200 && amended.json?.prescription?.current?.version === 2 && amended.json.prescription.history[0].dose === '1 capsule' && amended.json.prescription.current.changeReason === 'Weight-based dose', amended.text);
  const disc = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/discontinue`, { clientRequestId: uuid(), expectedVersion: 2, changeReason: 'Rash after the second dose' });
  check('discontinue → v3 DISCONTINUED', disc.status === 200 && disc.json?.prescription?.current?.status === 'DISCONTINUED' && disc.json.prescription.current.version === 3);
  check('a discontinued prescription cannot be amended → 409', (await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/amend`, amendBody({ expectedVersion: 3 }))).json?.error === 'discontinued');
  check('a prescription id of another encounter answers 404 (no cross-encounter access)', (await api.post(P.doc1, `/api/encounters/${ctx.gpsEncounter}/prescriptions/${rxId}/discontinue`, { clientRequestId: uuid(), expectedVersion: 3, changeReason: 'x' })).status === 404);
  const pv2 = (await api.get(P.pat1, `/api/encounters/${encounterId}/prescriptions`)).json as any[];
  check('the patient sees it discontinued, without the internal reason', pv2[0]?.status === 'DISCONTINUED' && !JSON.stringify(pv2).includes('Rash after'));

  // reports
  const prelim = await api.post(P.doc3, `/api/encounters/${encounterId}/reports`, reportBody());
  const report = prelim.json?.report;
  check('the doctor records a preliminary, unreleased lab report → 201', prelim.status === 201 && report?.current?.status === 'PRELIMINARY' && report.current.patientVisible === false, prelim.text);
  check('unreleased: the patient does not see it in the list', ((await api.get(P.pat1, `/api/encounters/${encounterId}/reports`)).json as any[]).length === 0);
  check('unreleased: the patient gets 404 by id', (await api.get(P.pat1, `/api/encounters/${encounterId}/reports/${report?.reportId}`)).status === 404);
  check('a report dated in the future → 400', (await api.post(P.doc3, `/api/encounters/${encounterId}/reports`, reportBody({ effectiveAt: new Date(Date.now() + 3600_000).toISOString() }))).status === 400);
  check('attaching an unknown document → 422 invalid_document', (await api.post(P.doc3, `/api/encounters/${encounterId}/reports`, reportBody({ documentIds: ['DOC-NOPE'] }))).json?.error === 'invalid_document');
  const amendR = (o: Record<string, unknown>) => api.post(P.doc3, `/api/encounters/${encounterId}/reports/${report?.reportId}/amend`, { ...reportBody(), expectedVersion: 1, changeReason: 'Verified', ...o });
  const fin = await amendR({ status: 'FINAL', patientVisible: true, effectiveAt: report?.current?.effectiveAt });
  check('finalised and released → FINAL v2, visible to the patient', fin.status === 200 && fin.json?.report?.current?.status === 'FINAL' && fin.json.report.current.patientVisible === true, fin.text);
  const prv = (await api.get(P.pat1, `/api/encounters/${encounterId}/reports`)).json as any[];
  check('the patient now reads it: title, findings, author name, no staff ids, no history', prv.length === 1 && prv[0].title === 'Complete blood count' && prv[0].reportedBy?.displayName === 'Dr. Ravi Kumar' && !JSON.stringify(prv).includes('demo-doc-3') && !('history' in prv[0]));
  check('a final report cannot return to preliminary → 409', (await amendR({ expectedVersion: 2, status: 'PRELIMINARY', patientVisible: true, effectiveAt: report?.current?.effectiveAt })).json?.error === 'final_report');
  const corr = await amendR({ expectedVersion: 2, status: 'FINAL', patientVisible: true, effectiveAt: report?.current?.effectiveAt, findings: 'Hb 12.9 g/dL; WBC 9.8 x10^9/L', changeReason: 'Transcription error' });
  check('a corrected final report becomes AMENDED (v3)', corr.json?.report?.current?.status === 'AMENDED' && corr.json.report.current.version === 3);
  check("another hospital's clinician cannot read it through their own encounter path → 404", (await api.get(P.doc1, `/api/encounters/${ctx.gpsEncounter}/reports/${report?.reportId}`)).status === 404);
  check('the coordinator cannot read reports → 403', (await api.get(P.h1, `/api/encounters/${encounterId}/reports`)).status === 403);

  // realtime: content-free events, to the doctor and the patient only
  await new Promise(r => setTimeout(r, 300));
  const rxEvents = sock.doc.events.filter(e => e.eventType === 'clinical.prescription.recorded');
  check('realtime: the doctor receives three prescription events, none carrying the medication', rxEvents.length === 3 && !JSON.stringify(rxEvents).includes('Amoxicillin'));
  check('realtime: the patient receives them, role-only author', sock.patient.events.filter(e => e.eventType === 'clinical.prescription.recorded').length === 3 && !JSON.stringify(sock.patient.events).includes('demo-doc-3'));
  check('realtime: the patient did not receive the unreleased report version', !sock.patient.events.some(e => e.eventType === 'clinical.report.recorded' && e.payload.version === 1));
  check('realtime: management and the coordinator receive no clinical events', ![sock.mgmt, sock.h1].some(s => s.events.some(e => e.eventType.startsWith('clinical.'))));
  const ledger = (await api.get(P.mgmt, '/api/events/history?limit=1000')).json as any[];
  check('the management ledger read lists no clinical events', !ledger.some(e => e.eventType.startsWith('clinical.')));

  // reassignment moves write access
  check('reassign to another doctor', (await assignDoctor(api, P.h1, encounterId, 'PRAC-BLR-001-02', { reason: 'SHIFT_HANDOVER' })).status === 200);
  check('the previous doctor can no longer read or write the records → 404', (await api.get(P.doc3, `/api/encounters/${encounterId}/prescriptions`)).status === 404 && (await prescribe(api, P.doc3, encounterId)).status === 404);
  check('reassign back to demo-doc-3', (await assignDoctor(api, P.h1, encounterId, 'PRAC-BLR-001-01', { reason: 'REASSIGNMENT' })).status === 200);
  check('…who reads the full history again', ((await api.get(P.doc3, `/api/encounters/${encounterId}/prescriptions`)).json as any[])[0]?.history?.length === 3);
  for (const s of Object.values(sock)) s.s.close();
}

// ------------------------------------------------------------------------------------------ phase 8

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PNG_FILE = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic chest x-ray for the demo '.repeat(40))]);
const PDF_FILE = Buffer.from(`%PDF-1.4\n% synthetic ECG trace\n${'0 '.repeat(500)}\n%%EOF\n`, 'latin1');
const HTML_FILE = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');

const intent = (api: Api, persona: string, encounterId: string, file: Buffer, o: Record<string, unknown> = {}) =>
  api.post(persona, `/api/encounters/${encounterId}/documents`, {
    clientRequestId: uuid(), category: 'IMAGING', title: 'Chest X-ray (PA)', fileName: 'chest-xray.png', contentType: 'image/png',
    sizeBytes: file.length, sha256: sha(file), patientVisible: false, ...o,
  });
const upload = (api: Api, persona: string, url: string, file: Buffer, contentType = 'image/png') =>
  api.req('PUT', url, persona, undefined, { raw: file, headers: { 'content-type': contentType } });

async function diagnosticDocuments(api: Api, ctx: { caseId: string; encounterId: string; gpsEncounter: string }) {
  console.log('\n[Phase 8] Diagnostic documents and secure file storage');
  const { encounterId } = ctx;
  const sock = { doc: await api.socket(P.doc3), patient: await api.socket(P.pat1) };

  // the JSON API keeps its limit: large files never travel through it
  const big = await api.req('POST', '/api/events', P.mgmt, undefined, { raw: JSON.stringify({ blob: 'x'.repeat(150_000) }) });
  check('the JSON API keeps its 100 kB limit (150 kB body → 413)', big.status === 413, `${big.status}`);

  // who may declare an upload
  check('the coordinator cannot upload → 403', (await intent(api, P.h1, encounterId, PNG_FILE)).status === 403);
  check('the patient cannot upload → 403', (await intent(api, P.pat1, encounterId, PNG_FILE)).status === 403);
  check("another hospital's clinician → 404", (await intent(api, P.doc1, encounterId, PNG_FILE)).status === 404);
  check('unauthenticated → 401', (await intent(api, undefined as unknown as string, encounterId, PNG_FILE)).status === 401);
  // what may be declared
  check('an unsupported type (text/html) → 400', (await intent(api, P.doc3, encounterId, HTML_FILE, { contentType: 'text/html' })).status === 400);
  check('more than 20 MB → 400', (await intent(api, P.doc3, encounterId, PNG_FILE, { sizeBytes: 20 * 1024 * 1024 + 1 })).status === 400);
  check('an empty file → 400', (await intent(api, P.doc3, encounterId, PNG_FILE, { sizeBytes: 0 })).status === 400);
  check('a malformed sha256 → 400', (await intent(api, P.doc3, encounterId, PNG_FILE, { sha256: 'abc' })).status === 400);

  const body = { clientRequestId: uuid(), category: 'IMAGING', title: 'Chest X-ray (PA)', fileName: '../../secret/chest-xray.png', contentType: 'image/png', sizeBytes: PNG_FILE.length, sha256: sha(PNG_FILE), patientVisible: false };
  const created = await api.post(P.doc3, `/api/encounters/${encounterId}/documents`, body);
  const docId: string = created.json?.document?.documentId;
  const url: string = created.json?.upload?.url;
  check('the assigned doctor declares an upload → 201, PENDING_UPLOAD, a one-time upload URL', created.status === 201 && created.json.document.status === 'PENDING_UPLOAD' && /^\/api\/uploads\/[A-Za-z0-9_-]{43}$/.test(url ?? ''), created.text);
  check('the file name is a display name only (no directories)', created.json?.document?.fileName === 'chest-xray.png');
  check('retrying the declaration returns the same document', (await api.post(P.doc3, `/api/encounters/${encounterId}/documents`, body)).json?.document?.documentId === docId);
  check('the upload URL is bound to its uploader: the patient → 404', (await upload(api, P.pat1, url, PNG_FILE)).status === 404);
  check("…and another clinician → 404", (await upload(api, P.doc1, url, PNG_FILE)).status === 404);
  check('a different content type than declared → 415', (await upload(api, P.doc3, url, PNG_FILE, 'image/jpeg')).status === 415);
  check('nothing downloadable before the upload → 409', (await api.get(P.doc3, `/api/encounters/${encounterId}/documents/${docId}/content`)).status === 409);
  const up = await upload(api, P.doc3, url, PNG_FILE);
  check('upload → 200, verified (size, sha256, signature) and AVAILABLE', up.status === 200 && up.json?.document?.status === 'AVAILABLE' && !!up.json.document.uploadedAt, up.text);
  check('the upload URL cannot be used twice → 404', (await upload(api, P.doc3, url, PNG_FILE)).status === 404);

  // integrity failures
  const tampered = await intent(api, P.doc3, encounterId, PNG_FILE);
  const changed = Buffer.from(PNG_FILE);
  changed[20] ^= 0xff;
  const t1 = await upload(api, P.doc3, tampered.json.upload.url, changed);
  check('bytes that differ from the declared sha256 → 422 HASH_MISMATCH, not stored', t1.status === 422 && t1.json?.reason === 'HASH_MISMATCH', t1.text);
  const disguised = await intent(api, P.doc3, encounterId, HTML_FILE, { contentType: 'application/pdf', fileName: 'report.pdf', category: 'LABORATORY', title: 'Lab report' });
  const t2 = await upload(api, P.doc3, disguised.json.upload.url, HTML_FILE, 'application/pdf');
  check('an HTML page declared as a PDF → 422 CONTENT_TYPE_MISMATCH (file signature)', t2.status === 422 && t2.json?.reason === 'CONTENT_TYPE_MISMATCH', t2.text);
  const short = await intent(api, P.doc3, encounterId, PDF_FILE, { contentType: 'application/pdf', fileName: 'ecg.pdf', category: 'ECG', title: 'ECG' });
  const t3 = await upload(api, P.doc3, short.json.upload.url, PDF_FILE.subarray(0, 100), 'application/pdf');
  check('a file of another size than declared → 400 size_mismatch, nothing read or stored', t3.status === 400 && t3.json?.error === 'size_mismatch', t3.text);
  const listed = (await api.get(P.doc3, `/api/encounters/${encounterId}/documents`)).json as any[];
  check('rejected uploads are listed as REJECTED with the reason (never silently dropped)', listed.filter(d => d.status === 'REJECTED').map(d => d.rejectionReason).sort().join(',') === 'CONTENT_TYPE_MISMATCH,HASH_MISMATCH', JSON.stringify(listed.map(d => [d.status, d.rejectionReason])));

  // an upload window that lapses
  const lapsing = await intent(api, P.doc3, encounterId, PNG_FILE, { title: 'Lapsing upload' });
  await new Promise(r => setTimeout(r, 3300));
  const late = await upload(api, P.doc3, lapsing.json.upload.url, PNG_FILE);
  check('an upload after its window → 410, the document closed as UPLOAD_EXPIRED', late.status === 410 && ((await api.get(P.doc3, `/api/encounters/${encounterId}/documents`)).json as any[]).some(d => d.documentId === lapsing.json.document.documentId && d.rejectionReason === 'UPLOAD_EXPIRED'), late.text);

  // download
  const dl = await api.get(P.doc3, `/api/encounters/${encounterId}/documents/${docId}/content`);
  check('the doctor downloads exactly the uploaded bytes', dl.status === 200 && dl.body.equals(PNG_FILE));
  check('download headers: declared type, attachment, nosniff, no-store, sandbox', dl.headers.get('content-type') === 'image/png' && /^attachment;/.test(dl.headers.get('content-disposition') ?? '') && dl.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(dl.headers.get('cache-control') ?? '') && /sandbox/.test(dl.headers.get('content-security-policy') ?? ''));
  check('not shared yet: the patient does not see it', !((await api.get(P.pat1, `/api/encounters/${encounterId}/documents`)).json as any[]).some(d => d.documentId === docId));
  check('not shared yet: the patient cannot download it → 404', (await api.get(P.pat1, `/api/encounters/${encounterId}/documents/${docId}/content`)).status === 404);
  check('the coordinator cannot download clinical documents → 403', (await api.get(P.h1, `/api/encounters/${encounterId}/documents/${docId}/content`)).status === 403);
  check('management cannot → 403', (await api.get(P.mgmt, `/api/encounters/${encounterId}/documents/${docId}/content`)).status === 403);
  check('another patient → 404', (await api.get(P.pat2, `/api/encounters/${encounterId}/documents/${docId}/content`)).status === 404);
  check("another hospital's clinician, through their own encounter → 404 (no identifier swapping)", (await api.get(P.doc1, `/api/encounters/${ctx.gpsEncounter}/documents/${docId}/content`)).status === 404);

  // attach to a report and share it: the patient can now open the image
  const rep = await api.post(P.doc3, `/api/encounters/${encounterId}/reports`, reportBody({ category: 'IMAGING', title: 'Chest X-ray', findings: 'No acute abnormality (synthetic).', documentIds: [docId], status: 'FINAL' }));
  check('an imaging report with the X-ray attached → 201', rep.status === 201 && rep.json?.report?.current?.documentIds?.[0] === docId, rep.text);
  check('a rejected document cannot be attached → 422', (await api.post(P.doc3, `/api/encounters/${encounterId}/reports`, reportBody({ documentIds: [tampered.json.document.documentId] }))).json?.error === 'invalid_document');
  const shared = await api.post(P.doc3, `/api/encounters/${encounterId}/reports/${rep.json?.report?.reportId}/amend`, { ...reportBody({ category: 'IMAGING', title: 'Chest X-ray', findings: 'No acute abnormality (synthetic).', documentIds: [docId], status: 'FINAL', patientVisible: true, effectiveAt: rep.json?.report?.current?.effectiveAt }), expectedVersion: 1, changeReason: 'Shared with the patient' });
  check('the report is shared with the patient', shared.status === 200 && shared.json.report.current.patientVisible === true, shared.text);
  const pr = ((await api.get(P.pat1, `/api/encounters/${encounterId}/reports`)).json as any[]).find(r => r.title === 'Chest X-ray');
  check('the patient sees the report with its image attached', pr?.documentIds?.includes(docId));
  const pdoc = ((await api.get(P.pat1, `/api/encounters/${encounterId}/documents`)).json as any[]).find(d => d.documentId === docId);
  check('…and the document in their list, without staff ids or the hash', !!pdoc && pdoc.uploadedBy?.displayName === 'Dr. Ravi Kumar' && !JSON.stringify(pdoc).includes('demo-doc-3') && !('sha256' in pdoc));
  const pdl = await api.get(P.pat1, `/api/encounters/${encounterId}/documents/${docId}/content`);
  check('…and downloads the same bytes', pdl.status === 200 && pdl.body.equals(PNG_FILE));
  check('another patient still cannot → 404', (await api.get(P.pat2, `/api/encounters/${encounterId}/documents/${docId}/content`)).status === 404);

  await new Promise(r => setTimeout(r, 300));
  const stored = sock.doc.events.filter(e => e.eventType === 'clinical.document.stored');
  check('realtime: the doctor is told the document is stored — metadata only, never the bytes', stored.length === 1 && stored[0].payload.documentId === docId && JSON.stringify(stored[0]).length < 2000);
  check('realtime: the patient was not told about the unshared upload', !sock.patient.events.some(e => e.eventType === 'clinical.document.stored'));
  for (const s of Object.values(sock)) s.s.close();
}

// ------------------------------------------------------------------------------------------ phase 9

async function patientDashboard(api: Api, ctx: { caseId: string; encounterId: string }) {
  console.log('\n[Phase 9] Patient dashboard: authoritative state B, refresh and reconnection');
  const { caseId, encounterId } = ctx;
  const mine = ((await api.get(P.pat1, '/api/encounters')).json as any[])[0];
  check('state B is driven by the encounter: IN_CARE with the assigned doctor, for the patient', mine?.status === 'IN_CARE' && mine.assignedDoctor?.displayName === 'Dr. Ravi Kumar' && !!mine.handedOverAt);
  const pat = ((await api.get(P.pat1, '/api/patients')).json as any[])[0];
  check('the case status agrees (HANDED_OVER) and links the encounter', pat?.currentStatus === 'HANDED_OVER' && pat.encounterId === encounterId);
  const rxRes = await api.get(P.pat1, `/api/encounters/${encounterId}/prescriptions`);
  check('personal data is never cached by browsers (Cache-Control: no-store)', rxRes.headers.get('cache-control') === 'no-store' && (await api.get(P.pat1, '/api/encounters')).headers.get('cache-control') === 'no-store');

  // a dropped realtime connection: state is recovered from the API, nothing depends on missed events
  const first = await api.socket(P.pat1);
  first.s.close();
  const missed = await prescribe(api, P.doc3, encounterId, { medication: 'Paracetamol', strength: '500 mg', dose: '1 tablet', frequency: 'Every 6 hours as needed', duration: undefined });
  check('while the patient was offline, the doctor prescribed', missed.status === 201, missed.text);
  const again = await api.socket(P.pat1);
  const after = (await api.get(P.pat1, `/api/encounters/${encounterId}/prescriptions`)).json as any[];
  check('after reconnecting, a refresh shows the new prescription', after.some(r => r.medication === 'Paracetamol' && r.status === 'ACTIVE'));
  const timeline = (await api.get(P.pat1, `/api/cases/${caseId}/timeline`)).json as any[];
  const rxEvent = timeline.find(e => e.eventType === 'clinical.prescription.recorded' && e.payload.prescriptionId === missed.json?.prescription?.prescriptionId);
  check('…and the case history includes the missed (content-free) event, author by role only', !!rxEvent && !('userId' in rxEvent.payload.recordedBy) && !JSON.stringify(rxEvent).includes('Paracetamol'));
  check('the history never lists unshared reports or documents', !timeline.some(e => (e.eventType === 'clinical.report.recorded' || e.eventType === 'clinical.document.stored') && e.payload.patientVisible === false));
  check("another patient cannot read this patient's history → 403", (await api.get(P.pat2, `/api/cases/${caseId}/timeline`)).status === 403);
  check("…or this patient's encounter → 404", (await api.get(P.pat2, `/api/encounters/${encounterId}`)).status === 404);
  await new Promise(r => setTimeout(r, 200));
  check('realtime resumes on the new connection (no stale room: only this case)', again.events.every(e => !e.payload?.caseId || e.payload.caseId === caseId));
  again.s.close();
}

// ------------------------------------------------------------------------------------------ phase 10

const vitalsBody = (measurements: unknown[], o: Record<string, unknown> = {}) => ({ clientRequestId: uuid(), measurements, ...o });
const nowIso = (offsetMin = 0) => new Date(Date.now() + offsetMin * 60_000).toISOString();

async function medicalTelemetry(api: Api, ctx: { caseId: string; encounterId: string }) {
  console.log('\n[Phase 10] Medical telemetry');
  const { encounterId } = ctx;
  const path = `/api/encounters/${encounterId}/vitals`;
  const sock = await api.socket(P.pat1);

  const empty = (await api.get(P.pat1, path)).json;
  check('before any measurement: nothing is shown or invented', Object.keys(empty?.latest ?? { x: 1 }).length === 0 && empty.measurements.length === 0);
  check('no medical device is integrated, and the API says so', empty?.sources?.medicalDeviceIntegrated === false);
  check('the patient is never offered the simulator', empty?.sources?.simulationAvailable === false);
  check('the assigned doctor (demo mode) can use the labelled simulator', (await api.get(P.doc3, path)).json?.sources?.simulationAvailable === true);

  // who may record
  const hr = { type: 'HEART_RATE', value: 98, unit: 'bpm', observedAt: nowIso(-2) };
  check('the coordinator cannot record or read vital signs → 403', (await api.post(P.h1, path, vitalsBody([hr]))).status === 403 && (await api.get(P.h1, path)).status === 403);
  check('the patient cannot record → 403', (await api.post(P.pat1, path, vitalsBody([hr]))).json?.code === 'READ_ONLY');
  check("another hospital's clinician → 404", (await api.post(P.doc1, path, vitalsBody([hr]))).status === 404);
  check('another patient cannot read → 404', (await api.get(P.pat2, path)).status === 404);

  // validation
  check('an implausible value → 400', (await api.post(P.doc3, path, vitalsBody([{ ...hr, value: 400 }]))).status === 400);
  check('a wrong unit → 400', (await api.post(P.doc3, path, vitalsBody([{ type: 'TEMPERATURE', value: 98.6, unit: 'degF', observedAt: nowIso() }]))).status === 400);
  check('systolic below diastolic → 400', (await api.post(P.doc3, path, vitalsBody([{ type: 'BLOOD_PRESSURE', value: 80, secondaryValue: 90, unit: 'mmHg', observedAt: nowIso() }]))).status === 400);
  check('a future observation → 400', (await api.post(P.doc3, path, vitalsBody([{ ...hr, observedAt: nowIso(30) }]))).status === 400);
  check('a client cannot claim a device source → 400', (await api.post(P.doc3, path, vitalsBody([{ ...hr, source: 'MEDICAL_DEVICE' }]))).status === 400);

  const rec = await api.post(P.doc3, path, vitalsBody([hr, { type: 'SPO2', value: 96, unit: '%', observedAt: nowIso(-2) }, { type: 'BLOOD_PRESSURE', value: 128, secondaryValue: 84, unit: 'mmHg', observedAt: nowIso(-2) }]));
  check('the doctor records vital signs → 201, source MANUAL_CLINICIAN (decided by the server)', rec.status === 201 && rec.json.measurements.length === 3 && rec.json.measurements.every((m: any) => m.source === 'MANUAL_CLINICIAN'), rec.text);
  const pv = (await api.get(P.pat1, path)).json;
  check('the patient sees the latest values with unit, source, recorder name and freshness', pv.latest.HEART_RATE?.value === 98 && pv.latest.HEART_RATE.unit === 'bpm' && pv.latest.HEART_RATE.source === 'MANUAL_CLINICIAN' && pv.latest.HEART_RATE.recordedByName === 'Dr. Ravi Kumar' && pv.latest.HEART_RATE.freshness === 'FRESH');
  check('…without staff ids', !JSON.stringify(pv).includes('demo-doc-3'));
  check('types never measured stay absent (no invented temperature)', !('TEMPERATURE' in pv.latest));

  const sim = await api.post(P.doc3, `${path}/simulate`, { clientRequestId: uuid() });
  check('demo simulator → 201, every value labelled DEVICE_SIMULATED / SYNTHETIC_DEMO with the simulated device id', sim.status === 201 && sim.json.simulated === true && sim.json.measurements.length === 5 && sim.json.measurements.every((m: any) => m.source === 'DEVICE_SIMULATED' && m.dataStatus === 'SYNTHETIC_DEMO' && m.deviceId === 'SIM-BEDSIDE-MONITOR'), sim.text);
  check('the patient cannot run the simulator → 403', (await api.post(P.pat1, `${path}/simulate`, { clientRequestId: uuid() })).status === 403);
  check('the coordinator cannot → 403', (await api.post(P.h1, `${path}/simulate`, { clientRequestId: uuid() })).status === 403);
  const pv2 = (await api.get(P.pat1, path)).json;
  check('the patient sees simulated values marked as simulated, never as a device measurement', pv2.latest.TEMPERATURE?.source === 'DEVICE_SIMULATED' && pv2.measurements.every((m: any) => m.source !== 'MEDICAL_DEVICE'));

  await new Promise(r => setTimeout(r, 300));
  const ev = sock.events.filter(e => e.eventType === 'clinical.telemetry.recorded');
  check('realtime: the patient is told about new measurements — types and times only, no values', ev.length === 2 && ev.every(e => !('value' in e.payload) && !JSON.stringify(e.payload).includes('"value"')) && ev.some(e => e.payload.source === 'DEVICE_SIMULATED'));
  check('the management ledger read lists no telemetry events', !((await api.get(P.mgmt, '/api/events/history?limit=1000')).json as any[]).some(e => e.eventType === 'clinical.telemetry.recorded'));
  sock.s.close();
}

// ------------------------------------------------------------------------------------------

async function main() {
  console.log('[Test] Emergency-to-care journey against a real API on :4101');
  const documentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-journey-docs-'));
  const api = await startApi(4101, { JIVA_DOCUMENT_DIR: documentDir, JIVA_UPLOAD_TICKET_TTL_MS: '3000' });
  try {
    await emergencyIntake(api);
    await facilityDirectory(api);
    await referralsAndAcceptance(api);
    const journey = await arrivalAndHandover(api);
    await doctorAssignment(api, journey);
    await clinicalRecords(api, journey);
    await diagnosticDocuments(api, journey);
    await patientDashboard(api, journey);
    await medicalTelemetry(api, journey);
    check('API process still healthy at the end', (await api.get(undefined, '/api/health')).status === 200);
    check('no handler crashes logged', !/Handler for .* failed|Uncaught exception|Unhandled rejection/.test(api.log()), api.log().match(/.*(failed|Uncaught|Unhandled).*/g)?.slice(0, 3).join('\n'));
  } finally {
    api.stop();
    try {
      fs.rmSync(documentDir, { recursive: true, force: true });
    } catch {
      /* best effort: a temporary directory */
    }
  }
  const { passes, failures } = results();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('✓ Emergency-to-care journey PASSED.');
  process.exit(0);
}

main().catch(err => { console.error('✗ Emergency-to-care journey crashed:', err); process.exit(1); });
