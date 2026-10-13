/**
 * Phase 13 — the complete emergency-to-care journey, end to end, against a REAL API process (:4104),
 * as one deterministic narrative (demo reset, fixed scene, fixed case reference, synthetic files), then
 * the failure scenarios. The mapping stack is deliberately unreachable here (Valhalla/OSRM on a closed
 * port), so routing runs on the labelled synthetic fallback — the "live provider unavailable" scenario.
 *
 * Not covered here, by design: the 15-minute referral deadline (a frozen protocol constant) is exercised
 * with a simulated clock in tests/unit/referral-lifecycle.test.ts; this suite uses short answer validity
 * for the runtime expiry scenario instead. Passing this suite says nothing about real external
 * integrations (there are none: see /api/health → provenance.liveIntegrations).
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
  doc1: 'demo-doc-1', doc3: 'demo-doc-3',
};
const SCENE = { latitude: 13.0431, longitude: 77.5891 };
const CASE = 'CASE-BLR-876';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic chest x-ray (e2e) '.repeat(30))]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

async function referralId(api: Api, caseId: string, hospitalId: string): Promise<string | undefined> {
  const hist = (await api.get(P.mgmt, '/api/events/history?limit=1000')).json as any[];
  return hist.find(e => e.eventType === 'hospital.acceptance.requested' && e.payload.caseId === caseId && e.payload.hospitalId === hospitalId)?.payload.requestId;
}
const answer = (caseId: string, hospitalId: string, requestId: string | undefined, status: string, o: Record<string, unknown> = {}) =>
  envelope('hospital.acceptance.received', {
    responseId: `R-${uuid().slice(0, 8)}`, requestId: requestId ?? 'AR-none', caseId, hospitalId, status,
    acceptedCapabilities: status === 'REJECTED' || status === 'UNAVAILABLE' ? [] : ['EMERGENCY', 'TRAUMA', 'ICU'], limitations: status === 'REJECTED' || status === 'UNAVAILABLE' ? ['Stated reason'] : [],
    respondedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 30 * 60_000).toISOString(), responderRole: 'CLINICAL_COORDINATOR', source: 'SYNTHETIC_DEMO', ...o,
  }, { type: 'hospital', id: hospitalId });
const ambulance = async (api: Api, id: string) => ((await api.get(P.mgmt, '/api/ambulances')).json as any[]).find(a => a.ambulanceId === id);
const caseState = async (api: Api, id: string) => ((await api.get(P.mgmt, '/api/patients')).json as any[]).find(p => p.patientId === id);

async function journey(api: Api) {
  console.log('\n[Journey] 20 steps');
  const reset = await api.post(P.admin, '/api/demo/reset');
  check('fixture: demo state reset', reset.status === 200);
  const sock = { patient: await api.socket(P.pat1), crew: await api.socket(P.a2), h1: await api.socket(P.h1), h3: await api.socket(P.h3) };

  // 1–4: the crew reports the emergency from the scene
  const intake = {
    clientRequestId: uuid(), caseRef: CASE, location: { ...SCENE, method: 'MAP_PIN' }, severity: 'CRITICAL',
    reportedSymptoms: ['Bleeding from the scalp', 'Leg deformity'], suspectedCause: 'Road traffic accident', requiredCapabilities: [], notes: 'Conscious, GCS 14.',
  };
  const created = await api.post(P.a2, '/api/emergencies', intake);
  check('Step 1 — an authorized ambulance crew creates the emergency', created.status === 202 && created.json?.caseId === CASE && created.json.assignedToThisAmbulance === true, created.text);
  const p0 = await caseState(api, CASE);
  check('Step 2 — the selected starting location is the case location (map pin)', p0?.currentLocation?.latitude === SCENE.latitude && p0.currentLocation.longitude === SCENE.longitude && p0.intake?.locationMethod === 'MAP_PIN');
  check('Step 3 — symptoms and the suspected cause are stored separately', JSON.stringify(p0?.reportedSymptoms) === JSON.stringify(intake.reportedSymptoms) && p0.suspectedCause === 'Road traffic accident' && !('diagnosis' in p0));
  await api.waitFor(async () => ((await api.get(P.mgmt, '/api/events/history?limit=500')).json as any[]).some(e => e.eventType === 'care.requirement.created' && e.payload.caseId === CASE));
  const req = ((await api.get(P.mgmt, '/api/events/history?limit=500')).json as any[]).find(e => e.eventType === 'care.requirement.created' && e.payload.caseId === CASE);
  check('Step 4 — care requirements are recorded (rule-based: emergency, trauma, ICU)', JSON.stringify(req?.payload.requiredCapabilities) === JSON.stringify(['EMERGENCY', 'TRAUMA', 'ICU']) && JSON.stringify(p0.careRequirements) === JSON.stringify(['EMERGENCY', 'TRAUMA', 'ICU']));

  // 5–8: referrals and explicit answers
  await api.waitFor(async () => !!(await referralId(api, CASE, 'HOSP-BLR-001')) && !!(await referralId(api, CASE, 'HOSP-BLR-004')) && !!(await referralId(api, CASE, 'HOSP-BLR-002')));
  const asked = ((await api.get(P.mgmt, '/api/events/history?limit=500')).json as any[]).filter(e => e.eventType === 'hospital.acceptance.requested' && e.payload.caseId === CASE).map(e => e.payload.hospitalId).sort();
  check('Step 5 — referrals generated by the existing coordination (capable network hospitals only)', JSON.stringify(asked) === JSON.stringify(['HOSP-BLR-001', 'HOSP-BLR-002', 'HOSP-BLR-004']), JSON.stringify(asked));
  await pause(200);
  check('Step 6 — the appropriate hospital receives the referral (and an incapable one does not)',
    ((await api.get(P.h1, '/api/hospitals/HOSP-BLR-001/requests')).json as any[]).some(r => r.caseId === CASE) && sock.h1.events.some(e => e.eventType === 'hospital.acceptance.requested' && e.payload.caseId === CASE) && !sock.h3.events.some(e => e.eventType === 'hospital.acceptance.requested'));
  const a4 = await api.event(P.h4, answer(CASE, 'HOSP-BLR-004', await referralId(api, CASE, 'HOSP-BLR-004'), 'ACCEPTED'));
  await api.waitFor(async () => (await ambulance(api, 'AMB-BLR-002'))?.destinationHospital === 'HOSP-BLR-004');
  const a2 = await api.event(P.h2, answer(CASE, 'HOSP-BLR-002', await referralId(api, CASE, 'HOSP-BLR-002'), 'REJECTED'));
  const a1 = await api.event(P.h1, answer(CASE, 'HOSP-BLR-001', await referralId(api, CASE, 'HOSP-BLR-001'), 'ACCEPTED'));
  check('Step 7 — hospitals explicitly accept (Indiranagar, Hebbal) or reject (Whitefield)', a4.status === 202 && a2.status === 202 && a1.status === 202);
  const ov = (await api.get(P.a2, `/api/cases/${CASE}/referrals`)).json;
  const row = (id: string) => ov?.rows?.find((r: any) => r.hospitalId === id);
  await pause(200);
  check('Step 8 — the authoritative answers reach the crew (referral overview) and the patient (destination)',
    row('HOSP-BLR-004')?.answer?.status === 'ACCEPTED' && row('HOSP-BLR-002')?.answer?.status === 'REJECTED' && row('HOSP-BLR-001')?.answer?.status === 'ACCEPTED' &&
    sock.patient.events.some(e => e.eventType === 'route.recalculated' && e.payload.newHospitalId === 'HOSP-BLR-004'));

  // 9: Indiranagar becomes unable to take patients → rerouted to the other accepting hospital
  await api.event(P.h4, answer(CASE, 'HOSP-BLR-004', await referralId(api, CASE, 'HOSP-BLR-004'), 'UNAVAILABLE'));
  const rerouted = await api.waitFor(async () => (await ambulance(api, 'AMB-BLR-002'))?.destinationHospital === 'HOSP-BLR-001');
  const rr = ((await api.get(P.mgmt, '/api/events/history?limit=1000')).json as any[]).find(e => e.eventType === 'route.recalculated' && e.payload.ambulanceId === 'AMB-BLR-002' && e.payload.oldHospitalId === 'HOSP-BLR-004');
  check('Step 9 — routing responds to authoritative state: unavailable destination → rerouted to the hospital that accepted', rerouted && rr?.payload.newHospitalId === 'HOSP-BLR-001');
  const route = (await ambulance(api, 'AMB-BLR-002'))?.activeRoute;
  check('…and the route is labelled synthetic (live mapping provider unavailable → labelled fallback)', route?.synthetic === true && route.provider === 'mock');

  // 10: the ambulance reaches the destination (GPS)
  const h1 = ((await api.get(P.mgmt, '/api/hospitals')).json as any[]).find(h => h.hospitalId === 'HOSP-BLR-001');
  await api.event(P.a2, envelope('ambulance.location.updated', { ambulanceId: 'AMB-BLR-002', coordinates: { latitude: h1.location.latitude, longitude: h1.location.longitude }, speedKmh: 4 }, { type: 'ambulance', id: 'AMB-BLR-002' }));
  const reached = await api.waitFor(async () => (await ambulance(api, 'AMB-BLR-002'))?.status === 'ARRIVED');
  check('Step 10 — the ambulance reaches the destination (GPS geofence) — not yet in hospital care', reached && (await caseState(api, CASE))?.currentStatus === 'ARRIVED' && ((await api.get(P.pat1, '/api/encounters')).json as any[]).length === 0);

  // 11–13: arrival, handover, encounter, doctor
  const arr = await api.post(P.h1, '/api/hospitals/HOSP-BLR-001/arrivals', { clientRequestId: uuid(), caseId: CASE });
  const encounterId: string = arr.json?.encounter?.encounterId;
  const ho = await api.post(P.h1, `/api/encounters/${encounterId}/handover`, { clientRequestId: uuid() });
  check('Step 11 — hospital staff record the arrival and the handover', arr.status === 201 && ho.status === 200, `${arr.status} ${ho.status}`);
  check('Step 12 — the encounter is active (IN_CARE) and the crew is released', ho.json?.encounter?.status === 'IN_CARE' && (await ambulance(api, 'AMB-BLR-002'))?.status === 'AVAILABLE');
  const as = await api.post(P.h1, `/api/encounters/${encounterId}/doctor`, { clientRequestId: uuid(), practitionerId: 'PRAC-BLR-001-01' });
  check('Step 13 — a doctor is assigned', as.status === 200 && as.json.encounter.assignedDoctor.displayName === 'Dr. Ravi Kumar');

  // 14–15: clinical records
  const rx = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, { clientRequestId: uuid(), medication: 'Ceftriaxone', strength: '1 g', dose: '1 g', route: 'IV', frequency: 'Once daily', duration: '3 days' });
  check('Step 14 — the authorized doctor writes a prescription', rx.status === 201 && rx.json.prescription.current.status === 'ACTIVE', rx.text);
  const decl = await api.post(P.doc3, `/api/encounters/${encounterId}/documents`, { clientRequestId: uuid(), category: 'IMAGING', title: 'Chest X-ray (PA)', fileName: 'chest-xray.png', contentType: 'image/png', sizeBytes: PNG.length, sha256: sha(PNG), patientVisible: false });
  const up = await api.req('PUT', decl.json?.upload?.url ?? '/api/uploads/none', P.doc3, undefined, { raw: PNG, headers: { 'content-type': 'image/png' } });
  const docId: string = up.json?.document?.documentId;
  const rep = await api.post(P.doc3, `/api/encounters/${encounterId}/reports`, { clientRequestId: uuid(), category: 'IMAGING', title: 'Chest X-ray', findings: 'No acute abnormality (synthetic).', effectiveAt: new Date(Date.now() - 60_000).toISOString(), documentIds: [docId], patientVisible: true, status: 'FINAL' });
  check('Step 15 — the doctor adds a diagnostic report with a verified scan, shared with the patient', up.status === 200 && up.json.document.status === 'AVAILABLE' && rep.status === 201 && rep.json.report.current.documentIds[0] === docId, `${up.status} ${rep.status} ${rep.text}`);

  // 16–17: the patient's view
  const mine = ((await api.get(P.pat1, '/api/encounters')).json as any[])[0];
  check('Step 16 — the patient dashboard switches to in-hospital care from the encounter (IN_CARE, doctor named)', mine?.status === 'IN_CARE' && mine.assignedDoctor?.displayName === 'Dr. Ravi Kumar' && (await api.get(P.pat1, '/api/patients')).json?.[0]?.currentStatus === 'HANDED_OVER');
  const prx = (await api.get(P.pat1, `/api/encounters/${encounterId}/prescriptions`)).json as any[];
  const prep = (await api.get(P.pat1, `/api/encounters/${encounterId}/reports`)).json as any[];
  const pdl = await api.get(P.pat1, `/api/encounters/${encounterId}/documents/${docId}/content`);
  check('Step 17 — the patient reads their prescription, the shared report and downloads the scan', prx[0]?.medication === 'Ceftriaxone' && prep[0]?.title === 'Chest X-ray' && pdl.status === 200 && pdl.body.equals(PNG));

  // 18: another patient
  const other = await Promise.all([
    api.get(P.pat2, `/api/encounters/${encounterId}`), api.get(P.pat2, `/api/encounters/${encounterId}/prescriptions`),
    api.get(P.pat2, `/api/encounters/${encounterId}/reports`), api.get(P.pat2, `/api/encounters/${encounterId}/documents/${docId}/content`),
  ]);
  check("Step 18 — another patient cannot access this patient's encounter, records or scan (404)", other.every(r => r.status === 404), other.map(r => r.status).join(','));

  // 19: telemetry with provenance
  await api.post(P.doc3, `/api/encounters/${encounterId}/vitals`, { clientRequestId: uuid(), measurements: [{ type: 'HEART_RATE', value: 104, unit: 'bpm', observedAt: new Date(Date.now() - 60_000).toISOString() }, { type: 'SPO2', value: 95, unit: '%', observedAt: new Date(Date.now() - 60_000).toISOString() }] });
  await api.post(P.doc3, `/api/encounters/${encounterId}/vitals/simulate`, { clientRequestId: uuid() });
  const vit = (await api.get(P.pat1, `/api/encounters/${encounterId}/vitals`)).json;
  check('Step 19 — telemetry is shown with its provenance (clinician-entered vs simulated) and freshness',
    vit?.measurements?.some((m: any) => m.type === 'HEART_RATE' && m.value === 104 && m.source === 'MANUAL_CLINICIAN') && vit.measurements.some((m: any) => m.source === 'DEVICE_SIMULATED' && m.dataStatus === 'SYNTHETIC_DEMO') && vit.sources.medicalDeviceIntegrated === false && !!vit.latest.HEART_RATE?.freshness);

  // 20: refresh / reconnect
  for (const s of Object.values(sock)) s.s.close();
  const again = await api.socket(P.pat1);
  const state = {
    encounter: ((await api.get(P.pat1, '/api/encounters')).json as any[])[0],
    prescriptions: (await api.get(P.pat1, `/api/encounters/${encounterId}/prescriptions`)).json as any[],
    timeline: (await api.get(P.pat1, `/api/cases/${CASE}/timeline`)).json as any[],
  };
  const order = ['patient.emergency.created', 'ambulance.dispatched', 'encounter.arrival.recorded', 'encounter.handover.recorded', 'encounter.doctor.assigned', 'clinical.prescription.recorded']
    .map(t => state.timeline.findIndex(e => e.eventType === t));
  const chronological = [...state.timeline].reverse().every((e, i, arr) => i === 0 || Date.parse(arr[i - 1].timestamp) <= Date.parse(e.timestamp)) || state.timeline.every((e, i, arr) => i === 0 || Date.parse(arr[i - 1].timestamp) <= Date.parse(e.timestamp));
  check('Step 20 — after reconnecting, a refresh restores the authoritative state and the full case history', state.encounter?.status === 'IN_CARE' && state.prescriptions.length === 1 && order.every(i => i >= 0) && chronological, JSON.stringify(order));
  await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, { clientRequestId: uuid(), medication: 'Paracetamol', strength: '500 mg', dose: '1 tablet', route: 'ORAL', frequency: 'Every 6 hours as needed' });
  check('…and realtime resumes on the new connection', await api.waitFor(async () => again.events.some(e => e.eventType === 'clinical.prescription.recorded'), 3000));
  again.s.close();
  return { encounterId, docId };
}

async function failures(api: Api, ctx: { encounterId: string; docId: string }) {
  console.log('\n[Failure scenarios]');
  const { encounterId, docId } = ctx;

  // A hospital does not respond: nothing is assumed
  const quiet = (await api.post(P.a1, '/api/emergencies', { clientRequestId: uuid(), location: { ...SCENE, method: 'MAP_PIN' }, severity: 'HIGH', reportedSymptoms: ['Chest pain'], requiredCapabilities: [] })).json?.caseId as string;
  await api.waitFor(async () => !!(await referralId(api, quiet, 'HOSP-BLR-001')));
  await pause(500);
  const qov = (await api.get(P.a1, `/api/cases/${quiet}/referrals`)).json;
  check('hospitals do not respond: no destination is assumed, referrals stay outstanding with a deadline', !(await ambulance(api, 'AMB-BLR-001'))?.destinationHospital && qov.rows.filter((r: any) => r.referral.state === 'OUTSTANDING').every((r: any) => !r.answer && Date.parse(r.referral.expiresAt) > Date.now()));

  // A referral answer expires: case-scoped, treated as unknown again
  await api.event(P.h1, answer(quiet, 'HOSP-BLR-001', await referralId(api, quiet, 'HOSP-BLR-001'), 'ACCEPTED', { validUntil: new Date(Date.now() + 1500).toISOString() }));
  const lapsed = await api.waitFor(async () => ((await api.get(P.mgmt, '/api/events/history?limit=1000')).json as any[]).some(e => e.eventType === 'hospital.acceptance.expired' && e.payload.caseId === quiet && e.payload.kind === 'RESPONSE_VALIDITY'), 8000);
  check('a referral answer expires: announced for that case and no longer current', lapsed && ((await api.get(P.mgmt, `/api/cases/${quiet}/referrals`)).json.rows as any[]).find(r => r.hospitalId === 'HOSP-BLR-001')?.answer?.current === false);

  // A hospital rejects after accepting: the crew is not left heading there
  const rej = (await api.post(P.a3, '/api/emergencies', { clientRequestId: uuid(), location: { ...SCENE, method: 'MAP_PIN' }, severity: 'CRITICAL', reportedSymptoms: ['Fall from height'], suspectedCause: 'Fall injury', requiredCapabilities: [] })).json?.caseId as string;
  await api.waitFor(async () => !!(await referralId(api, rej, 'HOSP-BLR-001')));
  await api.event(P.h1, answer(rej, 'HOSP-BLR-001', await referralId(api, rej, 'HOSP-BLR-001'), 'ACCEPTED'));
  await api.waitFor(async () => (await ambulance(api, 'AMB-BLR-003'))?.destinationHospital === 'HOSP-BLR-001');
  await api.event(P.h1, answer(rej, 'HOSP-BLR-001', await referralId(api, rej, 'HOSP-BLR-001'), 'REJECTED'));
  const held = await api.waitFor(async () => (await ambulance(api, 'AMB-BLR-003'))?.destinationHospital !== 'HOSP-BLR-001');
  const lost = ((await api.get(P.mgmt, '/api/events/history?limit=1000')).json as any[]).some(e => e.eventType === 'destination.changed' && e.payload.ambulanceId === 'AMB-BLR-003' && e.payload.hospitalId === 'UNASSIGNED');
  check('a hospital rejects the case after accepting: the crew is withdrawn from it and holds for another acceptance', held && lost);

  // Duplicate events
  const dupAnswer = answer(rej, 'HOSP-BLR-002', await referralId(api, rej, 'HOSP-BLR-002'), 'REJECTED');
  const first = await api.event(P.h2, dupAnswer);
  const second = await api.event(P.h2, dupAnswer);
  check('duplicate events: the same event delivered twice is ignored the second time', first.status === 202 && second.json?.status === 'duplicate_ignored');
  const body = { clientRequestId: uuid(), caseId: 'CASE-NOPE' };
  const r1 = await api.post(P.h1, '/api/hospitals/HOSP-BLR-001/arrivals', body);
  const r2 = await api.post(P.h1, '/api/hospitals/HOSP-BLR-001/arrivals', body);
  check('duplicate commands: a retried command returns the same answer and changes nothing', r1.status === r2.status && r1.text === r2.text);

  // Unauthorized handover / foreign doctor / cross-patient access
  const hand = await Promise.all([P.a2, P.pat1, P.h2, P.doc1, P.mgmt].map(p => api.post(p, `/api/encounters/${encounterId}/handover`, { clientRequestId: uuid() })));
  check('an unauthorized user attempts a handover: crew, patient, other hospital, other clinician, management all refused', hand.every(r => r.status === 403 || r.status === 404), hand.map(r => r.status).join(','));
  check('a user attempts to assign a doctor at another hospital: refused (other coordinator 404, foreign doctor 422)',
    (await api.post(P.h2, `/api/encounters/${encounterId}/doctor`, { clientRequestId: uuid(), practitionerId: 'PRAC-BLR-002-01', reason: 'REASSIGNMENT' })).status === 404 &&
    (await api.post(P.h1, `/api/encounters/${encounterId}/doctor`, { clientRequestId: uuid(), practitionerId: 'PRAC-BLR-004-01', reason: 'REASSIGNMENT' })).status === 422);
  check("a patient attempts to retrieve another patient's records: 404", (await api.get(P.pat2, `/api/encounters/${encounterId}/prescriptions`)).status === 404 && (await api.get(P.pat2, `/api/encounters/${encounterId}/vitals`)).status === 404);
  check("a user attempts to access another patient's diagnostic document: 404 (also by swapping identifiers)",
    (await api.get(P.pat2, `/api/encounters/${encounterId}/documents/${docId}/content`)).status === 404 && (await api.get(P.a1, `/api/encounters/${encounterId}/documents/${docId}/content`)).status === 404);

  // A realtime connection drops and reconnects (covered in step 20) — and a dropped socket gets nothing
  const dropped = await api.socket(P.mgmt);
  dropped.s.close();
  await api.post(P.a1, '/api/emergencies', { clientRequestId: uuid(), location: { ...SCENE, method: 'MAP_PIN' }, severity: 'LOW', reportedSymptoms: ['Sprained ankle'], requiredCapabilities: [] }).catch(() => undefined);
  await pause(300);
  check('a dropped realtime connection receives nothing further (state is recovered by refresh, step 20)', dropped.events.length === 0);

  // A live data provider is unavailable
  const health = (await api.get(undefined, '/api/health')).json;
  check('a live data provider is unavailable: mapping falls back to the labelled synthetic provider and says so', health?.components?.mapping?.fallbackActive === true && health.provenance.providers.mapping.synthetic === true, JSON.stringify(health?.components?.mapping));

  // Required fields missing or invalid
  const miss = await api.post(P.a2, '/api/emergencies', { clientRequestId: uuid(), location: { ...SCENE, method: 'MAP_PIN' }, severity: 'HIGH', requiredCapabilities: [] });
  check('a required field is missing: 400 naming the field (intake without symptoms)', miss.status === 400 && miss.json?.issues?.some((i: any) => i.path === 'reportedSymptoms'));
  const inval = await api.post(P.doc3, `/api/encounters/${encounterId}/vitals`, { clientRequestId: uuid(), measurements: [{ type: 'SPO2', value: 140, unit: '%', observedAt: new Date().toISOString() }] });
  check('a field is invalid: 400 (SpO2 140 %)', inval.status === 400);
  check('…and nothing was stored by the invalid requests', !((await api.get(P.doc3, `/api/encounters/${encounterId}/vitals`)).json.measurements as any[]).some(m => m.value === 140));
}

async function main() {
  console.log('[Test] End-to-end emergency-to-care journey against a real API on :4104 (mapping stack unreachable)');
  const documentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-e2e-docs-'));
  const api = await startApi(4104, {
    JIVA_DOCUMENT_DIR: documentDir,
    MAPPING_PROVIDER: 'auto',
    VALHALLA_BASE_URL: 'http://127.0.0.1:9',
    OSRM_BASE_URL: 'http://127.0.0.1:9',
    JIVA_ENVIRONMENT: 'demo',
  });
  try {
    const ctx = await journey(api);
    await failures(api, ctx);
    check('API process still healthy at the end', (await api.get(undefined, '/api/health')).status === 200);
    check('no handler crashes logged', !/Handler for .* failed|Uncaught exception|Unhandled rejection/.test(api.log()), api.log().match(/.*(failed|Uncaught|Unhandled).*/g)?.slice(0, 3).join('\n'));
  } finally {
    api.stop();
    try {
      fs.rmSync(documentDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  const { passes, failures: failed } = results();
  console.log(`\n${passes} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log('✓ End-to-end journey PASSED.');
  process.exit(0);
}

main().catch(err => { console.error('✗ End-to-end journey crashed:', err); process.exit(1); });
