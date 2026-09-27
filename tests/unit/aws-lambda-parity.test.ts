/**
 * D8 — AWS lambda cores vs the LOCAL state engines, driven by IDENTICAL event scripts.
 *
 *  local: the real in-process state engines (stateEngines.ts) on the local bus + local stores
 *  AWS:   createEmergencyHandler / createHospitalHandler / createAmbulanceHandler over a store double,
 *         wired through a mini EventBridge that uses the same rules as the CDK stack
 *
 * After each script the two sides must agree on: hospital operational state, ambulance/patient
 * state, every system event that carries a decision, and the feasibility shadow's verdicts.
 * (The lambdas were NOT exercised against real DynamoDB/EventBridge — see docs.)
 */
process.env.MAPPING_PROVIDER = 'mock';
process.env.ACCEPTANCE_EXPIRY_CHECK_MS = '3600000';

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { AnyEvent } from '../../packages/event-schema/src';
import { AnyEventSchema } from '../../packages/event-schema/src';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { createStoreBackedShadow } from '../../services/api/src/lambdas/core/deps';
import { createEmergencyHandler } from '../../services/api/src/lambdas/core/emergencyCore';
import { createHospitalHandler } from '../../services/api/src/lambdas/core/hospitalCore';
import { createAmbulanceHandler } from '../../services/api/src/lambdas/core/ambulanceCore';
import { check, eq, EventRouter, ok, passCount } from './helpers/feasibilityHarness';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const HEBBAL = { latitude: 13.0431, longitude: 77.5891 };
const iso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();
const mk = (eventType: string, source: { type: string; id: string }, payload: unknown, extra: object = {}, offsetSec = 0) =>
  ({ eventId: randomUUID(), eventType, timestamp: iso(offsetSec), version: '1.0', source, payload, ...extra }) as unknown as AnyEvent;

const emergency = (caseId: string, condition = 'Severe polytrauma', severity = 'CRITICAL') =>
  mk('patient.emergency.created', { type: 'system', id: 'dispatch' }, { condition, location: HEBBAL, severity }, { patientId: caseId });
const dispatch = (ambulanceId: string, caseId: string) =>
  mk('ambulance.dispatched', { type: 'system', id: 'dispatch' }, { ambulanceId, caseId, destination: HEBBAL, estimatedEtaMinutes: 8 });
const respond = (caseId: string, hospitalId: string, status: string, o: { responseId?: string; respondedSec?: number; validSec?: number; caps?: string[]; limitations?: string[] } = {}) =>
  mk('hospital.acceptance.received', { type: 'hospital', id: hospitalId }, {
    responseId: o.responseId || `R-${randomUUID().slice(0, 8)}`, requestId: '@LATEST', caseId, hospitalId, status,
    acceptedCapabilities: o.caps ?? (status === 'REJECTED' || status === 'UNAVAILABLE' ? [] : ['EMERGENCY', 'TRAUMA', 'ICU']),
    limitations: o.limitations ?? [], respondedAt: iso(o.respondedSec ?? 0), validUntil: iso(o.validSec ?? 1800),
    responderRole: 'CLINICAL_COORDINATOR', source: 'SYNTHETIC_DEMO',
  }, { metadata: { sourceType: 'test', trustedEvidence: { status: 'SYNTHETIC_DEMO', environment: 'DEMO' } } }, o.respondedSec ?? 0);
const capacity = (hospitalId: string, s: { e?: string; t?: string; i?: string; v?: string }, offsetSec = 0) =>
  mk('hospital.capacity.updated', { type: 'hospital', id: hospitalId },
    { hospitalId, emergencyStatus: s.e ?? 'AVAILABLE', traumaStatus: s.t ?? 'AVAILABLE', icuStatus: s.i ?? 'AVAILABLE', ventilatorStatus: s.v ?? 'AVAILABLE' },
    { metadata: { confidence: 1, sourceType: 'SYNTHETIC_DEMO', trustedEvidence: { status: 'SYNTHETIC_DEMO', environment: 'DEMO' } } }, offsetSec);
