/**
 * Blockers 1, 2, 9 (flow wiring) and 10 (AWS): the LEGACY decision flow must complete, with an
 * identical result, no matter what the auxiliary observation does (feasibility shadow, acceptance
 * ledger, trace generation/publishing, evidence/history reconstruction).
 *
 *   legacy decision flow ──► completes on its own
 *          └──► independent observation ──► failure is isolated
 *
 * Method: the same scripted events run through the REAL local state engines and the REAL AWS
 * lambda cores once per variant. Each variant makes one auxiliary component throw / reject / hang /
 * time out (or feeds it poison). The legacy transcript (hospital/ambulance/patient state and the
 * decision events) must equal the transcript of the same script with the shadow OFF.
 */
process.env.MAPPING_PROVIDER = 'mock';
process.env.ACCEPTANCE_EXPIRY_CHECK_MS = '3600000';
import { randomUUID } from 'crypto';
import type { AnyEvent } from '../../packages/event-schema/src';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { createStoreBackedShadow } from '../../services/api/src/lambdas/core/deps';
import { createEmergencyHandler } from '../../services/api/src/lambdas/core/emergencyCore';
import { createHospitalHandler } from '../../services/api/src/lambdas/core/hospitalCore';
import { createAmbulanceHandler } from '../../services/api/src/lambdas/core/ambulanceCore';
import { auxiliaryFailureCount, resetAuxiliaryFailures } from '../../services/api/src/feasibility/containment';
import { check, eq, EventRouter, ok, passCount } from './helpers/feasibilityHarness';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const HEBBAL = { latitude: 13.0431, longitude: 77.5891 };
const iso = (offsetSec = 0) => new Date(Date.now() + offsetSec * 1000).toISOString();
const STAMP = { metadata: { sourceType: 'test', trustedEvidence: { status: 'SYNTHETIC_DEMO', environment: 'DEMO' } } };
const mk = (eventType: string, source: { type: string; id: string }, payload: unknown, extra: object = {}) =>
  ({ eventId: randomUUID(), eventType, timestamp: iso(), version: '1.0', source, payload, ...extra }) as unknown as AnyEvent;

// ------------------------------------------------------------------ the scripted legacy scenario
interface Step { name: string; event: () => AnyEvent }
function script(o: { malformedResponses?: boolean; garbage?: boolean; withCancel?: boolean } = {}): Step[] {
  const c1 = 'CASE-CT1', c2 = 'CASE-CT2';
  const emergency = (c: string, condition: string, severity: string) =>
    ({ name: `emergency ${c}`, event: () => mk('patient.emergency.created', { type: 'system', id: 'dispatch' }, { condition, location: HEBBAL, severity }, { patientId: c }) });
  const respond = (name: string, c: string, h: string, status: string, caps?: string[]): Step => ({
    name,
    event: () => {
      const payload: Record<string, unknown> = {
        responseId: `R-${randomUUID().slice(0, 8)}`, requestId: '@LATEST', caseId: c, hospitalId: h, status,
        acceptedCapabilities: caps ?? (status === 'REJECTED' ? [] : ['EMERGENCY', 'TRAUMA', 'ICU']), limitations: [],
        respondedAt: iso(), validUntil: iso(1800), responderRole: 'C', source: 'SYNTHETIC_DEMO',
      };
      // legacy never reads these arrays; the old ledger threw on a payload without them
      if (o.malformedResponses) { delete payload.acceptedCapabilities; delete payload.limitations; }
      return mk('hospital.acceptance.received', { type: 'hospital', id: h }, payload, STAMP);
    },
  });
  const extra: Step[] = [];
  if (o.garbage) {
    // malformed evidence straight onto the bus (no schema gate): wrong types, impossible dates, unknown status
    extra.push({ name: 'garbage response', event: () => mk('hospital.acceptance.received', { type: 'hospital', id: 'HOSP-BLR-003' }, { responseId: 7, requestId: 5, caseId: c1, hospitalId: 'HOSP-BLR-003', status: 'MAYBE', respondedAt: 'nonsense', validUntil: null, limitations: 'x' }, STAMP) });
  }
  if (o.withCancel) {
    extra.push({ name: 'cancel 002 request', event: () => mk('hospital.acceptance.cancelled', { type: 'system', id: 'acceptance-protocol' }, { requestId: '@LATEST', caseId: c1, hospitalId: 'HOSP-BLR-002', cancelledAt: iso(), reason: 'CASE_CLOSED' }) });
  }
  return [
    emergency(c1, 'Severe polytrauma', 'CRITICAL'),
    { name: 'dispatch', event: () => mk('ambulance.dispatched', { type: 'system', id: 'dispatch' }, { ambulanceId: 'AMB-BLR-001', caseId: c1, destination: HEBBAL, estimatedEtaMinutes: 8 }) },
    respond('001 accepts', c1, 'HOSP-BLR-001', 'ACCEPTED'),
    respond('004 accepts', c1, 'HOSP-BLR-004', 'ACCEPTED'),
    respond('002 limited', c1, 'HOSP-BLR-002', 'LIMITED', ['EMERGENCY', 'TRAUMA']),
    emergency(c2, 'Chest pain', 'HIGH'),
    respond('c2: 001 accepts', c2, 'HOSP-BLR-001', 'ACCEPTED'),
    ...extra,
    { name: '001 loses ED', event: () => mk('hospital.capacity.updated', { type: 'hospital', id: 'HOSP-BLR-001' }, { hospitalId: 'HOSP-BLR-001', emergencyStatus: 'UNAVAILABLE', traumaStatus: 'UNAVAILABLE', icuStatus: 'UNAVAILABLE', ventilatorStatus: 'UNKNOWN' }, { metadata: { confidence: 1, sourceType: 'SYNTHETIC_DEMO', trustedEvidence: { status: 'SYNTHETIC_DEMO', environment: 'DEMO' } } }) },
  ];
}

