/**
 * JIVA flagship scenario (synthetic demo data) — deterministic and self-verifying.
 *
 *  T0  reset → emergency reported (CASE-BLR-876, severe trauma, Hebbal area)
 *  T1  assessment → care requirement (EMERGENCY, TRAUMA, ICU)
 *  T2  eligibility → candidate hospitals; T3 acceptance requests sent
 *  T4  AMB-BLR-001 dispatched
 *  T5  Hospital A (HOSP-BLR-001) ACCEPTED → destination A + route
 *  T6  Hospital B (HOSP-BLR-004) ACCEPTED, HOSP-BLR-002 LIMITED (destination unchanged)
 *  T7  ambulance moves along the route (GPS does not trigger rerouting)
 *  T8  Hospital A reports emergency capacity UNAVAILABLE → A ineligible
 *  T9  JIVA reroutes to B → destination.changed + route.recalculated
 *  T10 ambulance drives to B → ambulance.arrived
 *  T11 AI sidecar publishes handoff / anomaly / summary asynchronously
 *
 * Every actor authenticates with its own DEMO persona, so the scenario goes through the
 * same server-side authorization as the UIs. Exits non-zero if the expected state
 * transitions are not observed.
 *
 * Env: API_URL (default http://localhost:4000), SIM_STEP_MS (default 2500).
 */
import { v4 as uuidv4 } from 'uuid';

