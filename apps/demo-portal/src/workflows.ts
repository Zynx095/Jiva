/**
 * Demo scenarios as sequences of REAL backend workflows. Every step calls the JIVA API as the actor who
 * would do it (the ambulance crew, a hospital coordinator, the assigned clinician, the demo administrator)
 * and then reads the outcome back from authoritative state; a step succeeds only when the server confirms
 * it. Nothing here decides routing, fabricates a state or bypasses authorization — the existing engines,
 * the shadow decision authority and the access rules do the work, exactly as for the operational apps.
 *
 * Kept free of browser and framework dependencies (the API call and the realtime status are injected), so
 * the same scenarios run in the portal and in tests/integration/demo-portal-scenarios.test.ts.
 */

export interface ApiResult {
  status: number;
  ok: boolean;
  /** JSON from the API (shapes differ per endpoint); every step reads it defensively and checks the outcome. */
  body: any;
}

export interface Deps {
  call: (persona: string, method: 'GET' | 'POST', path: string, body?: unknown) => Promise<ApiResult>;
  /** Is the portal's own live (Socket.IO) connection up right now? */
  realtimeConnected: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
}

export interface Ctx {
  caseId: string;
  requestIds: Record<string, string>;
  encounterId?: string;
  documentId?: string;
  prescriptionId?: string;
  prescriptionVersion?: number;
}

export const newContext = (): Ctx => ({ caseId: DEMO.caseId, requestIds: {} });

export class StepFailed extends Error {}

export interface Step {
  id: string;
  title: string;
  /** Persona the step acts as. */
  persona: string;
  /** Who that is, in words. */
  actor: string;
  /** What happens, in words. */
  description: string;
  run: (ctx: Ctx, deps: Deps) => Promise<string>;
}

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  /** Resets the demo first (everyone watching sees the reset). */
  resets: boolean;
  steps: Step[];
}

// ------------------------------------------------------------------ the synthetic cast

export const DEMO = {
  caseId: 'CASE-BLR-876',
  crew: { persona: 'demo-amb-2', ambulanceId: 'AMB-BLR-002' },
  scene: { latitude: 13.0431, longitude: 77.5891, address: 'Hebbal flyover (synthetic scene)' },
  admin: 'demo-admin',
  management: 'demo-mgmt-1',
  patient: 'demo-patient-1',
  hospitals: {
    'HOSP-BLR-001': { persona: 'demo-hosp-1', name: 'Hebbal' },
    'HOSP-BLR-002': { persona: 'demo-hosp-2', name: 'Whitefield' },
    'HOSP-BLR-004': { persona: 'demo-hosp-4', name: 'Indiranagar' },
  } as Record<string, { persona: string; name: string }>,
  doctor: { persona: 'demo-doc-3', practitionerId: 'PRAC-BLR-001-01', name: 'Dr. Ravi Kumar', hospitalId: 'HOSP-BLR-001' },
};

/** Clinician personas by roster id (only these practitioners can act in the demo). */
export const PRACTITIONER_PERSONA: Record<string, string> = {
  'PRAC-BLR-001-01': 'demo-doc-3',
  'PRAC-BLR-002-01': 'demo-doc-4',
  'PRAC-BLR-003-01': 'demo-doc-5',
  'PRAC-BLR-004-01': 'demo-doc-1',
  'PRAC-BLR-004-02': 'demo-doc-2',
};

const hospitalName = (id: string) => DEMO.hospitals[id]?.name ?? id;

// ------------------------------------------------------------------ helpers

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultUuid = () => crypto.randomUUID();

function must(r: ApiResult, expected: number[], what: string): void {
  if (!expected.includes(r.status)) {
    const why = r.status === 400 ? (r.body?.issues ?? []).map((i: { path: string; message: string }) => `${i.path}: ${i.message}`).join('; ') : r.body?.message ?? r.body?.error ?? '';
    throw new StepFailed(`${what}: the API answered ${r.status}${why ? ` (${why})` : ''}`);
  }
}