const requirementEvent = (caseId: string, caps: string[]) =>
  mk('care.requirement.created', { type: 'system', id: 'assessment-engine' }, {
    requirementId: `REQ-${randomUUID().slice(0, 8)}`, caseId, requiredCapabilities: caps, optionalCapabilities: [], severity: 'CRITICAL', createdAt: iso(),
  });

/** Events are built lazily so each is stamped when it is SENT (stores enforce out-of-order guards). */
interface Step { name: string; event: () => AnyEvent }
interface Transcript {
  hospitals: Record<string, unknown>;
  ambulances: Record<string, unknown>;
  patients: Record<string, unknown>;
  decisions: unknown[];
  shadow: string[];
  traceEvents: unknown[];
}

// ------------------------------------------------------------------ transcript normalisation

const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map(k => [k, o?.[k]]));

function normDecisions(events: AnyEvent[]) {
  const out: unknown[] = [];
  for (const e of events as any[]) {
    const p = e.payload;
    switch (e.eventType) {
      case 'care.requirement.created': out.push(['requirement', p.caseId, p.requiredCapabilities, p.severity]); break;
      case 'hospital.candidate.generated':
        out.push(['candidates', p.caseId, p.candidates.map((c: any) => [c.hospitalId, c.operationalEligibility, c.missingCapabilities, c.capabilityMatch])]); break;
      case 'hospital.acceptance.requested': out.push(['requested', p.caseId, p.hospitalId, p.requiredCapabilities]); break;
      case 'destination.changed': out.push(['destination', p.ambulanceId, p.hospitalId, p.reason]); break;
      case 'route.recalculated': out.push(['route', p.ambulanceId, p.oldHospitalId, p.newHospitalId, p.reason]); break;
    }
  }
  return out;
}

const traceSummary = (t: any) =>
  `${t.trigger.eventType}|${t.outcome}|${t.selectedHospitalId || '-'}|` +
  t.candidates.map((c: any) => `${c.hospitalId}:${c.verdict}:${c.blockingReasons.join('+')}:${c.rankOrder}`).join(',');

const normTraceEvent = (e: any) => ({
  context: e.payload.context, outcome: e.payload.outcome, selected: e.payload.selectedHospitalId, mode: e.payload.mode, authority: e.payload.authority,
  candidates: e.payload.candidates.map((c: any) => [c.hospitalId, c.verdict, c.orderPosition, c.constraints.map((k: any) => `${k.ruleId}=${k.outcome}/${k.reasonCode}`)]),
});

const hospitalView = (h: any) => pick(h.operationalState, ['emergency', 'icu', 'trauma', 'ventilator', 'acceptance', 'acceptanceCaseId', 'acceptanceAsOf', 'expiresAt', 'capacityAsOf', 'lastConfirmedAt', 'source']);
const ambulanceView = (a: any) => ({ status: a.status, destination: a.destinationHospital, route: a.activeRoute?.hospitalId, patient: a.assignedPatient });
const patientView = (p: any) => pick(p, ['currentStatus', 'assignedHospital', 'assignedAmbulance', 'careRequirements']);

