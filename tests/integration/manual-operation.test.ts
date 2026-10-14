/**
 * Hardware-independent operation against a REAL API process (:4107). With no medical device and no GPS
 * receiver connected, every workflow runs on what people type in, and the system says so:
 *  A. /api/health states that no device, GPS or AI service is connected, and how positions are produced
 *  B. the crew reports with typed vital signs (including blood glucose) and moves the unit by hand: a MANUAL
 *     position at the hospital marks it arrived and is labelled MANUAL, never GPS
 *  C. the coordinator records arrival and a handover with notes; only the hospital and the assigned
 *     clinician see the notes
 *  D. the assigned doctor enters vital signs by hand, corrects one and withdraws another; the patient sees
 *     only current values; simulated readings cannot be edited; nobody else can correct
 *  E. a coordinator reports one service's status by hand; another hospital cannot
 *  F. automatic briefs say they are template text, not AI
 * Every response comes from the real API; only the mapping provider is the (labelled) mock.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { check, envelope, results, startApi, uuid, type Api } from './helpers/api';

const P = {
  admin: 'demo-admin', mgmt: 'demo-mgmt-1', h1: 'demo-hosp-1', h2: 'demo-hosp-2',
  a2: 'demo-amb-2', pat1: 'demo-patient-1', doc1: 'demo-doc-1', doc3: 'demo-doc-3',
};
const CASE = 'CASE-BLR-876';
const H1 = 'HOSP-BLR-001';
const SCENE = { latitude: 13.0431, longitude: 77.5891 };
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const statuses = (rs: Array<{ status: number }>) => rs.map(r => r.status).join(',');

async function referralId(api: Api, hospitalId: string, persona: string): Promise<string | undefined> {
  const reqs = (await api.get(persona, `/api/hospitals/${hospitalId}/requests`)).json as any[];
  return Array.isArray(reqs) ? reqs.find(r => r.caseId === CASE)?.requestId : undefined;
}
const ambulance = async (api: Api, id: string) => ((await api.get(P.mgmt, '/api/ambulances')).json as any[]).find(a => a.ambulanceId === id);
const hospital = async (api: Api, id: string) => ((await api.get(P.mgmt, '/api/hospitals')).json as any[]).find(h => h.hospitalId === id);

async function main() {
  console.log('[Test] Manual (hardware-independent) operation against a real API on :4107');
  const documentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-manual-docs-'));
  const api = await startApi(4107, { JIVA_DOCUMENT_DIR: documentDir });
  try {
    check('fixture: demo reset', (await api.post(P.admin, '/api/demo/reset')).status === 200);

    // ------------------------------------------------------------ A. what the system says about itself
    console.log('\n[A] Health: no device, no GPS, no AI service');
    const health = (await api.get(undefined, '/api/health')).json;
    const prov = health?.provenance;
    check('no medical device and no ambulance GPS is integrated', prov?.liveIntegrations?.medicalDevices === false && prov?.liveIntegrations?.ambulanceGps === false && prov?.providers?.telemetry?.medicalDevices === false);
    check('positions: set by hand, simulator in demo only, never device GPS', JSON.stringify(prov?.providers?.positions) === JSON.stringify({ manual: true, simulator: true, deviceGps: false }), JSON.stringify(prov?.providers?.positions));
    check('summaries come from the template generator', health?.components?.ai?.generator === 'TEMPLATE', JSON.stringify(health?.components?.ai));

    // ------------------------------------------------------------ B. crew: typed vitals and manual position
    console.log('\n[B] Crew intake with typed vital signs; the unit is moved by hand');
    const created = await api.post(P.a2, '/api/emergencies', {
      clientRequestId: uuid(), caseRef: CASE, location: { ...SCENE, method: 'MAP_PIN' }, severity: 'HIGH',
      reportedSymptoms: ['Confusion', 'Sweating'], suspectedCause: 'Synthetic test', requiredCapabilities: [],
      clinical: { measurements: [{ type: 'HEART_RATE', value: 104, unit: 'bpm', observedAt: minutesAgo(3) }, { type: 'BLOOD_GLUCOSE', value: 52, unit: 'mg/dL', observedAt: minutesAgo(3) }] },
    });
    check('crew intake with heart rate and blood glucose → 202', created.status === 202 && created.json?.caseId === CASE, created.text.slice(0, 200));
    const ph = (await api.get(P.a2, `/api/cases/${CASE}/prehospital`)).json;
    const crewGlucose = ph?.latest?.BLOOD_GLUCOSE;
    check('the crew-entered glucose is stored as entered by the crew (MANUAL_CREW), no device integrated', crewGlucose?.value === 52 && crewGlucose?.unit === 'mg/dL' && crewGlucose?.source === 'MANUAL_CREW' && ph?.sources?.medicalDeviceIntegrated === false, JSON.stringify(crewGlucose));
    const implausible = await api.post(P.a2, `/api/cases/${CASE}/prehospital`, { clientRequestId: uuid(), measurements: [{ type: 'BLOOD_GLUCOSE', value: 5000, unit: 'mg/dL', observedAt: minutesAgo(1) }] });
    check('an implausible glucose (5000 mg/dL) is refused (400)', implausible.status === 400, implausible.text.slice(0, 200));

    await api.waitFor(async () => !!(await referralId(api, H1, P.h1)));
    const acc = await api.event(P.h1, envelope('hospital.acceptance.received', {
      responseId: `R-${uuid().slice(0, 8)}`, requestId: (await referralId(api, H1, P.h1)) ?? 'AR-none', caseId: CASE, hospitalId: H1, status: 'ACCEPTED',
      acceptedCapabilities: ['EMERGENCY'], limitations: [], respondedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      responderRole: 'CLINICAL_COORDINATOR', source: 'SYNTHETIC_DEMO',
    }, { type: 'hospital', id: H1 }));
    const routed = await api.waitFor(async () => (await ambulance(api, 'AMB-BLR-002'))?.destinationHospital === H1);
    check('Hebbal accepts → the crew is routed there', acc.status === 202 && routed);

    const unlabelled = await api.event(P.a2, envelope('ambulance.location.updated', { ambulanceId: 'AMB-BLR-002', coordinates: { latitude: 13.03, longitude: 77.59 } }, { type: 'ambulance', id: 'AMB-BLR-002' }));
    const midway = await ambulance(api, 'AMB-BLR-002');
    check('a position sent without a source is accepted but not labelled as anything', unlabelled.status === 202 && !!midway?.locationAsOf && midway?.locationSource === undefined, JSON.stringify({ s: midway?.locationSource }));
    const h1 = await hospital(api, H1);
    const atHospital = await api.event(P.a2, envelope('ambulance.location.updated', { ambulanceId: 'AMB-BLR-002', coordinates: { latitude: h1.location.latitude, longitude: h1.location.longitude }, source: 'MANUAL' }, { type: 'ambulance', id: 'AMB-BLR-002' }));
    const arrived = await api.waitFor(async () => (await ambulance(api, 'AMB-BLR-002'))?.status === 'ARRIVED');
    const amb = await ambulance(api, 'AMB-BLR-002');
    check('the crew sets "at Hebbal" by hand → ARRIVED, labelled MANUAL', atHospital.status === 202 && arrived && amb?.locationSource === 'MANUAL', JSON.stringify({ status: amb?.status, src: amb?.locationSource }));
    const spoof = await api.event(P.h1, envelope('ambulance.location.updated', { ambulanceId: 'AMB-BLR-002', coordinates: SCENE, source: 'MANUAL' }, { type: 'ambulance', id: 'AMB-BLR-002' }));
    check('nobody but the unit itself may set its position (hospital → 403)', spoof.status === 403, String(spoof.status));
    const badSource = await api.event(P.a2, envelope('ambulance.location.updated', { ambulanceId: 'AMB-BLR-002', coordinates: SCENE, source: 'ESP32' }, { type: 'ambulance', id: 'AMB-BLR-002' }));
    check('an unknown position source is refused (400)', badSource.status === 400, String(badSource.status));

    // ------------------------------------------------------------ C. arrival and handover with notes
    console.log('\n[C] Arrival and handover recorded by the hospital, with notes');
    const arr = await api.post(P.h1, `/api/hospitals/${H1}/arrivals`, { clientRequestId: uuid(), caseId: CASE });
    const encounterId: string = arr.json?.encounter?.encounterId;
    check('the coordinator records the arrival (encounter opened)', arr.status === 201 && !!encounterId, arr.text.slice(0, 200));
    const NOTE = 'Glucose gel given en route; daughter informed and on her way.';
    const tooLong = await api.post(P.h1, `/api/encounters/${encounterId}/handover`, { clientRequestId: uuid(), notes: 'x'.repeat(1001) });
    const ho = await api.post(P.h1, `/api/encounters/${encounterId}/handover`, { clientRequestId: uuid(), notes: NOTE });
    check('handover notes over 1000 characters are refused; with notes → recorded', tooLong.status === 400 && ho.status === 200, `${tooLong.status},${ho.status} ${ho.text.slice(0, 160)}`);
    const assign = await api.post(P.h1, `/api/encounters/${encounterId}/doctor`, { clientRequestId: uuid(), practitionerId: 'PRAC-BLR-001-01' });
    check('the coordinator assigns Dr. Ravi Kumar', assign.status === 200 || assign.status === 201, assign.text.slice(0, 160));
    const views = await Promise.all([P.h1, P.doc3, P.pat1, P.mgmt].map(p => api.get(p, `/api/encounters/${encounterId}`)));
    const hasNote = views.map(v => v.text.includes('daughter informed'));
    check('notes: the hospital and the assigned doctor see them; the patient and network coordination do not', hasNote.join(',') === 'true,true,false,false', `${statuses(views)} ${hasNote}`);
    const history = JSON.stringify((await api.get(P.mgmt, '/api/events/history?limit=500')).json);
    check('the notes never travel on an event', !history.includes('daughter informed'));

    // ------------------------------------------------------------ D. doctor: manual vitals, correction, withdrawal
    console.log('\n[D] The doctor enters vital signs by hand, corrects and withdraws');
    const entry = { clientRequestId: uuid(), measurements: [{ type: 'HEART_RATE', value: 96, unit: 'bpm', observedAt: minutesAgo(1) }, { type: 'BLOOD_GLUCOSE', value: 81, unit: 'mg/dL', observedAt: minutesAgo(1) }] };
    const rec = await api.post(P.doc3, `/api/encounters/${encounterId}/vitals`, entry);
    const replay = await api.post(P.doc3, `/api/encounters/${encounterId}/vitals`, entry);
    const ms = (rec.json?.measurements ?? []) as any[];
    check('typed vital signs are recorded as MANUAL_CLINICIAN (201)', rec.status === 201 && ms.length === 2 && ms.every(m => m.source === 'MANUAL_CLINICIAN'), rec.text.slice(0, 200));
    check('a repeated submission is a replay, not a duplicate', replay.status === 201 && replay.json?.batchId === rec.json?.batchId);
    const hr = ms.find(m => m.type === 'HEART_RATE');
    const glu = ms.find(m => m.type === 'BLOOD_GLUCOSE');
    const others = await Promise.all([P.doc1, P.h1, P.pat1].map(p => api.post(p, `/api/encounters/${encounterId}/vitals/${glu?.measurementId}/correct`, { clientRequestId: uuid(), reason: 'x', replacement: { value: 90 } })));
    check('only the assigned clinician corrects (other doctor 404, hospital 403, patient 403)', statuses(others) === '404,403,403', statuses(others));
    const noReason = await api.post(P.doc3, `/api/encounters/${encounterId}/vitals/${glu?.measurementId}/correct`, { clientRequestId: uuid(), replacement: { value: 91 } });
    check('a correction needs a reason (400)', noReason.status === 400);
    const corrected = await api.post(P.doc3, `/api/encounters/${encounterId}/vitals/${glu?.measurementId}/correct`, { clientRequestId: uuid(), reason: 'Typed 81, meter showed 91', replacement: { value: 91 } });
    check('glucose corrected: the original is withdrawn, the replacement points to it', corrected.status === 200 && corrected.json?.withdrawn?.withdrawn?.replacedBy === corrected.json?.replacement?.measurementId && corrected.json?.replacement?.corrects === glu?.measurementId && corrected.json?.replacement?.value === 91, corrected.text.slice(0, 300));
    const withdrawn = await api.post(P.doc3, `/api/encounters/${encounterId}/vitals/${hr?.measurementId}/correct`, { clientRequestId: uuid(), reason: 'Entered on the wrong patient' });
    check('heart rate withdrawn as entered in error', withdrawn.status === 200 && withdrawn.json?.status === 'withdrawn');
    const again = await api.post(P.doc3, `/api/encounters/${encounterId}/vitals/${hr?.measurementId}/correct`, { clientRequestId: uuid(), reason: 'again', replacement: { value: 70 } });
    check('a withdrawn value cannot be corrected again (409 already_withdrawn)', again.status === 409 && again.json?.error === 'already_withdrawn');
    const docView = (await api.get(P.doc3, `/api/encounters/${encounterId}/vitals`)).json;
    const patView = (await api.get(P.pat1, `/api/encounters/${encounterId}/vitals`)).json;
    const docIds = (docView?.measurements ?? []).filter((m: any) => m.source === 'MANUAL_CLINICIAN').length;
    check('the care team keeps the full history (original, replacement, withdrawn)', docIds === 3, String(docIds));
    const patValues = (patView?.measurements ?? []).filter((m: any) => m.source === 'MANUAL_CLINICIAN').map((m: any) => `${m.type}:${m.value}`);
    check('the patient sees only current values (glucose 91; no withdrawn heart rate)', JSON.stringify(patValues) === JSON.stringify(['BLOOD_GLUCOSE:91']), JSON.stringify(patValues));
    const sim = await api.post(P.doc3, `/api/encounters/${encounterId}/vitals/simulate`, { clientRequestId: uuid() });
    const simM = sim.json?.measurements?.[0];
    check('a simulated reading is labelled synthetic', sim.status === 201 && simM?.source === 'DEVICE_SIMULATED' && simM?.dataStatus === 'SYNTHETIC_DEMO', sim.text.slice(0, 200));
    const simEdit = await api.post(P.doc3, `/api/encounters/${encounterId}/vitals/${simM?.measurementId}/correct`, { clientRequestId: uuid(), reason: 'try', replacement: { value: simM?.value } });
    check('simulated readings are never edited (409 not_correctable)', simEdit.status === 409 && simEdit.json?.error === 'not_correctable');
    const device = await api.post(P.doc3, `/api/encounters/${encounterId}/vitals`, { clientRequestId: uuid(), source: 'MEDICAL_DEVICE', measurements: [{ type: 'SPO2', value: 97, unit: '%', observedAt: minutesAgo(1) }] });
    check('nobody can submit a reading as if from a medical device (400)', device.status === 400, String(device.status));

    // ------------------------------------------------------------ E. per-service status by hand
    console.log('\n[E] Service status reported by hand');
    const op0 = (await hospital(api, H1))?.operationalState ?? {};
    const capacity = (hospitalId: string, icu: string) => envelope('hospital.capacity.updated', {
      hospitalId, emergencyStatus: op0.emergency ?? 'UNKNOWN', traumaStatus: op0.trauma ?? 'UNKNOWN', icuStatus: icu, ventilatorStatus: op0.ventilator ?? 'UNKNOWN',
    }, { type: 'hospital', id: hospitalId });
    const icu = await api.event(P.h1, capacity(H1, 'UNAVAILABLE'));
    const icuSet = await api.waitFor(async () => (await hospital(api, H1))?.operationalState?.icu === 'UNAVAILABLE');
    const op1 = (await hospital(api, H1))?.operationalState ?? {};
    check('Hebbal reports ICU unavailable; the other services keep their values', icu.status === 202 && icuSet && op1.emergency === (op0.emergency ?? 'UNKNOWN') && op1.trauma === (op0.trauma ?? 'UNKNOWN'), JSON.stringify(op1));
    const foreign = await api.event(P.h2, capacity(H1, 'AVAILABLE'));
    check('another hospital cannot report for Hebbal (403)', foreign.status === 403, String(foreign.status));

    // ------------------------------------------------------------ F. automatic briefs are template text
    console.log('\n[F] Automatic briefs say what produced them');
    const ai = await api.waitFor(async () => ((await api.get(P.mgmt, '/api/events/history?limit=500')).json as any[]).some(e => String(e.eventType).startsWith('ai.')), 10_000);
    const aiEvents = ((await api.get(P.mgmt, '/api/events/history?limit=500')).json as any[]).filter(e => String(e.eventType).startsWith('ai.'));
    check('every ai.* event says it came from the template generator', ai && aiEvents.length > 0 && aiEvents.every(e => e.payload?.generator === 'TEMPLATE'), aiEvents.map(e => `${e.eventType}:${e.payload?.generator}`).join(' '));

    check('API process still healthy at the end', (await api.get(undefined, '/api/health')).status === 200);
  } finally {
    api.stop();
    try {
      fs.rmSync(documentDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  const { passes, failures } = results();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('✓ Manual operation suite PASSED.');
  process.exit(0);
}

main().catch(err => { console.error('✗ Manual operation suite crashed:', err); process.exit(1); });
