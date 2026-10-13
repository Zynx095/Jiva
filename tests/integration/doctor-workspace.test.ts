/**
 * Doctor clinical workspace, ambulance intake and clinical catalogue against a REAL API process (:4105):
 *  A. crew intake with vital signs (time, quality, unavailable + reason) and symptom narrative; en-route
 *     additions; the demo-only simulated ambulance monitor; who may read and write
 *  B. referral → acceptance → arrival → handover → doctor: the pre-hospital record reaches the assigned
 *     clinician (and only them), the released crew loses it
 *  C. medication catalogue, prescription drafts and explicit authorisation, what the patient sees
 *  D. synthetic catalogue samples, document types and versions
 *  E. internal clinical notes
 *  F. reassignment removes access to every new record type at once
 *  G. realtime fault injection (demo only) and recovery
 *  H. demo reset: clinical records cleared, bundled catalogue restored; catalogue administration rights
 * Every response comes from the real API; nothing is mocked except the mapping provider (labelled mock).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { check, envelope, results, ROOT, sleep, startApi, uuid, type Api } from './helpers/api';

const P = {
  admin: 'demo-admin', mgmt: 'demo-mgmt-1',
  h1: 'demo-hosp-1', h2: 'demo-hosp-2', h4: 'demo-hosp-4',
  a1: 'demo-amb-1', a2: 'demo-amb-2',
  pat1: 'demo-patient-1', pat2: 'demo-patient-2',
  doc1: 'demo-doc-1', doc3: 'demo-doc-3', doc4: 'demo-doc-4',
};
const CASE = 'CASE-BLR-876';
const SCENE = { latitude: 13.0431, longitude: 77.5891 };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic follow-up x-ray (doctor workspace suite) '.repeat(20))]);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const statuses = (rs: Array<{ status: number }>) => rs.map(r => r.status).join(',');

async function referralId(api: Api, hospitalId: string, persona: string): Promise<string | undefined> {
  const reqs = (await api.get(persona, `/api/hospitals/${hospitalId}/requests`)).json as any[];
  return Array.isArray(reqs) ? reqs.find(r => r.caseId === CASE)?.requestId : undefined;
}
const answer = (hospitalId: string, requestId: string | undefined, status: string) =>
  envelope('hospital.acceptance.received', {
    responseId: `R-${uuid().slice(0, 8)}`, requestId: requestId ?? 'AR-none', caseId: CASE, hospitalId, status,
    acceptedCapabilities: status === 'ACCEPTED' ? ['EMERGENCY', 'TRAUMA', 'ICU'] : [], limitations: [],
    respondedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 30 * 60_000).toISOString(), responderRole: 'CLINICAL_COORDINATOR', source: 'SYNTHETIC_DEMO',
  }, { type: 'hospital', id: hospitalId });
const ambulance = async (api: Api, id: string) => ((await api.get(P.mgmt, '/api/ambulances')).json as any[]).find(a => a.ambulanceId === id);

const intakeClinical = () => ({
  measurements: [
    { type: 'HEART_RATE', value: 118, unit: 'bpm', observedAt: minutesAgo(4) },
    { type: 'SPO2', value: 91, unit: '%', observedAt: minutesAgo(4), quality: 'QUESTIONABLE' },
  ],
  unavailable: [{ type: 'BLOOD_PRESSURE', reason: 'EQUIPMENT_UNAVAILABLE' }],
  symptomDescription: 'Scalp laceration bleeding freely; deformity of the left lower leg; patient says the pain is 8 out of 10.',
  symptomOnsetAt: minutesAgo(35),
});

async function main() {
  console.log('[Test] Doctor workspace, ambulance intake and catalogue against a real API on :4105');
  const documentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-doctor-docs-'));
  const api = await startApi(4105, { JIVA_DOCUMENT_DIR: documentDir });
  try {
    check('fixture: demo reset', (await api.post(P.admin, '/api/demo/reset')).status === 200);
    const sock = { crew: await api.socket(P.a2), patient: await api.socket(P.pat1), mgmt: await api.socket(P.mgmt), h1: await api.socket(P.h1), doc3: await api.socket(P.doc3) };

    // ------------------------------------------------------------ A. ambulance intake with vital signs
    console.log('\n[A] Ambulance intake: vital signs, quality, unavailable readings, narrative');
    const created = await api.post(P.a2, '/api/emergencies', {
      clientRequestId: uuid(), caseRef: CASE, location: { ...SCENE, method: 'MAP_PIN' }, severity: 'CRITICAL',
      reportedSymptoms: ['Bleeding from the scalp', 'Leg deformity'], suspectedCause: 'Road traffic accident', requiredCapabilities: [],
      clinical: intakeClinical(),
    });
    check('crew intake with a clinical record → 202 and a pre-hospital entry id', created.status === 202 && created.json?.caseId === CASE && /^PH-/.test(created.json?.prehospitalEntryId ?? ''), created.text);
    const ph = (await api.get(P.a2, `/api/cases/${CASE}/prehospital`)).json;
    const e0 = ph?.entries?.[0];
    check('the crew reads its record: values, times, quality flag and the unavailable reason are kept',
      e0?.source === 'MANUAL_CREW' && e0.dataStatus === 'SYNTHETIC_DEMO' &&
      e0.observations.some((o: any) => o.type === 'HEART_RATE' && o.value === 118 && o.status === 'MEASURED') &&
      e0.observations.some((o: any) => o.type === 'SPO2' && o.quality === 'QUESTIONABLE') &&
      e0.observations.some((o: any) => o.type === 'BLOOD_PRESSURE' && o.status === 'NOT_AVAILABLE' && o.unavailableReason === 'EQUIPMENT_UNAVAILABLE'), JSON.stringify(e0)?.slice(0, 400));
    check('…the narrative and onset are stored with it; the crew member is named by unit only',
      e0?.symptomDescription?.startsWith('Scalp laceration') && !!e0.symptomOnsetAt && e0.recordedBy?.ambulanceId === 'AMB-BLR-002' && !('userId' in (e0.recordedBy ?? {})));
    check('latest values per type, with freshness; no device integration claimed',
      ph?.latest?.HEART_RATE?.value === 118 && ph.latest.HEART_RATE.freshness === 'FRESH' && !ph.latest.BLOOD_PRESSURE && ph.sources?.medicalDeviceIntegrated === false && ph.sources.simulationAvailable === true);
    const ledger = JSON.stringify((await api.get(P.mgmt, '/api/events/history?limit=500')).json);
    check('the operational ledger carries no vital sign and no narrative (the emergency event stays operational)', !ledger.includes('Scalp laceration') && !ledger.includes('"clinical"') && !ledger.includes('clinical.prehospital.recorded'));
    const reads = await Promise.all([P.mgmt, P.admin, P.a1, P.h1, P.pat2, P.doc3].map(p => api.get(p, `/api/cases/${CASE}/prehospital`)));
    check('management/admin 403; another crew, an unrelated coordinator, another patient, an unassigned doctor 404', statuses(reads) === '403,403,404,404,404,404', statuses(reads));
    check('the patient reads their own pre-hospital record', (await api.get(P.pat1, `/api/cases/${CASE}/prehospital`)).status === 200);
    check('the anonymous caller is refused', (await api.get(undefined, `/api/cases/${CASE}/prehospital`)).status === 401);
    await sleep(200);
    check('realtime: the crew and the patient receive the content-free event; management and the coordinator do not',
      sock.crew.events.some(e => e.eventType === 'clinical.prehospital.recorded' && e.payload.measurementCount === 2 && e.payload.unavailableCount === 1 && e.payload.narrative === true && !JSON.stringify(e).includes('118')) &&
      sock.patient.events.some(e => e.eventType === 'clinical.prehospital.recorded') &&
      !sock.mgmt.events.some(e => e.eventType === 'clinical.prehospital.recorded') && !sock.h1.events.some(e => e.eventType === 'clinical.prehospital.recorded'));

    const enRouteKey = uuid();
    const enRouteBody = { clientRequestId: enRouteKey, measurements: [{ type: 'HEART_RATE', value: 110, unit: 'bpm', observedAt: minutesAgo(1) }], unavailable: [] };
    const enRoute = await api.post(P.a2, `/api/cases/${CASE}/prehospital`, enRouteBody);
    const replay = await api.post(P.a2, `/api/cases/${CASE}/prehospital`, enRouteBody);
    const reuse = await api.post(P.a2, `/api/cases/${CASE}/prehospital`, { ...enRouteBody, measurements: [{ type: 'HEART_RATE', value: 99, unit: 'bpm', observedAt: minutesAgo(1) }] });
    check('en route: the crew adds a reading (201); a retry returns the same entry; a reused key with other content 422',
      enRoute.status === 201 && replay.json?.entry?.entryId === enRoute.json?.entry?.entryId && reuse.status === 422, `${enRoute.status} ${replay.status} ${reuse.status}`);
    const sim = await api.post(P.a2, `/api/cases/${CASE}/prehospital/simulate`, { clientRequestId: uuid() });
    check('demo-only simulated ambulance monitor: labelled DEVICE_SIMULATED and SYNTHETIC_DEMO, five values',
      sim.status === 201 && sim.json.entry.source === 'DEVICE_SIMULATED' && sim.json.entry.dataStatus === 'SYNTHETIC_DEMO' && sim.json.entry.deviceId === 'SIM-AMBULANCE-MONITOR' && sim.json.entry.observations.length === 5, sim.text.slice(0, 200));
    const invalid = await Promise.all([
      api.post(P.a2, `/api/cases/${CASE}/prehospital`, { clientRequestId: uuid(), measurements: [{ type: 'HEART_RATE', value: 80, unit: 'bpm', observedAt: minutesAgo(1) }], unavailable: [{ type: 'HEART_RATE', reason: 'NOT_MEASURED' }] }),
      api.post(P.a2, `/api/cases/${CASE}/prehospital`, { clientRequestId: uuid(), measurements: [{ type: 'HEART_RATE', value: 80, unit: 'bpm', observedAt: new Date(Date.now() + 10 * 60_000).toISOString() }] }),
      api.post(P.a2, `/api/cases/${CASE}/prehospital`, { clientRequestId: uuid(), measurements: [{ type: 'SPO2', value: 97, unit: '%', observedAt: minutesAgo(1) }], source: 'MEDICAL_DEVICE' }),
      api.post(P.a2, `/api/cases/${CASE}/prehospital`, { clientRequestId: uuid() }),
      api.post(P.a2, `/api/cases/${CASE}/prehospital`, { clientRequestId: uuid(), measurements: [{ type: 'SPO2', value: 40, unit: '%', observedAt: minutesAgo(1) }] }),
    ]);
    check('validation: measured and unavailable at once, future time, a claimed device source, an empty record, an implausible value → 400', statuses(invalid) === '400,400,400,400,400', statuses(invalid));
    const writes = await Promise.all([P.a1, P.pat1, P.mgmt].map(p => api.post(p, `/api/cases/${CASE}/prehospital`, { clientRequestId: uuid(), symptomOnsetAt: minutesAgo(30) })));
    check('only the attending crew writes: another crew 404, the patient 403, management 403', statuses(writes) === '404,403,403', statuses(writes));

    // ------------------------------------------------------------ B. referral → arrival → handover → doctor
    console.log('\n[B] Referral, arrival, handover, doctor: the record follows the patient');
    await api.waitFor(async () => !!(await referralId(api, 'HOSP-BLR-001', P.h1)));
    const acc = await api.event(P.h1, answer('HOSP-BLR-001', await referralId(api, 'HOSP-BLR-001', P.h1), 'ACCEPTED'));
    const routed = await api.waitFor(async () => (await ambulance(api, 'AMB-BLR-002'))?.destinationHospital === 'HOSP-BLR-001');
    check('Hebbal accepts → the crew is routed there (existing routing, unchanged)', acc.status === 202 && routed);
    const h1 = ((await api.get(P.mgmt, '/api/hospitals')).json as any[]).find(h => h.hospitalId === 'HOSP-BLR-001');
    await api.event(P.a2, envelope('ambulance.location.updated', { ambulanceId: 'AMB-BLR-002', coordinates: { latitude: h1.location.latitude, longitude: h1.location.longitude }, speedKmh: 4 }, { type: 'ambulance', id: 'AMB-BLR-002' }));
    await api.waitFor(async () => (await ambulance(api, 'AMB-BLR-002'))?.status === 'ARRIVED');
    const arr = await api.post(P.h1, '/api/hospitals/HOSP-BLR-001/arrivals', { clientRequestId: uuid(), caseId: CASE });
    const encounterId: string = arr.json?.encounter?.encounterId;
    check('the coordinator records the arrival (encounter opened)', arr.status === 201 && !!encounterId, arr.text.slice(0, 200));
    check('before the handover the crew still adds to the record', (await api.post(P.a2, `/api/cases/${CASE}/prehospital`, { clientRequestId: uuid(), symptomDescription: 'Handover note: GCS 14 throughout transport.' })).status === 201);
    check('no doctor yet: Dr. Ravi Kumar cannot read the record (404)', (await api.get(P.doc3, `/api/encounters/${encounterId}/prehospital`)).status === 404);
    const ho = await api.post(P.h1, `/api/encounters/${encounterId}/handover`, { clientRequestId: uuid() });
    const crewAfter = await Promise.all([api.get(P.a2, `/api/cases/${CASE}/prehospital`), api.post(P.a2, `/api/cases/${CASE}/prehospital`, { clientRequestId: uuid(), symptomOnsetAt: minutesAgo(30) })]);
    check('handover recorded → the crew is released and loses read and write access (404, 404)', ho.status === 200 && statuses(crewAfter) === '404,404', `${ho.status} ${statuses(crewAfter)}`);
    const as = await api.post(P.h1, `/api/encounters/${encounterId}/doctor`, { clientRequestId: uuid(), practitionerId: 'PRAC-BLR-001-01' });
    check('the coordinator assigns Dr. Ravi Kumar', as.status === 200);
    const docPh = (await api.get(P.doc3, `/api/encounters/${encounterId}/prehospital`)).json;
    check('the assigned doctor reads the full pre-hospital record through the encounter (4 entries, newest first)',
      docPh?.entries?.length === 4 && docPh.entries[0].symptomDescription?.startsWith('Handover note') && docPh.latest?.HEART_RATE?.value !== undefined && docPh.sources.simulationAvailable === false, JSON.stringify(docPh)?.slice(0, 300));
    check('…and through the case', (await api.get(P.doc3, `/api/cases/${CASE}/prehospital`)).status === 200);
    const others = await Promise.all([api.get(P.h1, `/api/encounters/${encounterId}/prehospital`), api.get(P.doc1, `/api/encounters/${encounterId}/prehospital`), api.get(P.mgmt, `/api/encounters/${encounterId}/prehospital`)]);
    check('the coordinator 403, a doctor of another hospital 404, management 403', statuses(others) === '403,404,403', statuses(others));
    const encs = (await api.get(P.doc3, '/api/encounters')).json as any[];
    check('the doctor’s encounter list holds exactly this encounter, with handover and assignment history', encs.length === 1 && encs[0].encounterId === encounterId && !!encs[0].handover?.handedOverAt && encs[0].assignmentHistory?.length === 1);

    // ------------------------------------------------------------ C. catalogue, drafts, authorisation
    console.log('\n[C] Medication catalogue, drafts and explicit authorisation');
    const meds = (await api.get(P.doc3, '/api/catalogue/medications?q=ceftriaxone')).json;
    const cef = meds?.entries?.[0];
    check('the doctor searches the medication catalogue', cef?.medicationId === 'MED-CEFTRIAXONE-1G-INJ' && cef.revision === 1 && /not a formulary/i.test(meds.notice));
    const rxBase = { medication: cef.name, strength: cef.strength, formulation: cef.formulation, route: 'IV', dose: '1 g', frequency: 'Once daily', duration: '3 days', medicationId: cef.medicationId };
    const draft = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, { clientRequestId: uuid(), draft: true, ...rxBase });
    const rxId: string = draft.json?.prescription?.prescriptionId;
    check('draft from the catalogue: DRAFT v1, catalogue revision recorded, not authorised',
      draft.status === 201 && draft.json.prescription.current.status === 'DRAFT' && draft.json.prescription.current.catalogueRef?.revision === 1 && !draft.json.prescription.authorisation, draft.text.slice(0, 300));
    const mism = await Promise.all([
      api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, { clientRequestId: uuid(), draft: true, ...rxBase, strength: '2 g' }),
      api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, { clientRequestId: uuid(), draft: true, ...rxBase, route: 'ORAL' }),
      api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, { clientRequestId: uuid(), draft: true, ...rxBase, medicationId: 'MED-NOT-REAL-1' }),
    ]);
    check('a catalogue reference must agree with the entry (strength, route) and exist → 422', mism.map(r => `${r.status}:${r.json?.error}`).join(',') === '422:catalogue_mismatch,422:catalogue_mismatch,422:unknown_medication', mism.map(r => r.text).join(' | ').slice(0, 300));
    await sleep(200);
    check('the patient does not see the draft (list, realtime)', ((await api.get(P.pat1, `/api/encounters/${encounterId}/prescriptions`)).json as any[]).length === 0 && !sock.patient.events.some(e => e.eventType === 'clinical.prescription.recorded'));
    check('the doctor received the draft event (content-free, not patient-visible)', sock.doc3.events.some(e => e.eventType === 'clinical.prescription.recorded' && e.payload.status === 'DRAFT' && e.payload.patientVisible === false && !JSON.stringify(e).includes('Ceftriaxone')));
    const noAttest = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/authorise`, { clientRequestId: uuid(), expectedVersion: 1 });
    const falseAttest = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/authorise`, { clientRequestId: uuid(), expectedVersion: 1, attestation: false });
    const edited = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/amend`, { clientRequestId: uuid(), expectedVersion: 1, changeReason: 'Draft revised', ...rxBase, duration: '5 days' });
    const stale = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/authorise`, { clientRequestId: uuid(), expectedVersion: 1, attestation: true });
    check('authorisation must be attested (400 without or false) and name the reviewed version (409 after a draft edit)',
      noAttest.status === 400 && falseAttest.status === 400 && edited.status === 200 && edited.json.prescription.current.status === 'DRAFT' && stale.status === 409, `${noAttest.status} ${falseAttest.status} ${edited.status} ${stale.status}`);
    const denied = await Promise.all([P.h1, P.pat1, P.doc1, P.mgmt].map(p => api.post(p, `/api/encounters/${encounterId}/prescriptions/${rxId}/authorise`, { clientRequestId: uuid(), expectedVersion: 2, attestation: true })));
    check('only the assigned doctor authorises: coordinator 403, patient 403, other hospital’s doctor 404, management 403', statuses(denied) === '403,403,404,403', statuses(denied));
    const auth = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/authorise`, { clientRequestId: uuid(), expectedVersion: 2, attestation: true });
    check('explicit authorisation: v3 ACTIVE (AUTHORISED), authorisation names the doctor and version',
      auth.status === 200 && auth.json.prescription.current.status === 'ACTIVE' && auth.json.prescription.current.action === 'AUTHORISED' && auth.json.prescription.authorisation?.version === 3 && auth.json.prescription.authorisation.authorisedBy.practitionerId === 'PRAC-BLR-001-01', auth.text.slice(0, 300));
    const again = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${rxId}/authorise`, { clientRequestId: uuid(), expectedVersion: 3, attestation: true });
    check('authorising twice → 409 not_a_draft', again.status === 409 && again.json.error === 'not_a_draft');
    await sleep(200);
    const patRx = (await api.get(P.pat1, `/api/encounters/${encounterId}/prescriptions`)).json as any[];
    check('the patient now sees the authorised prescription (from the authorisation, dosage form shown, no history)',
      patRx.length === 1 && patRx[0].status === 'ACTIVE' && patRx[0].formulation === 'INJECTION' && patRx[0].duration === '5 days' && patRx[0].prescribedAt === auth.json.prescription.current.recordedAt && !('history' in patRx[0]) && !JSON.stringify(patRx).includes('demo-doc'));
    check('…and was notified once it was authorised', sock.patient.events.some(e => e.eventType === 'clinical.prescription.recorded' && e.payload.action === 'AUTHORISED' && e.payload.patientVisible === true));
    const d2 = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, { clientRequestId: uuid(), draft: true, medication: 'Ondansetron', strength: '4 mg/2 mL', formulation: 'INJECTION', dose: '4 mg', route: 'IV', frequency: 'Every 8 hours as needed', medicationId: 'MED-ONDANSETRON-4-INJ' });
    const discarded = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${d2.json?.prescription?.prescriptionId}/discard`, { clientRequestId: uuid(), expectedVersion: 1, changeReason: 'Not needed after review' });
    const stopDraft = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions/${d2.json?.prescription?.prescriptionId}/discontinue`, { clientRequestId: uuid(), expectedVersion: 2, changeReason: 'x' });
    check('a draft can be discarded (CANCELLED, final) and never reaches the patient', d2.status === 201 && discarded.status === 200 && discarded.json.prescription.current.status === 'CANCELLED' && stopDraft.status === 409 &&
      ((await api.get(P.pat1, `/api/encounters/${encounterId}/prescriptions`)).json as any[]).length === 1);
    const direct = await api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, { clientRequestId: uuid(), medication: 'Paracetamol', strength: '500 mg', formulation: 'TABLET', dose: '1 tablet', route: 'ORAL', frequency: 'Every 6 hours as needed' });
    check('writing without draft is still a single explicit write-and-authorise action (free text allowed, no catalogue reference)', direct.status === 201 && direct.json.prescription.current.status === 'ACTIVE' && direct.json.prescription.authorisation?.version === 1 && !direct.json.prescription.current.catalogueRef);

    // ------------------------------------------------------------ D. catalogue samples, types, versions
    console.log('\n[D] Synthetic samples, document types and versions');
    const scans = (await api.get(P.doc3, '/api/catalogue/scan-assets')).json;
    const types = new Set((scans?.entries ?? []).map((e: any) => e.documentType));
    check('the doctor browses the synthetic sample library (X-ray, CT, MRI, ultrasound, ECG, lab report)', ['XRAY', 'CT', 'MRI', 'ULTRASOUND', 'ECG', 'LAB_REPORT'].every(t => types.has(t)) && scans.entries.every((e: any) => e.designation === 'SYNTHETIC'));
    const assetBytes = fs.readFileSync(path.join(ROOT, 'data/catalogue/assets/synthetic-chest-xray-pa.png'));
    const preview = await api.get(P.doc3, '/api/catalogue/scan-assets/SCAN-XRAY-CHEST-PA/content');
    check('a sample previews through the API with safe headers (byte-exact)', preview.status === 200 && preview.body.equals(assetBytes) && preview.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(preview.headers.get('content-security-policy') ?? ''));
    const assetReads = await Promise.all([P.pat1, P.h1, P.a1, P.mgmt].map(p => api.get(p, '/api/catalogue/scan-assets/SCAN-XRAY-CHEST-PA/content')));
    check('patients, coordinators, crews and management cannot browse the clinical catalogue (403)', statuses(assetReads) === '403,403,403,403', statuses(assetReads));
    const attach = await api.post(P.doc3, `/api/encounters/${encounterId}/documents/samples`, { clientRequestId: uuid(), assetId: 'SCAN-XRAY-CHEST-PA', patientVisible: false });
    const sample = attach.json?.document;
    check('attaching a sample: AVAILABLE, origin CATALOGUE_SAMPLE, SYNTHETIC_DEMO, typed, version 1',
      attach.status === 201 && sample.status === 'AVAILABLE' && sample.origin === 'CATALOGUE_SAMPLE' && sample.dataStatus === 'SYNTHETIC_DEMO' && sample.documentType === 'XRAY' && sample.sample?.designation === 'SYNTHETIC' && sample.version === 1 && sample.sha256 === sha(assetBytes), attach.text.slice(0, 300));
    const dl = await api.get(P.doc3, `/api/encounters/${encounterId}/documents/${sample.documentId}/content`);
    check('the attached sample downloads byte-exact from document storage', dl.status === 200 && dl.body.equals(assetBytes));
    const badSamples = await Promise.all([
      api.post(P.doc3, `/api/encounters/${encounterId}/documents/samples`, { clientRequestId: uuid(), assetId: 'SCAN-NOT-THERE', patientVisible: false }),
      api.post(P.doc3, `/api/encounters/${encounterId}/documents/samples`, { clientRequestId: uuid(), assetId: '../../etc/passwd', patientVisible: false }),
      api.post(P.doc3, `/api/encounters/${encounterId}/documents/samples`, { clientRequestId: uuid(), assetId: 'SCAN-XRAY-CHEST-PA', patientVisible: false, assetRef: '../secret.png' }),
      api.post(P.h1, `/api/encounters/${encounterId}/documents/samples`, { clientRequestId: uuid(), assetId: 'SCAN-XRAY-CHEST-PA', patientVisible: false }),
      api.post(P.pat1, `/api/encounters/${encounterId}/documents/samples`, { clientRequestId: uuid(), assetId: 'SCAN-XRAY-CHEST-PA', patientVisible: false }),
      api.post(P.doc1, `/api/encounters/${encounterId}/documents/samples`, { clientRequestId: uuid(), assetId: 'SCAN-XRAY-CHEST-PA', patientVisible: false }),
    ]);
    check('unknown sample 422; path as id 400; a file reference 400; coordinator 403; patient 403; other hospital’s doctor 404', statuses(badSamples) === '422,400,400,403,403,404', statuses(badSamples));
    check('the unshared sample is invisible to the patient', !((await api.get(P.pat1, `/api/encounters/${encounterId}/documents`)).json as any[]).some(d => d.documentId === sample.documentId));
    await sleep(200);
    check('realtime: the doctor learns of the sample (origin and type, no title); the patient does not',
      sock.doc3.events.some(e => e.eventType === 'clinical.document.stored' && e.payload.origin === 'CATALOGUE_SAMPLE' && e.payload.documentType === 'XRAY' && !('title' in e.payload)) && !sock.patient.events.some(e => e.eventType === 'clinical.document.stored'));

    const decl = await api.post(P.doc3, `/api/encounters/${encounterId}/documents`, { clientRequestId: uuid(), category: 'IMAGING', documentType: 'XRAY', title: 'Chest X-ray — repeat', fileName: 'cxr-repeat.png', contentType: 'image/png', sizeBytes: PNG.length, sha256: sha(PNG), patientVisible: true, supersedesDocumentId: sample.documentId });
    const up = await api.req('PUT', decl.json?.upload?.url ?? '/api/uploads/none', P.doc3, undefined, { raw: PNG, headers: { 'content-type': 'image/png' } });
    const docs = (await api.get(P.doc3, `/api/encounters/${encounterId}/documents`)).json as any[];
    const v1 = docs.find(d => d.documentId === sample.documentId);
    check('an uploaded new version replaces the sample: v2 in the same series, the sample kept and marked superseded',
      decl.status === 201 && up.status === 200 && up.json.document.version === 2 && up.json.document.seriesId === sample.documentId && up.json.document.origin === 'UPLOAD' && v1?.supersededBy === up.json.document.documentId, `${decl.status} ${up.status} ${decl.text.slice(0, 200)}`);
    const badVersions = await Promise.all([
      api.post(P.doc3, `/api/encounters/${encounterId}/documents`, { clientRequestId: uuid(), category: 'IMAGING', title: 'again', fileName: 'x.png', contentType: 'image/png', sizeBytes: PNG.length, sha256: sha(PNG), patientVisible: false, supersedesDocumentId: sample.documentId }),
      api.post(P.doc3, `/api/encounters/${encounterId}/documents/samples`, { clientRequestId: uuid(), assetId: 'SCAN-LAB-CBC', patientVisible: false, supersedesDocumentId: up.json?.document?.documentId }),
      api.post(P.doc3, `/api/encounters/${encounterId}/documents`, { clientRequestId: uuid(), category: 'LABORATORY', documentType: 'XRAY', title: 'x', fileName: 'x.png', contentType: 'image/png', sizeBytes: 10, sha256: sha(PNG), patientVisible: false }),
      api.post(P.doc3, `/api/encounters/${encounterId}/documents`, { clientRequestId: uuid(), category: 'IMAGING', title: 'huge', fileName: 'x.png', contentType: 'image/png', sizeBytes: 20 * 1024 * 1024 + 1, sha256: sha(PNG), patientVisible: false }),
    ]);
    check('versions: replacing an already replaced document 422, across categories 422; a type that contradicts its category 400; oversized 400', statuses(badVersions) === '422,422,400,400', badVersions.map(r => `${r.status}:${r.json?.error}`).join(','));
    const patDocs = (await api.get(P.pat1, `/api/encounters/${encounterId}/documents`)).json as any[];
    check('the patient sees the released upload with its type and origin (no staff ids)', patDocs.length === 1 && patDocs[0].documentType === 'XRAY' && patDocs[0].origin === 'UPLOAD' && !JSON.stringify(patDocs).includes('demo-doc'));
    const shared = await api.post(P.doc3, `/api/encounters/${encounterId}/documents/samples`, { clientRequestId: uuid(), assetId: 'SCAN-ECG-LEAD-II', patientVisible: true });
    const patSample = ((await api.get(P.pat1, `/api/encounters/${encounterId}/documents`)).json as any[]).find(d => d.documentId === shared.json?.document?.documentId);
    check('a sample released to the patient is shown to them as a synthetic sample', shared.status === 201 && patSample?.origin === 'CATALOGUE_SAMPLE' && patSample.sample?.designation === 'SYNTHETIC' && !patSample.sample.assetId);

    // ------------------------------------------------------------ E. internal clinical notes
    console.log('\n[E] Internal clinical notes');
    const note = await api.post(P.doc3, `/api/encounters/${encounterId}/notes`, { clientRequestId: uuid(), noteType: 'ASSESSMENT', title: 'Primary survey', text: 'Airway patent. Scalp laceration. Suspected left tibial fracture — confirm with imaging.' });
    const noteId: string = note.json?.note?.noteId;
    const amend = await api.post(P.doc3, `/api/encounters/${encounterId}/notes/${noteId}/amend`, { clientRequestId: uuid(), expectedVersion: 1, changeReason: 'Added plan', noteType: 'ASSESSMENT', title: 'Primary survey', text: 'Airway patent. Scalp laceration. Suspected left tibial fracture — repeat X-ray ordered.' });
    const staleNote = await api.post(P.doc3, `/api/encounters/${encounterId}/notes/${noteId}/amend`, { clientRequestId: uuid(), expectedVersion: 1, changeReason: 'x', noteType: 'ASSESSMENT', title: 'Primary survey', text: 'Something else.' });
    check('the doctor writes and amends a note (v2 with author); a stale edit is refused', note.status === 201 && amend.status === 200 && amend.json.note.history.length === 2 && amend.json.note.current.author?.displayName === 'Dr. Ravi Kumar' && staleNote.status === 409);
    const noteReads = await Promise.all([P.pat1, P.h1, P.mgmt, P.doc1].map(p => api.get(p, `/api/encounters/${encounterId}/notes`)));
    check('notes are internal: patient 403, coordinator 403, management 403, other hospital’s doctor 404', statuses(noteReads) === '403,403,403,404', statuses(noteReads));
    await sleep(200);
    check('note events reach the doctor only and carry no text', sock.doc3.events.some(e => e.eventType === 'clinical.note.recorded' && e.payload.patientVisible === false && !JSON.stringify(e).includes('Airway')) &&
      !sock.patient.events.some(e => e.eventType === 'clinical.note.recorded') && !sock.mgmt.events.some(e => e.eventType === 'clinical.note.recorded'));
    const hist = JSON.stringify((await api.get(P.mgmt, '/api/events/history?limit=1000')).json);
    check('the management ledger lists no clinical record events', !hist.includes('clinical.note.recorded') && !hist.includes('clinical.prescription.recorded') && !hist.includes('clinical.document.stored'));
    const tl = (await api.get(P.doc3, `/api/cases/${CASE}/timeline`)).json as any[];
    check('the doctor’s case timeline holds the real recorded history (intake → arrival → handover → doctor → records)',
      ['patient.emergency.created', 'encounter.arrival.recorded', 'encounter.handover.recorded', 'encounter.doctor.assigned', 'clinical.prescription.recorded', 'clinical.note.recorded', 'clinical.prehospital.recorded'].every(t => tl.some(e => e.eventType === t)), tl.map(e => e.eventType).join(','));

    // ------------------------------------------------------------ F. reassignment
    console.log('\n[F] Reassignment removes access at once');
    const re = await api.post(P.h1, `/api/encounters/${encounterId}/doctor`, { clientRequestId: uuid(), practitionerId: 'PRAC-BLR-001-02', reason: 'SHIFT_HANDOVER' });
    const after = await Promise.all([
      api.get(P.doc3, `/api/encounters/${encounterId}/notes`), api.get(P.doc3, `/api/encounters/${encounterId}/prehospital`), api.get(P.doc3, `/api/cases/${CASE}/prehospital`),
      api.post(P.doc3, `/api/encounters/${encounterId}/documents/samples`, { clientRequestId: uuid(), assetId: 'SCAN-CT-HEAD-AXIAL', patientVisible: false }),
      api.post(P.doc3, `/api/encounters/${encounterId}/prescriptions`, { clientRequestId: uuid(), draft: true, ...rxBase }),
      api.post(P.doc3, `/api/encounters/${encounterId}/notes`, { clientRequestId: uuid(), noteType: 'PROGRESS', title: 't', text: 'x' }),
    ]);
    check('after a shift handover Dr. Ravi Kumar gets 404 for notes, the pre-hospital record, samples, drafts and new notes', re.status === 200 && statuses(after) === '404,404,404,404,404,404', statuses(after));

    // ------------------------------------------------------------ G. realtime fault injection
    console.log('\n[G] Realtime interruption and recovery (demo fault injection)');
    const probe = { s: (await api.socket(P.pat1)).s };
    let dropped = false;
    probe.s.on('disconnect', () => { dropped = true; });
    const notAdmin = await api.post(P.mgmt, '/api/demo/realtime-interruption', { seconds: 5 });
    const tooLong = await api.post(P.admin, '/api/demo/realtime-interruption', { seconds: 600 });
    const cut = await api.post(P.admin, '/api/demo/realtime-interruption', { seconds: 5 });
    await sleep(500);
    const refused = await api.socket(P.pat1);
    const status = (await api.get(P.admin, '/api/demo/realtime-interruption')).json;
    check('only the demo administrator interrupts (403), within bounds (400); live connections are closed and new handshakes refused',
      notAdmin.status === 403 && tooLong.status === 400 && cut.status === 200 && cut.json.closed >= 1 && dropped && !!refused.error && status?.interrupted === true, `${notAdmin.status} ${tooLong.status} ${cut.status} ${refused.error} ${JSON.stringify(status)}`);
    refused.s.close();
    check('REST keeps answering during the interruption', (await api.get(P.pat1, '/api/encounters')).status === 200);
    await sleep(5200);
    const back = await api.socket(P.pat1);
    check('after the window, connections succeed again (recovery)', !back.error && (await api.get(undefined, '/api/health')).status === 200, back.error);
    back.s.close();
    probe.s.close();

    // ------------------------------------------------------------ H. catalogue administration, demo reset
    console.log('\n[H] Catalogue administration and demo reset');
    const exported = await api.get(P.admin, '/api/catalogue/medications/export?format=csv');
    const notAdminImport = await Promise.all([P.doc3, P.mgmt, P.h1].map(p => api.post(p, '/api/catalogue/medications/import/preview', { format: 'csv', content: exported.text })));
    check('import is administrators only (clinician, management, coordinator 403)', statuses(notAdminImport) === '403,403,403', statuses(notAdminImport));
    const withdrawn = exported.text.replace('MED-CEFTRIAXONE-1G-INJ,ACTIVE', 'MED-CEFTRIAXONE-1G-INJ,WITHDRAWN');
    const prev = await api.post(P.admin, '/api/catalogue/medications/import/preview', { format: 'csv', content: withdrawn });
    const applied = await api.post(P.admin, '/api/catalogue/medications/import/apply', { clientRequestId: uuid(), previewId: prev.json?.previewId, confirmChanges: true });
    check('admin withdraws an entry (preview → confirmed apply → version 2)', prev.json?.summary?.changed === 1 && applied.status === 200 && applied.json.catalogueVersion === 2);
    const audit = (await api.get(P.admin, '/api/audit?limit=2000')).json?.entries as any[];
    check('the audit trail records catalogue, sample, authorisation, note, pre-hospital and fault-injection actions without content',
      ['catalogue.import', 'document.sample.attach', 'prescription.authorise', 'prescription.discard', 'note.create', 'prehospital.record', 'prehospital.simulate', 'demo.realtime.interrupt'].every(a => audit.some(x => x.action === a && x.outcome === 'ALLOWED')) &&
      !JSON.stringify(audit).includes('Airway') && !JSON.stringify(audit).includes('Ceftriaxone'));
    const resetDenied = await api.post(P.mgmt, '/api/demo/reset');
    const reset = await api.post(P.admin, '/api/demo/reset');
    const afterReset = (await api.get(P.doc3, '/api/catalogue/medications?q=ceftriaxone')).json;
    check('demo reset (admin only) restores the bundled catalogue (version 1, entry active again)', resetDenied.status === 403 && reset.status === 200 && afterReset?.catalogueVersion === 1 && afterReset.entries?.[0]?.status === 'ACTIVE');
    check('…and clears the demo clinical records (encounter, pre-hospital record)', (await api.get(P.pat1, '/api/encounters')).json?.length === 0 && (await api.get(P.pat1, `/api/cases/${CASE}/prehospital`)).status === 404);
    check('API process still healthy at the end', (await api.get(undefined, '/api/health')).status === 200);
    for (const s of Object.values(sock)) s.s.close();
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
  console.log('✓ Doctor workspace suite PASSED.');
  process.exit(0);
}

main().catch(err => { console.error('✗ Doctor workspace suite crashed:', err); process.exit(1); });