async function waitFor<T>(deps: Deps, what: string, fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined && v !== null && (v as unknown) !== false) return v;
    if (Date.now() - t0 > ms) throw new StepFailed(`Timed out waiting for ${what}`);
    await sleep(300);
  }
}

const ambulance = async (deps: Deps) => ((await deps.call(DEMO.management, 'GET', '/api/ambulances')).body as Array<{ ambulanceId: string; status: string; destinationHospital?: string; assignedPatient?: string }>)
  .find((a) => a.ambulanceId === DEMO.crew.ambulanceId);

// ------------------------------------------------------------------ steps

export const steps = {
  reset: (): Step => ({
    id: 'reset', title: 'Reset the demo', persona: DEMO.admin, actor: 'Demo administrator',
    description: 'Clears every demo case, encounter and record and re-seeds the synthetic network. Demo mode only; operational mode has no reset.',
    run: async (_ctx, deps) => {
      must(await deps.call(DEMO.admin, 'POST', '/api/demo/reset'), [200], 'Demo reset');
      return 'Demo state cleared and re-seeded.';
    },
  }),

  report: (): Step => ({
    id: 'report', title: 'The crew reports the emergency', persona: DEMO.crew.persona, actor: `Ambulance crew ${DEMO.crew.ambulanceId}`,
    description: 'Crew intake from the scene: location, severity, reported symptoms, suspected cause, vital signs (one questionable, one unavailable) and a symptom description.',
    run: async (ctx, deps) => {
      const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
      const r = await deps.call(DEMO.crew.persona, 'POST', '/api/emergencies', {
        clientRequestId: (deps.uuid ?? defaultUuid)(), caseRef: DEMO.caseId,
        location: { latitude: DEMO.scene.latitude, longitude: DEMO.scene.longitude, address: DEMO.scene.address, method: 'MAP_PIN' },
        severity: 'CRITICAL', reportedSymptoms: ['Bleeding from the scalp', 'Leg deformity'], suspectedCause: 'Road traffic accident', requiredCapabilities: [],
        clinical: {
          measurements: [
            { type: 'HEART_RATE', value: 118, unit: 'bpm', observedAt: ago(3) },
            { type: 'SPO2', value: 92, unit: '%', observedAt: ago(3), quality: 'QUESTIONABLE' },
            { type: 'RESPIRATORY_RATE', value: 22, unit: 'breaths/min', observedAt: ago(3) },
          ],
          unavailable: [{ type: 'BLOOD_PRESSURE', reason: 'EQUIPMENT_UNAVAILABLE' }],
          symptomDescription: 'Synthetic demo: scalp laceration bleeding freely; deformity of the left lower leg; patient reports pain 8/10.',
          symptomOnsetAt: ago(30),
        },
      });
      must(r, [202], 'Emergency intake');
      ctx.caseId = r.body.caseId;
      return `Case ${r.body.caseId} opened; ${DEMO.crew.ambulanceId} is attending (pre-hospital record ${r.body.prehospitalEntryId}).`;
    },
  }),

  referrals: (hospitalIds: string[]): Step => ({
    id: 'referrals', title: 'JIVA refers the case to capable hospitals', persona: DEMO.management, actor: 'JIVA coordination (existing engine)',
    description: `The existing assessment and eligibility rules choose the hospitals that list the needed care; each receives its own referral. Checked as each hospital: ${hospitalIds.map(hospitalName).join(', ')}.`,
    run: async (ctx, deps) => {
      for (const id of hospitalIds) {
        const persona = DEMO.hospitals[id].persona;
        ctx.requestIds[id] = await waitFor(deps, `the referral to ${hospitalName(id)}`, async () =>
          ((await deps.call(persona, 'GET', `/api/hospitals/${id}/requests`)).body as Array<{ caseId: string; requestId: string }>).find((q) => q.caseId === ctx.caseId)?.requestId);
      }
      return `Referrals received by ${hospitalIds.map(hospitalName).join(', ')}.`;
    },
  }),

  answer: (hospitalId: string, status: 'ACCEPTED' | 'REJECTED' | 'UNAVAILABLE', validityMs = 30 * 60_000): Step => ({
    id: `answer-${hospitalId}-${status}-${validityMs}`,
    title: `${hospitalName(hospitalId)} ${status === 'ACCEPTED' ? 'accepts' : status === 'REJECTED' ? 'declines' : 'reports it is busy (unavailable)'}${status === 'ACCEPTED' && validityMs < 60_000 ? ` for ${Math.round(validityMs / 1000)} s` : ''}`,
    persona: DEMO.hospitals[hospitalId].persona, actor: `${hospitalName(hospitalId)} coordinator`,
    description: `An explicit, referral-bound answer${status === 'ACCEPTED' ? ` valid for ${validityMs < 60_000 ? `${Math.round(validityMs / 1000)} seconds` : `${Math.round(validityMs / 60_000)} minutes`}` : ''}. JIVA refuses answers to unknown or closed referrals.`,
    run: async (ctx, deps) => {
      const requestId = ctx.requestIds[hospitalId];
      if (!requestId) throw new StepFailed(`${hospitalName(hospitalId)} has no referral for ${ctx.caseId} yet`);
      const uuid = deps.uuid ?? defaultUuid;
      const now = new Date().toISOString();
      const r = await deps.call(DEMO.hospitals[hospitalId].persona, 'POST', '/api/events', {
        eventId: uuid(), eventType: 'hospital.acceptance.received', timestamp: now, version: '1.0', source: { type: 'hospital', id: hospitalId },
        payload: {
          responseId: `R-DEMO-${uuid().slice(0, 8)}`, requestId, caseId: ctx.caseId, hospitalId, status,
          acceptedCapabilities: status === 'ACCEPTED' ? ['EMERGENCY', 'TRAUMA', 'ICU'] : [],
          limitations: status === 'REJECTED' ? ['Trauma team unavailable (synthetic)'] : status === 'UNAVAILABLE' ? ['Emergency department at capacity (synthetic)'] : [],
          respondedAt: now, validUntil: new Date(Date.now() + validityMs).toISOString(), responderRole: 'CLINICAL_COORDINATOR', source: 'SYNTHETIC_DEMO',
        },
      });
      must(r, [202], `${hospitalName(hospitalId)}'s answer`);
      return `${hospitalName(hospitalId)} answered ${status}.`;
    },
  }),

  destination: (hospitalId: string | null): Step => ({
    id: `destination-${hospitalId ?? 'none'}`,
    title: hospitalId ? `The crew is routed to ${hospitalName(hospitalId)}` : 'The crew holds: no hospital has accepted',
    persona: DEMO.management, actor: 'Routing (existing engine, shadow decision authority)',
    description: hospitalId ? 'Read back from the ambulance state: JIVA routes only to a hospital that explicitly accepted this case.' : 'Read back from the ambulance state: without an accepting hospital there is no destination.',
    run: async (_ctx, deps) => {
      if (hospitalId) {
        await waitFor(deps, `a route to ${hospitalName(hospitalId)}`, async () => (await ambulance(deps))?.destinationHospital === hospitalId);
        return `${DEMO.crew.ambulanceId} now heads to ${hospitalName(hospitalId)}.`;
      }
      const sleep = deps.sleep ?? defaultSleep;
      await sleep(800);
      const a = await ambulance(deps);
      if (a?.destinationHospital) throw new StepFailed(`Unexpected destination ${a.destinationHospital}`);
      return `${DEMO.crew.ambulanceId} has no destination yet (status ${a?.status ?? 'unknown'}).`;
    },
  }),

  expiry: (hospitalId: string): Step => ({
    id: `expiry-${hospitalId}`, title: `${hospitalName(hospitalId)}'s acceptance expires`, persona: DEMO.admin, actor: 'Expiry engine (existing)',
    description: 'The answer reaches its validUntil; the existing expiry engine records a case-scoped expiry and re-evaluates only this case’s destination.',
    run: async (ctx, deps) => {
      await waitFor(deps, 'the expiry to be recorded', async () =>
        ((await deps.call(DEMO.admin, 'GET', '/api/events/history?limit=500')).body as Array<{ eventType: string; payload: Record<string, unknown> }>)
          .some((e) => e.eventType === 'hospital.acceptance.expired' && e.payload.caseId === ctx.caseId && e.payload.hospitalId === hospitalId && e.payload.kind === 'RESPONSE_VALIDITY'), 60_000);
      return `hospital.acceptance.expired (RESPONSE_VALIDITY) recorded for ${hospitalName(hospitalId)}.`;
    },
  }),

  gpsArrival: (hospitalId: string): Step => ({
    id: `gps-${hospitalId}`, title: `The ambulance reaches ${hospitalName(hospitalId)} (simulated position)`, persona: DEMO.crew.persona, actor: `Ambulance crew ${DEMO.crew.ambulanceId}`,
    description: 'One simulated position update at the hospital (no GPS receiver is connected to JIVA). The arrival geofence marks the ambulance as arrived — it never records the hospital arrival or the handover.',
    run: async (_ctx, deps) => {
      const h = ((await deps.call(DEMO.management, 'GET', '/api/hospitals')).body as Array<{ hospitalId: string; location: { latitude: number; longitude: number } }>).find((x) => x.hospitalId === hospitalId);
      if (!h) throw new StepFailed(`${hospitalId} is not in the network`);
      const uuid = deps.uuid ?? defaultUuid;
      must(await deps.call(DEMO.crew.persona, 'POST', '/api/events', {
        eventId: uuid(), eventType: 'ambulance.location.updated', timestamp: new Date().toISOString(), version: '1.0', source: { type: 'ambulance', id: DEMO.crew.ambulanceId },
        payload: { source: 'SIMULATED', ambulanceId: DEMO.crew.ambulanceId, coordinates: { latitude: h.location.latitude, longitude: h.location.longitude }, speedKmh: 5, heading: 0 },
      }), [202], 'Simulated position update');
      await waitFor(deps, 'the geofence arrival', async () => (await ambulance(deps))?.status === 'ARRIVED');
      return `${DEMO.crew.ambulanceId} is at ${hospitalName(hospitalId)} (arrival geofence from a simulated position; awaiting the hospital's record).`;
    },
  }),

  recordArrival: (hospitalId: string): Step => ({
    id: `arrival-${hospitalId}`, title: `${hospitalName(hospitalId)} records the arrival`, persona: DEMO.hospitals[hospitalId].persona, actor: `${hospitalName(hospitalId)} coordinator`,
    description: 'The hospital confirms the patient is physically there: this opens the encounter.',
    run: async (ctx, deps) => {
      const r = await deps.call(DEMO.hospitals[hospitalId].persona, 'POST', `/api/hospitals/${hospitalId}/arrivals`, { clientRequestId: (deps.uuid ?? defaultUuid)(), caseId: ctx.caseId });
      must(r, [201], 'Arrival');
      ctx.encounterId = r.body.encounter?.encounterId;
      return `Encounter ${ctx.encounterId} opened (ARRIVED).`;
    },
  }),

  recordHandover: (hospitalId: string): Step => ({
    id: `handover-${hospitalId}`, title: `${hospitalName(hospitalId)} records the handover`, persona: DEMO.hospitals[hospitalId].persona, actor: `${hospitalName(hospitalId)} coordinator`,
    description: 'The crew hands the patient over: in-hospital care begins and the crew is released.',
    run: async (ctx, deps) => {
      if (!ctx.encounterId) throw new StepFailed('No encounter yet: record the arrival first');
      const r = await deps.call(DEMO.hospitals[hospitalId].persona, 'POST', `/api/encounters/${ctx.encounterId}/handover`, { clientRequestId: (deps.uuid ?? defaultUuid)() });
      must(r, [200], 'Handover');
      const crew = await waitFor(deps, 'the crew to be released', async () => ((await ambulance(deps))?.status === 'AVAILABLE' ? true : undefined));
      return `Encounter IN_CARE; ${DEMO.crew.ambulanceId} released (${crew ? 'available' : ''}).`;
    },
  }),

  assignDoctor: (): Step => ({
    id: 'assign', title: `The coordinator assigns ${DEMO.doctor.name}`, persona: DEMO.hospitals[DEMO.doctor.hospitalId].persona, actor: `${hospitalName(DEMO.doctor.hospitalId)} coordinator`,
    description: 'An active clinician on the hospital’s (synthetic) roster becomes responsible and gains access to this patient’s records.',
    run: async (ctx, deps) => {
      if (!ctx.encounterId) throw new StepFailed('No encounter yet');
      must(await deps.call(DEMO.hospitals[DEMO.doctor.hospitalId].persona, 'POST', `/api/encounters/${ctx.encounterId}/doctor`, { clientRequestId: (deps.uuid ?? defaultUuid)(), practitionerId: DEMO.doctor.practitionerId }), [200], 'Doctor assignment');
      return `${DEMO.doctor.name} is responsible for ${ctx.caseId}.`;
    },
  }),

  doctorReview: (): Step => ({
    id: 'review', title: `${DEMO.doctor.name} reviews the encounter`, persona: DEMO.doctor.persona, actor: DEMO.doctor.name,
    description: 'The doctor workspace reads the encounter, the crew’s pre-hospital record and the history — only because this doctor is assigned.',
    run: async (ctx, deps) => {
      const encs = (await deps.call(DEMO.doctor.persona, 'GET', '/api/encounters')).body as Array<{ encounterId: string }>;
      if (!encs.some((e) => e.encounterId === ctx.encounterId)) throw new StepFailed('The encounter is not in the doctor’s list');
      const ph = await deps.call(DEMO.doctor.persona, 'GET', `/api/encounters/${ctx.encounterId}/prehospital`);
      must(ph, [200], 'Pre-hospital record');
      const other = await deps.call('demo-doc-1', 'GET', `/api/encounters/${ctx.encounterId}`);
      if (other.status !== 404) throw new StepFailed(`A doctor of another hospital got ${other.status} instead of 404`);
      return `Encounter visible to ${DEMO.doctor.name}; ${ph.body.entries.length} crew entr${ph.body.entries.length === 1 ? 'y' : 'ies'} readable; another hospital's doctor gets 404.`;
    },
  }),

  attachSample: (assetId = 'SCAN-XRAY-CHEST-PA', patientVisible = false): Step => ({
    id: `sample-${assetId}`, title: 'The doctor attaches a synthetic scan', persona: DEMO.doctor.persona, actor: DEMO.doctor.name,
    description: `A synthetic sample (${assetId}) from the catalogue is copied into the encounter's documents, verified, and labelled as a sample — never as this patient's result.`,
    run: async (ctx, deps) => {
      if (!ctx.encounterId) throw new StepFailed('No encounter yet');
      const r = await deps.call(DEMO.doctor.persona, 'POST', `/api/encounters/${ctx.encounterId}/documents/samples`, { clientRequestId: (deps.uuid ?? defaultUuid)(), assetId, patientVisible });
      must(r, [201], 'Attaching the sample');
      ctx.documentId = r.body.document.documentId;
      return `${r.body.document.title}: ${r.body.document.status}, origin ${r.body.document.origin}, ${r.body.document.dataStatus}.`;
    },
  }),

  draftPrescription: (): Step => ({
    id: 'draft', title: 'The doctor drafts a demonstration prescription', persona: DEMO.doctor.persona, actor: DEMO.doctor.name,
    description: 'Chosen from the medication catalogue and saved as a DRAFT: not in force and not visible to the patient. Marked as a demonstration.',
    run: async (ctx, deps) => {
      if (!ctx.encounterId) throw new StepFailed('No encounter yet');
      const r = await deps.call(DEMO.doctor.persona, 'POST', `/api/encounters/${ctx.encounterId}/prescriptions`, {
        clientRequestId: (deps.uuid ?? defaultUuid)(), draft: true, medicationId: 'MED-PARACETAMOL-500-TAB', medication: 'Paracetamol', strength: '500 mg', formulation: 'TABLET',
        route: 'ORAL', dose: '1 tablet', frequency: 'Every 6 hours if needed', duration: '3 days', instructions: 'Demonstration only — synthetic prescription, not for a real patient.',
      });
      must(r, [201], 'Draft prescription');
      ctx.prescriptionId = r.body.prescription.prescriptionId;
      ctx.prescriptionVersion = r.body.prescription.current.version;
      const seen = (await deps.call(DEMO.patient, 'GET', `/api/encounters/${ctx.encounterId}/prescriptions`)).body as unknown[];
      if (seen.length) throw new StepFailed('The patient can see a draft');
      return `Draft ${ctx.prescriptionId} v${ctx.prescriptionVersion} saved; the patient sees no prescription.`;
    },
  }),

  authorisePrescription: (): Step => ({
    id: 'authorise', title: 'The doctor authorises it explicitly', persona: DEMO.doctor.persona, actor: DEMO.doctor.name,
    description: 'Authorisation names the exact version reviewed and carries an explicit attestation. Only then is the prescription in force and visible to the patient.',
    run: async (ctx, deps) => {
      if (!ctx.encounterId || !ctx.prescriptionId) throw new StepFailed('No draft yet');
      const r = await deps.call(DEMO.doctor.persona, 'POST', `/api/encounters/${ctx.encounterId}/prescriptions/${ctx.prescriptionId}/authorise`, {
        clientRequestId: (deps.uuid ?? defaultUuid)(), expectedVersion: ctx.prescriptionVersion, attestation: true,
      });
      must(r, [200], 'Authorisation');
      const seen = (await deps.call(DEMO.patient, 'GET', `/api/encounters/${ctx.encounterId}/prescriptions`)).body as Array<{ status: string }>;
      if (seen.length !== 1 || seen[0].status !== 'ACTIVE') throw new StepFailed('The patient does not see the authorised prescription');
      return `v${r.body.prescription.current.version} ${r.body.prescription.current.status}, authorised by ${DEMO.doctor.name}; the patient now sees it.`;
    },
  }),

  interruptRealtime: (seconds: number): Step => ({
    id: 'interrupt', title: `Interrupt realtime delivery for ${seconds} s`, persona: DEMO.admin, actor: 'Demo administrator (fault injection)',
    description: 'Every live connection is closed and new ones are refused for the window. Screens show they lost the live link and keep their last known state; REST keeps answering.',
    run: async (_ctx, deps) => {
      const r = await deps.call(DEMO.admin, 'POST', '/api/demo/realtime-interruption', { seconds });
      must(r, [200], 'Realtime interruption');
      const health = await deps.call(DEMO.patient, 'GET', '/api/encounters');
      return `${r.body.closed} live connection(s) closed until ${new Date(r.body.until).toLocaleTimeString()}; REST answered ${health.status}.`;
    },
  }),

  realtimeRecovery: (seconds: number): Step => ({
    id: 'recovery', title: 'Screens reconnect by themselves', persona: DEMO.admin, actor: 'This portal’s own live connection',
    description: 'Waits for the portal’s live connection to come back after the window — the same automatic reconnection every JIVA screen uses.',
    run: async (_ctx, deps) => {
      const sleep = deps.sleep ?? defaultSleep;
      await sleep(1500);
      const t0 = Date.now();
      await waitFor(deps, 'the live connection to recover', async () => deps.realtimeConnected() || undefined, (seconds + 30) * 1000);
      return `Live again after ${Math.round((Date.now() - t0) / 1000)} s of waiting.`;
    },
  }),
};