import { reportShadowDisagreements } from './lib/shadowReport';
const API = process.env.API_URL || 'http://localhost:4000';
const STEP = parseInt(process.env.SIM_STEP_MS || '2500', 10);
const CASE = 'CASE-BLR-876';
const AMB = 'AMB-BLR-001';
const HOSP_A = 'HOSP-BLR-001';
const HOSP_B = 'HOSP-BLR-004';
const HOSP_C = 'HOSP-BLR-002';
const PERSONA: Record<string, string> = {
  admin: 'demo-admin', dispatch: 'demo-mgmt-1',
  [HOSP_A]: 'demo-hosp-1', [HOSP_C]: 'demo-hosp-2', [HOSP_B]: 'demo-hosp-4', [AMB]: 'demo-amb-1',
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function call(persona: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-jiva-demo-user': persona },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status >= 400) throw new Error(`${method} ${path} as ${persona} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const send = (persona: string, event: Record<string, unknown>) =>
  call(persona, 'POST', '/api/events', { eventId: uuidv4(), timestamp: new Date().toISOString(), version: '1.0', ...event });

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 15000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const ambulance = async () => (await call(PERSONA.dispatch, 'GET', '/api/ambulances')).find((a: any) => a.ambulanceId === AMB);
const hospital = async (id: string) => (await call(PERSONA.dispatch, 'GET', '/api/hospitals')).find((h: any) => h.hospitalId === id);

/** The id of the acceptance request this hospital actually received for the case (a response must name it). */
async function requestIdFor(hospitalId: string): Promise<string> {
  const history: any[] = await call(PERSONA.dispatch, 'GET', '/api/events/history?limit=500');
  const req = history.find(e => e.eventType === 'hospital.acceptance.requested' && e.payload.caseId === CASE && e.payload.hospitalId === hospitalId);
  if (!req) throw new Error(`No acceptance request found for ${hospitalId}`);
  return req.payload.requestId;
}

async function respond(hospitalId: string, status: 'ACCEPTED' | 'LIMITED' | 'REJECTED', limitations: string[] = []) {
  const requestId = await requestIdFor(hospitalId);
  return send(PERSONA[hospitalId], {
    eventType: 'hospital.acceptance.received',
    source: { type: 'hospital', id: hospitalId },
    payload: {
      responseId: `RESP-${uuidv4().substring(0, 8)}`,
      requestId,
      caseId: CASE,
      hospitalId,
      status,
      acceptedCapabilities: status === 'REJECTED' ? [] : ['EMERGENCY', 'TRAUMA', 'ICU'],
      limitations,
      respondedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 30 * 60000).toISOString(),
      responderRole: 'CLINICAL_COORDINATOR',
      source: 'SYNTHETIC_DEMO',
    },
  });
}

/** Drive `steps` GPS fixes along the first `fraction` of a route polyline. */
async function drive(points: [number, number][], steps: number, fraction = 1) {
  const last = Math.floor((points.length - 1) * fraction);
  for (let i = 1; i <= steps; i++) {
    const idx = Math.min(last, Math.round((i / steps) * last));
    const [lng, lat] = points[idx];
    await send(PERSONA[AMB], {
      eventType: 'ambulance.location.updated',
      source: { type: 'ambulance', id: AMB },
      payload: { ambulanceId: AMB, coordinates: { latitude: lat, longitude: lng }, speedKmh: 42, heading: 180 },
    });
    await sleep(STEP / 2);
  }
}

async function main() {
  try {
    await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(2000) });
  } catch {
    console.error(`\n❌ JIVA API not reachable at ${API}. Start the stack first:  npm run dev\n`);
    process.exit(1);
  }
  const t0 = Date.now();
  const step = (label: string) => console.log(`[T+${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

  await call(PERSONA.admin, 'POST', '/api/demo/reset');
  step('Demo state reset (synthetic Bengaluru dataset re-seeded)');
  await sleep(STEP);

  await send(PERSONA.dispatch, {
    eventType: 'patient.emergency.created',
    source: { type: 'system', id: 'dispatch-blr-108' },
    patientId: CASE,
    payload: { condition: 'Severe polytrauma (road traffic accident)', location: { latitude: 13.0431, longitude: 77.5891 }, severity: 'CRITICAL' },
    metadata: { confidence: 1.0, sourceType: 'SYNTHETIC_DEMO' },
  });
  step('Emergency reported → assessment → care requirement → candidates → acceptance requests');

  const requested = await waitFor('acceptance requests', async () => {
    const reqs = await call(PERSONA[HOSP_A], 'GET', `/api/hospitals/${HOSP_A}/requests`);
    return reqs.length ? reqs : undefined;
  });
  step(`Acceptance request received by ${HOSP_A} (ETA ${requested[0].ambulanceEtaMinutes} min)`);
  await sleep(STEP);

  await send(PERSONA.dispatch, {
    eventType: 'ambulance.dispatched',
    source: { type: 'system', id: 'dispatch-blr-108' },
    payload: { ambulanceId: AMB, caseId: CASE, destination: { latitude: 13.0431, longitude: 77.5891 }, estimatedEtaMinutes: 8 },
  });
  step(`${AMB} dispatched`);
  await sleep(STEP);

  await respond(HOSP_A, 'ACCEPTED');
  const first = await waitFor('initial destination = Hospital A', async () => {
    const a = await ambulance();
    return a?.destinationHospital === HOSP_A && a.activeRoute ? a : undefined;
  });
  step(`Hospital A ${HOSP_A} ACCEPTED → destination A, route ${(first.activeRoute.distanceMeters / 1000).toFixed(1)} km via ${first.activeRoute.provider}${first.activeRoute.synthetic ? ' (SYNTHETIC)' : ''}`);
  await sleep(STEP);

  await respond(HOSP_B, 'ACCEPTED');
  await respond(HOSP_C, 'LIMITED', ['ICU bed unavailable; surgical stabilisation only']);
  await sleep(500);
  if ((await ambulance())?.destinationHospital !== HOSP_A) throw new Error('Destination changed without cause');
  step(`Hospital B ${HOSP_B} ACCEPTED, ${HOSP_C} LIMITED — destination stays A (responses coexist)`);
  await sleep(STEP);

  await drive(first.activeRoute.coordinates, 3, 0.5); // partway: still en route to A
  step('Ambulance telemetry streaming (no route recalculation on GPS)');

  await send(PERSONA[HOSP_A], {
    eventType: 'hospital.capacity.updated',
    source: { type: 'hospital', id: HOSP_A },
    payload: { hospitalId: HOSP_A, emergencyStatus: 'UNAVAILABLE', traumaStatus: 'UNAVAILABLE', icuStatus: 'UNAVAILABLE', ventilatorStatus: 'UNKNOWN' },
    metadata: { confidence: 1.0, sourceType: 'SYNTHETIC_DEMO' },
  });
  step(`Hospital A ${HOSP_A} reports emergency department UNAVAILABLE`);

  const rerouted = await waitFor('reroute to Hospital B', async () => {
    const a = await ambulance();
    return a?.destinationHospital === HOSP_B && a.activeRoute?.hospitalId === HOSP_B ? a : undefined;
  });
  step(`REROUTED → ${HOSP_B}: ${(rerouted.activeRoute.distanceMeters / 1000).toFixed(1)} km, ETA ${Math.ceil(rerouted.activeRoute.durationSeconds / 60)} min`);
  await sleep(STEP);

  await drive(rerouted.activeRoute.coordinates, 4);
  await waitFor('arrival at Hospital B', async () => ((await ambulance())?.status === 'ARRIVED' ? true : undefined));
  step(`Arrived at ${HOSP_B}`);

  const hA = await hospital(HOSP_A);
  step(`Final: A emergency=${hA.operationalState.emergency}; B acceptance=${(await hospital(HOSP_B)).operationalState.acceptance}`);
  const ai = await waitFor('AI summary', async () => {
    const hist = await call(PERSONA.dispatch, 'GET', '/api/events/history?limit=500');
    return hist.some((e: any) => e.eventType === 'ai.summary.generated') ? hist.filter((e: any) => e.eventType.startsWith('ai.')) : undefined;
  }, 8000).catch(() => []);
  step(`AI sidecar events: ${ai.map((e: any) => e.eventType).join(', ') || 'none (AI is optional)'}`);
  const unexpected = await reportShadowDisagreements(API);
  if (unexpected > 0) {
    console.error(`\n✗ FLAGSHIP INVARIANT VIOLATED: ${unexpected} unexpected shadow disagreement(s) (expected 0).`);
    process.exit(1);
  }
  console.log(`\n✓ SCENARIO COMPLETE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(err => {
  console.error(`\n✗ SCENARIO FAILED: ${err.message}`);
  process.exit(1);
});