async function main() {
  console.log('[Test] AWS lambda cores vs local state engines (identical event scripts)\n');

  // ---------------------------------------------------------------- local side (real engines)
  const { eventBus } = await import('../../services/api/src/eventBus');
  const engines = await import('../../services/api/src/stateEngines');
  const stores = await import('../../services/api/src/stateStore');
  const { feasibilityShadow } = await import('../../services/api/src/feasibility');
  const { mappingProvider } = await import('../../services/api/src/mapping');
  await stores.preloadData();
  engines.initializeStateEngines();

  let localLog: AnyEvent[] = [];
  eventBus.on('*', (e: AnyEvent) => { localLog.push(e); });

  const settleLocal = async () => {
    let last = -1;
    let stable = 0;
    while (stable < 4) {
      await sleep(40);
      stable = localLog.length === last ? stable + 1 : 0;
      last = localLog.length;
    }
  };

  // ---------------------------------------------------------------- AWS side
  const RULES = {
    emergency: ['patient.emergency.created', 'care.requirement.created'],
    hospital: ['hospital.acceptance.requested', 'hospital.acceptance.received', 'hospital.capacity.updated', 'hospital.acceptance.expired', 'hospital.acceptance.cancelled'],
    ambulance: ['ambulance.dispatched', 'ambulance.location.updated'],
  };

  async function awsSide() {
    const store = new LocalStateStore();
    await store.preloadData();
    const holder: { router?: EventRouter } = {};
    const deps: any = { store, mapping: mappingProvider };
    const emergencyH = createEmergencyHandler(deps);
    const hospitalH = createHospitalHandler(deps);
    const ambulanceH = createAmbulanceHandler(deps);
    const router = new EventRouter([
      { target: 'emergency', detailTypes: RULES.emergency, handler: emergencyH },
      { target: 'hospital', detailTypes: RULES.hospital, handler: hospitalH },
      { target: 'ambulance', detailTypes: RULES.ambulance, handler: ambulanceH },
    ]);
    holder.router = router;
    deps.bus = router.bus;
    deps.shadow = createStoreBackedShadow({ store, bus: router.bus, mapping: mappingProvider, log: () => undefined });
    return { store, router, shadow: deps.shadow as ReturnType<typeof createStoreBackedShadow> };
  }

  async function runBoth(label: string, build: () => Step[], mappingPatch?: (dest: string) => boolean) {
    // fresh state on both sides
    engines.resetEngines();
    await stores.localStoreInstance.reset();
    localLog = [];
    const aws = await awsSide();
    const steps = build();
    const sent: AnyEvent[] = [];
    const realRoute = mappingProvider.calculateRoute.bind(mappingProvider);
    if (mappingPatch) {
      (mappingProvider as any).calculateRoute = async (req: any) => {
        if (mappingPatch(`${req.destination.latitude},${req.destination.longitude}`)) throw new Error('provider down');
        return realRoute(req);
      };
    }
    try {
      // A response must name the request it answers. Request ids are generated per side, so scripts
      // write '@LATEST' and each side resolves it against ITS OWN latest request for (case, hospital).
      const resolve = (e: AnyEvent, log: AnyEvent[]): AnyEvent => {
        const p = (e as any).payload;
        if (e.eventType !== 'hospital.acceptance.received' || p.requestId !== '@LATEST') return JSON.parse(JSON.stringify(e));
        const req = [...log].reverse().find((x: any) => x.eventType === 'hospital.acceptance.requested' && x.payload.caseId === p.caseId && x.payload.hospitalId === p.hospitalId) as any;
        return JSON.parse(JSON.stringify({ ...e, payload: { ...p, requestId: req?.payload.requestId ?? 'AR-none' } }));
      };
      for (const s of steps) {
        const event = s.event(); // stamped now, after the previous step's side effects
        sent.push(event);
        await eventBus.publish(resolve(event, localLog));
        await settleLocal();
        await aws.router.send(resolve(event, aws.router.bus.published));
      }
      await settleLocal();
    } finally {
      (mappingProvider as any).calculateRoute = realRoute;
    }

    const inputIds = new Set(sent.map(e => e.eventId));
    const local: Transcript = {
      hospitals: Object.fromEntries([...stores.hospitalsStore.entries()].map(([k, v]) => [k, hospitalView(v)])),
      ambulances: Object.fromEntries([...stores.ambulancesStore.entries()].map(([k, v]) => [k, ambulanceView(v)])),
      patients: Object.fromEntries([...stores.patientsStore.entries()].map(([k, v]) => [k, patientView(v)])),
      decisions: normDecisions(localLog.filter(e => !inputIds.has(e.eventId))),
      shadow: feasibilityShadow.getTraces().map(traceSummary).sort(),
      traceEvents: localLog.filter(e => e.eventType === 'feasibility.trace.recorded').map(normTraceEvent),
    };
    const awsT: Transcript = {
      hospitals: Object.fromEntries((await aws.store.listHospitals()).map(h => [h.hospitalId, hospitalView(h)])),
      ambulances: Object.fromEntries((await aws.store.listAmbulances()).map(a => [a.ambulanceId, ambulanceView(a)])),
      patients: Object.fromEntries((await aws.store.listPatients()).map(p => [p.patientId, patientView(p)])),
      decisions: normDecisions(aws.router.bus.published.filter(e => !inputIds.has(e.eventId))),
      shadow: aws.shadow.getTraces().map(traceSummary).sort(),
      traceEvents: aws.router.bus.published.filter(e => e.eventType === 'feasibility.trace.recorded').map(normTraceEvent),
    };
    // unique decision events only (local: stateEngines publishes each once; AWS: same)
    eq(awsT.hospitals, local.hospitals, `${label}: hospital operational state`);
    eq(awsT.ambulances, local.ambulances, `${label}: ambulance state`);
    eq(awsT.patients, local.patients, `${label}: patient state`);
    eq(awsT.decisions, local.decisions, `${label}: decision events (candidates, requests, destinations, routes)`);
    eq(awsT.shadow, local.shadow, `${label}: feasibility shadow verdicts`);
    eq(awsT.traceEvents.length, awsT.shadow.length, `${label}: one trace event per evaluation (AWS)`);
    eq(local.traceEvents.length, local.shadow.length, `${label}: one trace event per evaluation (local)`);
    eq([...awsT.traceEvents].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1), [...local.traceEvents].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1), `${label}: trace event content`);
    for (const d of aws.router.deliveries) ok(d.eventType !== 'feasibility.trace.recorded', `${label}: trace event must have no consumer`);
    return { local, aws: awsT, awsCtx: aws };
  }

  const roles = (t: Transcript) => ({ hospitals: t.hospitals as Record<string, any>, ambulances: t.ambulances as Record<string, any> });

  // ---------------------------------------------------------------- S1 flagship-like
  await check('S1 flagship shape: emergency -> requests -> accept -> LIMITED(no ICU) -> reroute on UNAVAILABLE (identical on both sides)', async () => {
    const c = 'CASE-S1';
    const r = await runBoth('S1', () => [
      { name: 'emergency', event: () => emergency(c) },
      { name: 'dispatch', event: () => dispatch('AMB-BLR-001', c) },
      { name: '001 accepts', event: () => respond(c, 'HOSP-BLR-001', 'ACCEPTED') },
      { name: '004 accepts', event: () => respond(c, 'HOSP-BLR-004', 'ACCEPTED') },
      { name: '002 limited (no ICU)', event: () => respond(c, 'HOSP-BLR-002', 'LIMITED', { caps: ['EMERGENCY', 'TRAUMA'], limitations: ['ICU capacity limited'] }) },
      { name: '001 loses ED', event: () => capacity('HOSP-BLR-001', { e: 'UNAVAILABLE', t: 'UNAVAILABLE', i: 'UNAVAILABLE' }) },
    ]);
    eq(roles(r.aws).ambulances['AMB-BLR-001'].destination, 'HOSP-BLR-004', 'rerouted to B on both sides');
    ok(r.aws.decisions.some((d: any) => d[0] === 'requested' && d[2] === 'HOSP-BLR-004'), 'requests issued');
    ok(!r.aws.decisions.some((d: any) => d[0] === 'requested' && d[2] === 'HOSP-BLR-003'), 'incapable hospital never asked');
  });

  // ---------------------------------------------------------------- S2 D8 acceptance semantics
  await check('S2 D8: duplicate responseId / stale / already-expired / stale capacity behave identically', async () => {
    const c = 'CASE-S2';
    const r = await runBoth('S2', () => {
      let first: AnyEvent;
      return [
      { name: 'emergency', event: () => emergency(c) },
      { name: 'accept', event: () => (first = respond(c, 'HOSP-BLR-001', 'ACCEPTED', { responseId: 'R-DUP', respondedSec: -30 })) },
      { name: 'duplicate responseId (new eventId)', event: () => ({ ...JSON.parse(JSON.stringify(first)), eventId: randomUUID() }) as AnyEvent }, // redelivery
      { name: 'older REJECTED (stale)', event: () => respond(c, 'HOSP-BLR-001', 'REJECTED', { respondedSec: -120 }) },
      { name: 'expired on arrival', event: () => respond(c, 'HOSP-BLR-004', 'ACCEPTED', { respondedSec: -20, validSec: -5 }) },
      { name: 'capacity now', event: () => capacity('HOSP-BLR-002', { e: 'UNAVAILABLE' }, -10) },
      { name: 'older capacity (stale)', event: () => capacity('HOSP-BLR-002', { e: 'AVAILABLE' }, -60) },
      { name: 'newer REJECTED applies', event: () => respond(c, 'HOSP-BLR-001', 'REJECTED', { respondedSec: -1 }) },
      ];
    });
    const h = roles(r.aws).hospitals;
    eq(h['HOSP-BLR-001'].acceptance, 'REJECTED', 'newest response applied');
    eq(h['HOSP-BLR-004'].acceptance, 'UNKNOWN', 'expired-on-arrival response never applied');
    eq(h['HOSP-BLR-002'].emergency, 'UNAVAILABLE', 'stale capacity did not overwrite');
  });

  // ---------------------------------------------------------------- S3 multi-case (D5) -- FIXED: the
  // legacy DECISION path is now case-scoped. The shared slot (acceptanceCaseId) still exists for
  // backward compatibility (existing UI/consumers read it as "who last answered"), but destination
  // SELECTION no longer consults it: it reads the per-(case, hospital) acceptance index instead, so
  // case B's acceptance at a hospital can never take away case A's own destination there.
  await check('S3 D5 FIXED: two simultaneous cases accept at the SAME hospital -- both remain independently accepted and both are correctly routed there (identical on local and AWS)', async () => {
    const a = 'CASE-S3A';
    const b = 'CASE-S3B';
    const r = await runBoth('S3', () => [
      { name: 'emergency A', event: () => emergency(a) },
      { name: 'emergency B', event: () => emergency(b) },
      { name: '001 accepts A', event: () => respond(a, 'HOSP-BLR-001', 'ACCEPTED') },
      { name: '001 accepts B', event: () => respond(b, 'HOSP-BLR-001', 'ACCEPTED') },
      { name: 'dispatch to A', event: () => dispatch('AMB-BLR-002', a) },
      { name: 'dispatch to B', event: () => dispatch('AMB-BLR-003', b) },
    ]);
    eq(roles(r.aws).hospitals['HOSP-BLR-001'].acceptanceCaseId, b, 'the legacy SLOT still shows the last writer (kept for backward compatibility)');
    eq(roles(r.aws).ambulances['AMB-BLR-002'].destination, 'HOSP-BLR-001', 'FIX: A is still routed to 001 even though B answered after A');
    eq(roles(r.aws).ambulances['AMB-BLR-003'].destination, 'HOSP-BLR-001', 'B is independently routed to 001 too');
    eq(roles(r.local).ambulances['AMB-BLR-002'].destination, 'HOSP-BLR-001', 'identical on local');
    eq(roles(r.local).ambulances['AMB-BLR-003'].destination, 'HOSP-BLR-001', 'identical on local');
    ok(!r.awsCtx.shadow.getDisagreements(a).some((d: any) => d.kind === 'SELECTION'), 'no more selection disagreement for A: legacy now agrees with the engine');
    ok(!feasibilityShadow.getDisagreements(a).some(d => d.kind === 'SELECTION'), 'and identically in local shadow');
  });

  await check('S3b: case B REJECTS 001 and reroutes; case A, independently accepted at 001, is completely unaffected', async () => {
    const a = 'CASE-S3Ba';
    const b = 'CASE-S3Bb';
    const r = await runBoth('S3b', () => [
      { name: 'emergency A', event: () => emergency(a) },
      { name: 'emergency B', event: () => emergency(b) },
      { name: 'dispatch to A', event: () => dispatch('AMB-BLR-002', a) },
      { name: 'dispatch to B', event: () => dispatch('AMB-BLR-003', b) },
      { name: '001 accepts A', event: () => respond(a, 'HOSP-BLR-001', 'ACCEPTED') },
      { name: '001 accepts B', event: () => respond(b, 'HOSP-BLR-001', 'ACCEPTED') },
      { name: '004 accepts B (fallback)', event: () => respond(b, 'HOSP-BLR-004', 'ACCEPTED') },
      { name: 'B rerouted: 001 REJECTS B', event: () => respond(b, 'HOSP-BLR-001', 'REJECTED') },
    ]);
    eq(roles(r.aws).ambulances['AMB-BLR-002'].destination, 'HOSP-BLR-001', 'A: unaffected by B being rejected at the same hospital');
    eq(roles(r.aws).ambulances['AMB-BLR-003'].destination, 'HOSP-BLR-004', 'B: independently rerouted to 004');
    eq(roles(r.local).ambulances['AMB-BLR-002'].destination, 'HOSP-BLR-001', 'identical on local');
    eq(roles(r.local).ambulances['AMB-BLR-003'].destination, 'HOSP-BLR-004', 'identical on local');
  });

  await check('S3c: out-of-order, duplicate and stale responses for case A do not disturb case A (or B)\'s case-scoped acceptance', async () => {
    const a = 'CASE-S3Ca';
    const b = 'CASE-S3Cb';
    const dupId = `R-${randomUUID().slice(0, 8)}`;
    const r = await runBoth('S3c', () => [
      { name: 'emergency A', event: () => emergency(a) },
      { name: 'emergency B', event: () => emergency(b) },
      { name: 'dispatch to A', event: () => dispatch('AMB-BLR-002', a) },
      { name: 'dispatch to B', event: () => dispatch('AMB-BLR-003', b) },
      { name: '001 accepts B first', event: () => respond(b, 'HOSP-BLR-001', 'ACCEPTED', { respondedSec: -5 }) },
      { name: 'A accepted (recorded)', event: () => respond(a, 'HOSP-BLR-001', 'ACCEPTED', { responseId: dupId, respondedSec: -3 }) },
      { name: 'duplicate redelivery of A acceptance (same responseId)', event: () => respond(a, 'HOSP-BLR-001', 'ACCEPTED', { responseId: dupId, respondedSec: -3 }) },
      { name: 'stale REJECTED for A (older than the ACCEPTED already applied)', event: () => respond(a, 'HOSP-BLR-001', 'REJECTED', { respondedSec: -10 }) },
    ]);
    eq(roles(r.aws).ambulances['AMB-BLR-002'].destination, 'HOSP-BLR-001', 'A: still correctly accepted despite duplicate/stale/out-of-order responses');
    eq(roles(r.aws).ambulances['AMB-BLR-003'].destination, 'HOSP-BLR-001', 'B: independently accepted, unaffected by A response traffic');
    eq(roles(r.local).ambulances['AMB-BLR-002'].destination, 'HOSP-BLR-001', 'identical on local');
    eq(roles(r.local).ambulances['AMB-BLR-003'].destination, 'HOSP-BLR-001', 'identical on local');
  });

  // ---------------------------------------------------------------- S4 unit availability (D3)
  await check('S4 D3: fresh ICU UNAVAILABLE -> engine INELIGIBLE (identical on both sides); legacy behaviour unchanged', async () => {
    const c = 'CASE-S4';
    const r = await runBoth('S4', () => [
      { name: 'emergency', event: () => emergency(c) },
      { name: '004 ICU down', event: () => capacity('HOSP-BLR-004', { i: 'UNAVAILABLE' }, -5) },
      { name: '001 accepts', event: () => respond(c, 'HOSP-BLR-001', 'ACCEPTED') },
      { name: '004 accepts', event: () => respond(c, 'HOSP-BLR-004', 'ACCEPTED') },
      { name: 'dispatch', event: () => dispatch('AMB-BLR-003', c) },
    ]);
    const sel = r.awsCtx.shadow.getTraces(c).filter((t: any) => t.trigger.eventType === 'destination.selection').pop()!;
    const c4 = sel.candidates.find((x: any) => x.hospitalId === 'HOSP-BLR-004')!;
    eq([c4.verdict, c4.blockingReasons], ['INELIGIBLE', ['OPERATIONAL_UNAVAILABLE']], 'engine blocks the ICU-down hospital');
    eq(sel.selectedHospitalId, 'HOSP-BLR-001', 'engine selection');
  });

  // ---------------------------------------------------------------- S5 unknown capability (D2)
  await check('S5 D2: unlisted capability -> INDETERMINATE in the engine; legacy (frozen) keeps not-asking; identical on both sides', async () => {
    const c = 'CASE-S5';
    const r = await runBoth('S5', () => [{ name: 'requirement (MRI)', event: () => requirementEvent(c, ['EMERGENCY', 'MRI']) }]);
    ok(!r.aws.decisions.some((d: any) => d[0] === 'requested'), 'nobody is asked (INDETERMINATE and legacy-missing are both non-requestable, A1)');
    const t = r.awsCtx.shadow.getTraces(c)[0];
    eq(t.candidates.every((x: any) => x.verdict === 'INDETERMINATE' || x.verdict === 'INELIGIBLE'), true, 'no hospital is ELIGIBLE/PENDING');
    ok(t.candidates.some((x: any) => x.verdict === 'INDETERMINATE'), 'INDETERMINATE preserved internally (not collapsed into INELIGIBLE)');
  });

  // ---------------------------------------------------------------- S6 failed route (D1)
  await check('S6 D1: failed route -> unknown ETA in the engine, never chosen as "closest"; identical on both sides', async () => {
    const c = 'CASE-S6';
    const h1 = stores.hospitalsStore.get('HOSP-BLR-001')!.location!;
    const failKey = `${h1.latitude},${h1.longitude}`;
    const r = await runBoth('S6', () => [
      { name: 'emergency', event: () => emergency(c) },
      { name: '001 accepts', event: () => respond(c, 'HOSP-BLR-001', 'ACCEPTED') },
      { name: '004 accepts', event: () => respond(c, 'HOSP-BLR-004', 'ACCEPTED') },
      { name: 'dispatch', event: () => dispatch('AMB-BLR-001', c) },
    ], dest => dest === failKey);
    const sel = r.awsCtx.shadow.getTraces(c).filter((t: any) => t.trigger.eventType === 'destination.selection').pop()!;
    const c1 = sel.candidates.find((x: any) => x.hospitalId === 'HOSP-BLR-001')!;
    eq([c1.transit.etaMinutes, c1.transit.etaStatus], [null, 'UNKNOWN'], 'ETA unknown, not 0');
    eq(sel.selectedHospitalId, 'HOSP-BLR-004', 'engine does not treat the unroutable hospital as closest');
  });

  // ---------------------------------------------------------------- dispatch semantics
  await check('AWS dispatch: a new dispatch never carries over the previous case destination; acceptance-before-dispatch assigns a destination', async () => {
    const c1 = 'CASE-D1';
    const c2 = 'CASE-D2';
    const r = await runBoth('dispatch', () => [
      { name: 'emergency 1', event: () => emergency(c1) },
      { name: 'accept 1', event: () => respond(c1, 'HOSP-BLR-001', 'ACCEPTED') },
      { name: 'dispatch 1 (acceptance already exists)', event: () => dispatch('AMB-BLR-001', c1) },
      { name: 'emergency 2', event: () => emergency(c2) },
      { name: 'redispatch to case 2', event: () => dispatch('AMB-BLR-001', c2) },
    ]);
    eq(roles(r.aws).ambulances['AMB-BLR-001'].patient, c2, 'reassigned');
    eq(roles(r.aws).ambulances['AMB-BLR-001'].destination, undefined, 'previous destination not carried over (case 2 has no acceptance yet)');
  });

  // ---------------------------------------------------------------- AWS-only structural checks
  await check('AWS handlers are idempotent by eventId and skip unknown hospitals', async () => {
    const aws = await awsSide();
    const ev = emergency('CASE-IDEM');
    await aws.router.send(ev);
    const before = aws.router.bus.published.length;
    const res = await createEmergencyHandler({ store: aws.store, bus: aws.router.bus, mapping: mappingProvider })({ detail: JSON.parse(JSON.stringify(ev)) });
    eq(res, { status: 'duplicate_skipped' }, 'duplicate skipped');
    eq(aws.router.bus.published.length, before, 'no re-publication');
    const unknown = await createHospitalHandler({ store: aws.store, bus: aws.router.bus, mapping: mappingProvider })({ detail: JSON.parse(JSON.stringify(respond('CASE-IDEM', 'HOSP-NOPE', 'ACCEPTED'))) });
    eq(unknown, { status: 'unknown_hospital' }, 'unknown hospital');
  });

  await check('AWS trace events are recorded in the audit history and never routed to a processor', async () => {
    const aws = await awsSide();
    await aws.router.send(emergency('CASE-AUD'));
    const traceEvents = aws.router.bus.ofType('feasibility.trace.recorded');
    ok(traceEvents.length >= 1, 'emitted');
    const history = await aws.store.queryEventsByCase('CASE-AUD');
    for (const t of traceEvents) ok(history.some(h => h.eventId === t.eventId), 'recorded in history');
    ok(aws.router.deliveries.every(d => d.eventType !== 'feasibility.trace.recorded'), 'no consumer');
    for (const t of traceEvents) ok(AnyEventSchema.safeParse(t).success, 'valid against the canonical event schema');
  });

  await check('router rules mirror the CDK stack (drift guard) and the trace event is excluded from realtime broadcast', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../infrastructure/aws/lib/aws-stack.ts'), 'utf8');
    const rule = (name: string) => {
      const m = src.match(new RegExp(`'${name}'[\\s\\S]*?detailType:\\s*\\[([^\\]]*)\\]`));
      return m ? m[1].split(',').map(x => x.trim().replace(/['"]/g, '')).filter(Boolean) : [];
    };
    eq(rule('EmergencyEventsRule'), RULES.emergency, 'emergency rule');
    eq(rule('HospitalEventsRule'), RULES.hospital, 'hospital rule');
    eq(rule('AmbulanceEventsRule'), RULES.ambulance, 'ambulance rule');
    ok(/RealtimeBroadcastRule[\s\S]*?anythingBut\('feasibility\.trace\.recorded'\)/.test(src), 'broadcast rule excludes the trace event');
    ok(!/detailType:\s*\[[^\]]*feasibility\.trace\.recorded/.test(src), 'no rule lists the trace event as a target detail type');
  });

  console.log(`\n[Test] AWS lambda cores vs local engines: ${passCount()} checks passed.`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