// ------------------------------------------------------------------ scenarios

const H1 = 'HOSP-BLR-001';
const H2 = 'HOSP-BLR-002';
const H4 = 'HOSP-BLR-004';
const REFERRED = [H1, H2, H4];

const toHandover = (): Step[] => [steps.reset(), steps.report(), steps.referrals(REFERRED), steps.answer(H1, 'ACCEPTED'), steps.destination(H1), steps.gpsArrival(H1), steps.recordArrival(H1), steps.recordHandover(H1)];

export const SCENARIOS: Scenario[] = [
  {
    id: 'accept', title: 'Successful hospital acceptance', resets: true,
    summary: 'The crew reports, JIVA refers the case to capable hospitals, Hebbal accepts, and the crew is routed there.',
    steps: [steps.reset(), steps.report(), steps.referrals(REFERRED), steps.answer(H1, 'ACCEPTED'), steps.destination(H1)],
  },
  {
    id: 'reject', title: 'Rejection followed by rerouting', resets: true,
    summary: 'Hebbal accepts and the crew is routed; Indiranagar also accepts; Hebbal then declines — the crew is rerouted to Indiranagar.',
    steps: [steps.reset(), steps.report(), steps.referrals(REFERRED), steps.answer(H1, 'ACCEPTED'), steps.destination(H1), steps.answer(H4, 'ACCEPTED'), steps.answer(H1, 'REJECTED'), steps.destination(H4)],
  },
  {
    id: 'busy', title: 'Busy (unavailable) followed by rerouting', resets: true,
    summary: 'Hebbal accepts, then reports it is unavailable; the crew is rerouted to Indiranagar, which had accepted.',
    steps: [steps.reset(), steps.report(), steps.referrals(REFERRED), steps.answer(H1, 'ACCEPTED'), steps.destination(H1), steps.answer(H4, 'ACCEPTED'), steps.answer(H1, 'UNAVAILABLE'), steps.destination(H4)],
  },
  {
    id: 'multi', title: 'Several rejections before an acceptance', resets: true,
    summary: 'Whitefield and Hebbal decline; the crew holds without a destination until Indiranagar accepts.',
    steps: [steps.reset(), steps.report(), steps.referrals(REFERRED), steps.answer(H2, 'REJECTED'), steps.answer(H1, 'REJECTED'), steps.destination(null), steps.answer(H4, 'ACCEPTED'), steps.destination(H4)],
  },
  {
    id: 'expiry', title: 'Referral answer expires', resets: true,
    summary: 'Hebbal accepts for 20 seconds only; Indiranagar accepts for 30 minutes. When Hebbal’s answer lapses, the crew is rerouted.',
    steps: [steps.reset(), steps.report(), steps.referrals(REFERRED), steps.answer(H1, 'ACCEPTED', 20_000), steps.destination(H1), steps.answer(H4, 'ACCEPTED'), steps.expiry(H1), steps.destination(H4)],
  },
  {
    id: 'handover', title: 'Ambulance arrival and handover', resets: true,
    summary: 'The ambulance reaches Hebbal; the hospital records the arrival (encounter) and the handover (care begins, crew released).',
    steps: toHandover(),
  },
  {
    id: 'doctor', title: 'Doctor assignment and encounter review', resets: true,
    summary: 'After the handover the coordinator assigns Dr. Ravi Kumar, who reviews the encounter and the crew’s observations.',
    steps: [...toHandover(), steps.assignDoctor(), steps.doctorReview()],
  },
  {
    id: 'scan', title: 'Synthetic scan attached', resets: true,
    summary: 'The assigned doctor attaches a synthetic chest X-ray from the catalogue; it is stored and shown as a sample.',
    steps: [...toHandover(), steps.assignDoctor(), steps.attachSample()],
  },
  {
    id: 'prescription', title: 'Clinician-authorised demonstration prescription', resets: true,
    summary: 'The doctor drafts a catalogue prescription (invisible to the patient), then authorises it explicitly (now visible).',
    steps: [...toHandover(), steps.assignDoctor(), steps.draftPrescription(), steps.authorisePrescription()],
  },
  {
    id: 'outage', title: 'Realtime outage and recovery', resets: false,
    summary: 'All live connections are cut for 15 seconds; screens show it and reconnect by themselves. (A full API outage: stop and restart the API process.)',
    steps: [steps.interruptRealtime(15), steps.realtimeRecovery(15)],
  },
];