/** A response names the request it answers; ids are generated per side, so scripts write '@LATEST'. */
function resolveLatest(e: AnyEvent, log: AnyEvent[]): AnyEvent {
  const p = (e as any).payload;
  if ((e.eventType !== 'hospital.acceptance.received' && (e.eventType as string) !== 'hospital.acceptance.cancelled') || p.requestId !== '@LATEST') return JSON.parse(JSON.stringify(e));
  const req = [...log].reverse().find((x: any) => x.eventType === 'hospital.acceptance.requested' && x.payload.caseId === p.caseId && x.payload.hospitalId === p.hospitalId) as any;
  return JSON.parse(JSON.stringify({ ...e, payload: { ...p, requestId: req?.payload.requestId ?? 'AR-none' } }));
}

const pick = (o: any, keys: string[]) => Object.fromEntries(keys.map(k => [k, o?.[k]]));
const opView = (h: any) => pick(h.operationalState, ['emergency', 'icu', 'trauma', 'ventilator', 'acceptance', 'acceptanceCaseId', 'source']); // no wall-clock fields
const ambView = (a: any) => ({ status: a.status, destination: a.destinationHospital, route: a.activeRoute?.hospitalId, patient: a.assignedPatient });
const patView = (p: any) => pick(p, ['currentStatus', 'assignedHospital', 'assignedAmbulance', 'careRequirements']);
function decisions(events: AnyEvent[]) {
  const out: unknown[] = [];
  for (const e of events as any[]) {
    const p = e.payload;
    switch (e.eventType) {
      case 'hospital.candidate.generated': out.push(['candidates', p.caseId, p.candidates.map((c: any) => [c.hospitalId, c.operationalEligibility, c.missingCapabilities])]); break;
      case 'hospital.acceptance.requested': out.push(['requested', p.caseId, p.hospitalId]); break;
      case 'destination.changed': out.push(['destination', p.ambulanceId, p.hospitalId, p.reason]); break;
      case 'route.recalculated': out.push(['route', p.ambulanceId, p.oldHospitalId, p.newHospitalId, p.reason]); break;
    }
  }
  return out;
}

async function main() {
  console.log('[Test] Containment: the legacy decision flow is independent of every auxiliary component\n');

  // ================================================================ LOCAL
  const { eventBus } = await import('../../services/api/src/eventBus');
  const engines = await import('../../services/api/src/stateEngines');
  const stores = await import('../../services/api/src/stateStore');
  const { feasibilityShadow, acceptanceLedger } = await import('../../services/api/src/feasibility');
  await stores.preloadData();
  engines.initializeStateEngines();

  let localLog: AnyEvent[] = [];
  eventBus.on('*', (e: AnyEvent) => { localLog.push(e); });
  const settle = async () => {
    let last = -1, stable = 0;
    while (stable < 4) { await sleep(40); stable = localLog.length === last ? stable + 1 : 0; last = localLog.length; }
  };

  const shadowAny = feasibilityShadow as any;
  type Undo = () => void;
  const patchMethod = (obj: any, name: string, impl: (...a: any[]) => any): Undo => { const orig = obj[name]; obj[name] = impl; return () => { obj[name] = orig; }; };

  async function runLocal(variant: { name: string; mode?: string; patch?: () => Undo; onStep?: (i: number) => void }, steps: Step[]) {
    engines.resetEngines();
    await stores.localStoreInstance.reset();
    localLog = [];
    resetAuxiliaryFailures();
    process.env.FEASIBILITY_ENGINE = variant.mode ?? 'shadow';
    const savedWarn = console.warn; console.warn = () => undefined; // the "not enabled in this phase" warning is expected noise
    const undo = variant.patch?.();
    try {
      let i = 0;
      for (const s of steps) {
        variant.onStep?.(i++);
        await eventBus.publish(resolveLatest(s.event(), localLog));
        await settle();
      }
      await settle();
    } finally {
      undo?.();
      console.warn = savedWarn;
      process.env.FEASIBILITY_ENGINE = 'shadow';
    }
    const sent = new Set(localLog.filter(e => steps.some(() => false)).map(e => e.eventId));
    void sent;
    return {
      hospitals: Object.fromEntries([...stores.hospitalsStore.entries()].map(([k, v]) => [k, opView(v)])),
      ambulances: Object.fromEntries([...stores.ambulancesStore.entries()].map(([k, v]) => [k, ambView(v)])),
      patients: Object.fromEntries([...stores.patientsStore.entries()].map(([k, v]) => [k, patView(v)])),
      decisions: decisions(localLog.filter(e => (e as any).source?.type === 'system' && (e as any).source?.id !== 'dispatch' && (e as any).source?.id !== 'feasibility-shadow')),
      traceEvents: localLog.filter(e => e.eventType === 'feasibility.trace.recorded').length,
    };
  }

  const boom = (what: string) => () => { throw new Error(`${what} exploded`); };
  const reject = (what: string) => async () => { throw new Error(`${what} rejected`); };

  const baseline = await runLocal({ name: 'off', mode: 'off' }, script());
  ok(baseline.traceEvents === 0, 'baseline: shadow off emits nothing');
  ok(baseline.decisions.length > 8, 'baseline is a real scenario (requests, destinations, reroute)');
  const dest = (t: typeof baseline) => (t.ambulances as any)['AMB-BLR-001'].destination;
  ok(!!dest(baseline), `baseline assigns a destination (${dest(baseline)})`);

  const localVariants: { name: string; patch?: () => Undo; expectFailures?: boolean; expectTraces?: boolean }[] = [
    { name: 'shadow ON, everything healthy', expectTraces: true },
    // acceptanceLedger.applyResponse is intentionally NOT fault-injected here any more: since the
    // legacy one-slot fix, evaluateHospitals' acceptanceOverride reads this ledger to decide real
    // case-scoped eligibility, so this write is now part of the core decision (like
    // d.store.setHospital), not an auxiliary observation -- exactly the same status as every other
    // core store write in this suite, none of which are fault-injected either.
    { name: 'acceptanceLedger.recordRequest throws', patch: () => patchMethod(acceptanceLedger, 'recordRequest', boom('ledger.recordRequest')), expectFailures: true },
    { name: 'shadow.recordRequirement throws', patch: () => patchMethod(feasibilityShadow, 'recordRequirement', boom('shadow.recordRequirement')), expectFailures: true },
    { name: 'shadow.requirementFor throws', patch: () => patchMethod(feasibilityShadow, 'requirementFor', boom('shadow.requirementFor')), expectFailures: true },
    { name: 'shadow.evaluate throws synchronously', patch: () => patchMethod(feasibilityShadow, 'evaluate', boom('shadow.evaluate')), expectFailures: true },
    { name: 'shadow.evaluate rejects', patch: () => patchMethod(feasibilityShadow, 'evaluate', reject('shadow.evaluate')), expectFailures: true },
    { name: 'shadow.evaluate never settles (hangs)', patch: () => patchMethod(feasibilityShadow, 'evaluate', () => new Promise(() => undefined)) },
    { name: 'shadow.observeDestination throws', patch: () => patchMethod(feasibilityShadow, 'observeDestination', boom('shadow.observeDestination')), expectFailures: true },
    { name: 'trace publishing fails (sink down)', patch: () => { const d = shadowAny.deps; const orig = d.publishTrace; d.publishTrace = async () => { throw new Error('sink down'); }; return () => { d.publishTrace = orig; }; }, expectTraces: false },
    { name: 'trace generation fails (mapping provider throws inside shadow)', patch: () => { const d = shadowAny.deps; const orig = d.mapping; d.mapping = { ...orig, calculateRoute: async () => { throw new Error('mapping down'); } }; return () => { d.mapping = orig; }; } },
  ];

  for (const v of localVariants) {
    await check(`local: ${v.name} -> legacy transcript identical to shadow-OFF`, async () => {
      const t = await runLocal({ name: v.name, mode: 'shadow', patch: v.patch }, script());
      eq(t.hospitals, baseline.hospitals, 'hospital operational state');
      eq(t.ambulances, baseline.ambulances, 'ambulance state (destination / route)');
      eq(t.patients, baseline.patients, 'patient state');
      eq(t.decisions, baseline.decisions, 'decision events (candidates, requests, destinations, reroutes)');
      if (v.expectFailures) ok(auxiliaryFailureCount() > 0, 'the auxiliary failure was contained and counted');
      if (v.expectTraces) ok(t.traceEvents > 0, 'shadow observed normally');
    });
  }

  await check('local: a response payload missing fields that legacy never reads no longer blocks legacy (it used to throw in the ledger, even with the shadow OFF)', async () => {
    const off = await runLocal({ name: 'off+malformed', mode: 'off' }, script({ malformedResponses: true }));
    const on = await runLocal({ name: 'shadow+malformed', mode: 'shadow' }, script({ malformedResponses: true }));
    eq(on.hospitals, off.hospitals, 'hospital state');
    eq(on.ambulances, off.ambulances, 'ambulance state');
    eq(on.decisions, off.decisions, 'decisions');
    ok(!!(on.ambulances as any)['AMB-BLR-001'].destination, 'destination still assigned');
  });

  await check('local: FEASIBILITY_ENGINE=off (no shadow, no held-destination observation) is the reference behaviour', async () => {
    eq(baseline.traceEvents, 0, 'nothing emitted in off mode');
  });

  await check('local: held-destination observation is wired (shadow-only): recorded, not a trace, changes nothing', async () => {
    const t = await runLocal({ name: 'shadow', mode: 'shadow' }, [
      ...script().slice(0, 3),
      { name: '001 benign capacity update', event: () => mk('hospital.capacity.updated', { type: 'hospital', id: 'HOSP-BLR-001' }, { hospitalId: 'HOSP-BLR-001', emergencyStatus: 'AVAILABLE', traumaStatus: 'AVAILABLE', icuStatus: 'AVAILABLE', ventilatorStatus: 'AVAILABLE' }, { metadata: { confidence: 1, sourceType: 'SYNTHETIC_DEMO', trustedEvidence: { status: 'SYNTHETIC_DEMO', environment: 'DEMO' } } }) },
    ]);
    const obs = feasibilityShadow.getDestinationObservations('CASE-CT1').filter(o => o.hospitalId === 'HOSP-BLR-001');
    ok(obs.length > 0, 'the held destination was observed');
    ok(obs.every(o => o.feasible), 'and is feasible');
    eq((t.ambulances as any)['AMB-BLR-001'].destination, 'HOSP-BLR-001', 'destination untouched by the observation');
    ok(feasibilityShadow.getTraces('CASE-CT1').every(tr => tr.trigger.eventType !== 'current-destination'), 'observations are not decision traces');
  });

  // ================================================================ KILL SWITCH / FAIL-SAFE (no authoritative mode exists)
  const sameLegacy = (a: typeof baseline, b: typeof baseline, why: string) => {
    eq(a.hospitals, b.hospitals, `${why}: hospitals`); eq(a.ambulances, b.ambulances, `${why}: ambulances`);
    eq(a.patients, b.patients, `${why}: patients`); eq(a.decisions, b.decisions, `${why}: decisions`);
  };

  await check('kill switch: any FEASIBILITY_ENGINE value other than off|shadow ("authoritative", "on", garbage) FAILS SAFE to shadow; legacy is unchanged', async () => {
    for (const mode of ['authoritative', 'on', 'ENGINE', '']) {
      const t = await runLocal({ name: `mode=${mode}`, mode }, script());
      sameLegacy(t, baseline, `FEASIBILITY_ENGINE=${JSON.stringify(mode)}`);
    }
    const { feasibilityMode } = await import('../../services/api/src/feasibility/shadow');
    const saved = process.env.FEASIBILITY_ENGINE; const w = console.warn; console.warn = () => undefined;
    try {
      for (const m of ['authoritative', 'on', 'x']) { process.env.FEASIBILITY_ENGINE = m; eq(feasibilityMode(), 'shadow', `${m} -> shadow`); }
      process.env.FEASIBILITY_ENGINE = 'off'; eq(feasibilityMode(), 'off', 'off');
    } finally { console.warn = w; process.env.FEASIBILITY_ENGINE = saved; }
  });

  await check('kill switch: flipping FEASIBILITY_ENGINE=off in the MIDDLE of the flow stops shadow activity immediately (no restart); legacy result identical', async () => {
    const t = await runLocal({ name: 'flip', mode: 'shadow', onStep: i => { if (i === 3) process.env.FEASIBILITY_ENGINE = 'off'; } }, script());
    sameLegacy(t, baseline, 'mid-flow kill switch');
    const flipped = feasibilityShadow.getTraces().length;
    await runLocal({ name: 'full shadow', mode: 'shadow' }, script());
    const full = feasibilityShadow.getTraces().length;
    ok(flipped < full, `the flipped run has fewer traces (${flipped}) than a full shadow run (${full})`);
    ok(flipped <= 3, `only evaluations before the flip exist (${flipped})`);
  });

  await check('fail-safe: malformed evidence on the bus (wrong types, impossible dates, unknown status) — shadow on vs off give the same legacy transcript', async () => {
    const off = await runLocal({ name: 'garbage off', mode: 'off' }, script({ garbage: true }));
    const on = await runLocal({ name: 'garbage on', mode: 'shadow' }, script({ garbage: true }));
    sameLegacy(on, off, 'malformed evidence');
  });

  await check('fail-safe: policy changes mid-evaluation (same version string) -> the engine refuses, it is counted, legacy continues', async () => {
    const t = await runLocal({ name: 'policy drift', mode: 'shadow', patch: () => {
      const d = shadowAny.deps; const orig = d.mapping;
      const rules = shadowAny.policy.rules.OPERATIONAL_CAPACITY; const saved = rules.maxAgeSeconds;
      d.mapping = { ...orig, calculateRoute: async (r: any) => { rules.maxAgeSeconds += 1; return orig.calculateRoute(r); } };
      return () => { d.mapping = orig; rules.maxAgeSeconds = saved; };
    } }, script());
    sameLegacy(t, baseline, 'policy drift');
    ok(feasibilityShadow.getSoakSummary().policyMismatches > 0, 'policy mismatches were classified');
  });

  await check('fail-safe: an acceptance CANCELLATION event on the bus leaves legacy state untouched (the ledger observes it; legacy has no handler)', async () => {
    const off = await runLocal({ name: 'cancel off', mode: 'off' }, script({ withCancel: true }));
    const on = await runLocal({ name: 'cancel on', mode: 'shadow' }, script({ withCancel: true }));
    sameLegacy(on, off, 'cancellation');
    sameLegacy(off, baseline, 'cancellation does not change legacy at all');
  });

  // ================================================================ AWS
  const { mappingProvider } = await import('../../services/api/src/mapping');
  const RULES = {
    emergency: ['patient.emergency.created', 'care.requirement.created'],
    hospital: ['hospital.acceptance.requested', 'hospital.acceptance.received', 'hospital.capacity.updated', 'hospital.acceptance.expired', 'hospital.acceptance.cancelled'],
    ambulance: ['ambulance.dispatched', 'ambulance.location.updated'],
  };

  interface AwsVariant { name: string; shadow: 'none' | 'on' | { timeoutMs: number; delayMs: number }; prepare?: (store: LocalStateStore) => Promise<void> | void; expect?: (r: Awaited<ReturnType<typeof runAws>>) => void }

  async function runAws(v: AwsVariant, steps: Step[]) {
    const store = new LocalStateStore();
    await store.preloadData();
    const holder: { router?: EventRouter } = {};
    const deps: any = { store, bus: undefined as any, mapping: mappingProvider };
    const hospitalH = createHospitalHandler(deps);
    const router = new EventRouter([
      { target: 'emergency', detailTypes: RULES.emergency, handler: createEmergencyHandler(deps) },
      { target: 'hospital', detailTypes: RULES.hospital, handler: hospitalH },
      { target: 'ambulance', detailTypes: RULES.ambulance, handler: createAmbulanceHandler(deps) },
    ]);
    holder.router = router;
    deps.bus = router.bus;
    if (v.shadow !== 'none') {
      const slow = typeof v.shadow === 'object' ? v.shadow : undefined;
      const shadowMapping = slow ? { ...mappingProvider, calculateRoute: async (req: any) => { await sleep(slow.delayMs); return mappingProvider.calculateRoute(req); } } : mappingProvider;
      deps.shadow = createStoreBackedShadow({ store, bus: router.bus, mapping: shadowMapping as any, log: () => undefined, timeoutMs: slow?.timeoutMs });
    }
    await v.prepare?.(store);
    const started = Date.now();
    for (const s of steps) await router.send(resolveLatest(s.event(), router.bus.published));
    const elapsed = Date.now() - started;
    return {
      hospitals: Object.fromEntries((await store.listHospitals()).map(h => [h.hospitalId, opView(h)])),
      ambulances: Object.fromEntries((await store.listAmbulances()).map(a => [a.ambulanceId, ambView(a)])),
      patients: Object.fromEntries((await store.listPatients()).map(p => [p.patientId, patView(p)])),
      decisions: decisions(router.bus.published.filter(e => (e as any).source?.type === 'system' && (e as any).source?.id !== 'dispatch' && (e as any).source?.id !== 'feasibility-shadow')),
      shadow: deps.shadow as ReturnType<typeof createStoreBackedShadow> | undefined,
      elapsed,
    };
  }

  const awsBase = await runAws({ name: 'no shadow', shadow: 'none' }, script());
  ok(!!(awsBase.ambulances as any)['AMB-BLR-001'].destination, 'AWS baseline assigns a destination');
  await check('AWS baseline (no shadow) equals the local legacy baseline (same decisions, same state)', () => {
    eq(awsBase.hospitals, baseline.hospitals, 'hospitals');
    eq(awsBase.ambulances, baseline.ambulances, 'ambulances');
    eq(awsBase.decisions, baseline.decisions, 'decisions');
  });

  const throttled = (store: LocalStateStore) => {
    const err = () => Object.assign(new Error('ThrottlingException: Rate of requests exceeds the allowed throughput'), { name: 'ThrottlingException' });
    store.queryEventsByCase = async () => { throw err(); };
    store.listRecentEvents = async () => { throw err(); };
  };
  const missing = (store: LocalStateStore) => {
    store.queryEventsByCase = async () => [];
    store.listRecentEvents = async () => [];
  };
  const poisoned = async (store: LocalStateStore) => {
    // malformed acceptance events already sitting in the history of the very cases we are about to process
    for (const caseId of ['CASE-CT1', 'CASE-CT2']) {
      for (const payload of [null, { responseId: 5, status: 'ACCEPTED', caseId, hospitalId: 'HOSP-BLR-001' }, 'garbage']) {
        await store.recordEvent({ eventId: randomUUID(), eventType: 'hospital.acceptance.received', timestamp: iso(-5), version: '1.0', source: { type: 'hospital', id: 'HOSP-BLR-001' }, payload, patientId: caseId } as unknown as AnyEvent);
      }
      await store.recordEvent({ eventId: randomUUID(), eventType: 'hospital.acceptance.requested', timestamp: iso(-5), version: '1.0', source: { type: 'system', id: 'acceptance-protocol' }, payload: { garbage: true, caseId }, patientId: caseId } as unknown as AnyEvent);
    }
  };

  const awsVariants: AwsVariant[] = [
    { name: 'shadow ON, healthy', shadow: 'on' },
    { name: 'history query throttled (ledger replay and requirement lookup both fail)', shadow: 'on', prepare: throttled },
    { name: 'history query throttled, shadow OFF (the duplicate check still cannot read history)', shadow: 'none', prepare: throttled },
    { name: 'malformed / poisoned historical events', shadow: 'on', prepare: poisoned },
    { name: 'malformed / poisoned historical events, shadow OFF', shadow: 'none', prepare: poisoned },
    { name: 'missing history', shadow: 'on', prepare: missing },
    { name: 'missing history, shadow OFF', shadow: 'none', prepare: missing },
  ];
  for (const v of awsVariants) {
    await check(`AWS: ${v.name} -> legacy transcript identical to the healthy no-shadow baseline`, async () => {
      const t = await runAws(v, script());
      eq(t.hospitals, awsBase.hospitals, 'hospital operational state');
      eq(t.ambulances, awsBase.ambulances, 'ambulance state');
      eq(t.patients, awsBase.patients, 'patient state');
      eq(t.decisions, awsBase.decisions, 'decision events');
    });
  }

  await check('AWS: a duplicate response redelivered while history is unreadable is applied idempotently (best-effort dedupe, same final state)', async () => {
    const dupScript = (): Step[] => {
      let first: AnyEvent;
      const s = script().slice(0, 3);
      return [...s.slice(0, 2), { name: '001 accepts', event: () => (first = s[2].event()) }, { name: 'redelivery (new eventId)', event: () => ({ ...JSON.parse(JSON.stringify(first)), eventId: randomUUID() }) as AnyEvent }];
    };
    const healthy = await runAws({ name: 'dup healthy', shadow: 'none' }, dupScript());
    const degraded = await runAws({ name: 'dup throttled', shadow: 'on', prepare: throttled }, dupScript());
    eq(degraded.hospitals, healthy.hospitals, 'hospital state');
    eq(degraded.ambulances, healthy.ambulances, 'ambulance state');
  });

  await check('AWS timeout: a deliberately slow shadow is abandoned within its budget; legacy completes with an identical result', async () => {
    const slow = await runAws({ name: 'slow shadow', shadow: { timeoutMs: 50, delayMs: 2500 } }, script());
    eq(slow.hospitals, awsBase.hospitals, 'hospitals');
    eq(slow.ambulances, awsBase.ambulances, 'ambulances');
    eq(slow.decisions, awsBase.decisions, 'decisions');
    ok(slow.shadow!.getFailures().some(f => f.kind === 'TIMEOUT'), 'timeouts recorded as shadow failures');
    ok(slow.elapsed < 8000, `the whole scenario finished in ${slow.elapsed} ms; every awaited shadow evaluation was bounded (an unbounded 2.5 s provider per evaluation would exceed this)`);
    ok(slow.shadow!.getTraces().length === 0, 'abandoned evaluations stored no traces');
  });

  await check('AWS: held-destination observation is wired after the legacy decision (shadow-only; no traces, no route change)', async () => {
    const steps = [
      ...script().slice(0, 3),
      { name: '001 benign capacity update', event: () => mk('hospital.capacity.updated', { type: 'hospital', id: 'HOSP-BLR-001' }, { hospitalId: 'HOSP-BLR-001', emergencyStatus: 'AVAILABLE', traumaStatus: 'AVAILABLE', icuStatus: 'AVAILABLE', ventilatorStatus: 'AVAILABLE' }, { metadata: { confidence: 1, sourceType: 'SYNTHETIC_DEMO', trustedEvidence: { status: 'SYNTHETIC_DEMO', environment: 'DEMO' } } }) },
    ];
    const t = await runAws({ name: 'obs', shadow: 'on' }, steps);
    const obs = t.shadow!.getDestinationObservations('CASE-CT1');
    ok(obs.length > 0 && obs.every(o => o.hospitalId === 'HOSP-BLR-001'), 'observed');
    eq((t.ambulances as any)['AMB-BLR-001'].destination, 'HOSP-BLR-001', 'destination untouched');
    ok(t.shadow!.getTraces('CASE-CT1').length > 0 && t.shadow!.getTraces('CASE-CT1').every(tr => tr.trigger.eventType !== 'hospital.capacity.updated'), 'observations do not become decision traces');
  });

  console.log(`\n[Test] Feasibility containment: ${passCount()} checks passed.`);
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
