/**
 * Remediation of the promotion-readiness audit (shadow-only phase):
 *  3  acceptance requires a valid, current, correlated request (evaluated INSIDE the engine)
 *  4  live ledger === replayed ledger for the same events, whatever the arrival order
 *  5  evidence environment boundary / trusted provenance / forged sourceType
 *  6  legacy one-slot acceptance is isolated from the engine's inputs
 *  7  the trace event carries no client-supplied free text
 *  8  the effective policy is bound into the snapshot/audit hashes
 *  9  shadow-only observation of the currently held destination
 *  10 bounded shadow evaluation (timeout) outside the pure package
 * Nothing here touches a network.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { AnyEvent } from '../../packages/event-schema/src';
import { FeasibilityTraceRecordedSchema } from '../../packages/event-schema/src';
import type { ETAResult, Location, MappingProvider, RouteRequest, RouteResult } from '../../packages/mapping/src';
import type { GeoPoint, HospitalAvailabilityResponse } from '../../packages/domain-models/src';
import { createFreshnessPolicy, evaluateFeasibility, hashPolicy } from '../../packages/feasibility/src';
import { AcceptanceLedger, withTrust } from '../../services/api/src/feasibility/acceptanceLedger';
import { assembleSnapshot } from '../../services/api/src/feasibility/snapshotAssembler';
import { FeasibilityShadow } from '../../services/api/src/feasibility/shadow';
import { buildTraceEventPayload } from '../../services/api/src/feasibility/traceEvent';
import { deriveTrustedStatus, stampTrustedEvidence } from '../../services/api/src/evidenceTrust';
import { createIngestionHandler } from '../../services/api/src/lambdas/core/ingestionCore';
import { createStoreBackedShadow } from '../../services/api/src/lambdas/core/deps';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { applyCapacityUpdate } from '../../services/api/src/stateTransitions';
import {
  CASE, CAPS, cand, check, counter, eq, evaluateDual, evaluateParity, hospital, iso, MemoryBus, ok, ORIGIN,
  passCount, requestedEvent, requirement, responseEvent, rule, stubMapping, T0, withCapacity,
} from './helpers/feasibilityHarness';

const PROD = createFreshnessPolicy({}, undefined, { environment: 'PRODUCTION' });
const H1 = () => hospital('H-1', 1);

/** A request with an explicit id (the harness derives `AR-<case>-<hospital>`). */
const request = (caseId: string, hospitalId: string, requestId: string, atMin: number, ttlMin = 15) => {
  const e: any = requestedEvent(caseId, hospitalId, atMin, ttlMin);
  e.payload.requestId = requestId;
  return e as AnyEvent;
};
const P = (e: AnyEvent) => (e as any).payload;

async function main() {
  console.log('[Test] Feasibility remediation (shadow-only): correlation, ledger equivalence, trust, privacy, policy hash, destination, timeout\n');

  // ============================================================ 3. acceptance needs a valid request
  const reasonOf = (r: Awaited<ReturnType<typeof evaluateParity>>, id = 'H-1') => rule(r, id, 'HC-ACC-04').reasonCode;
  const pending = (r: Awaited<ReturnType<typeof evaluateParity>>, why: string, id = 'H-1') => {
    eq(cand(r, id).verdict, 'PENDING_ACCEPTANCE', `${why}: never ELIGIBLE`);
    return reasonOf(r, id);
  };

  await check('3. control: a valid, current request + in-window trusted response -> ELIGIBLE (local === AWS)', async () => {
    const r = await evaluateParity({ hospitals: [H1()], events: [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED')] }, 'control');
    eq(cand(r, 'H-1').verdict, 'ELIGIBLE', 'eligible');
  });

  await check('3. no request exists -> the response resolves nothing', async () => {
    const r = await evaluateParity({ hospitals: [H1()], events: [responseEvent(CASE, 'H-1', 'ACCEPTED')] }, 'no request');
    eq(pending(r, 'no request'), 'RESPONSE_NO_VALID_REQUEST', 'reason');
  });

  await check('3. request belongs to ANOTHER HOSPITAL -> the answering hospital is not eligible', async () => {
    const r = await evaluateParity({ hospitals: [H1(), hospital('H-2', 3)], events: [requestedEvent(CASE, 'H-2'), responseEvent(CASE, 'H-1', 'ACCEPTED')] }, 'other hospital');
    eq(pending(r, 'other hospital'), 'RESPONSE_NO_VALID_REQUEST', 'reason');
    eq(reasonOf(r, 'H-2'), 'NO_RESPONSE_YET', 'the asked hospital is still waiting');
  });

  await check('3. request belongs to ANOTHER CASE -> not eligible for this case', async () => {
    const r = await evaluateParity({ hospitals: [H1()], events: [requestedEvent('CASE-B', 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED')] }, 'other case');
    eq(pending(r, 'other case'), 'RESPONSE_NO_VALID_REQUEST', 'reason');
  });

  await check('3. request EXPIRED before the response -> not eligible', async () => {
    const r = await evaluateParity({ hospitals: [H1()], events: [requestedEvent(CASE, 'H-1', -60, 15), responseEvent(CASE, 'H-1', 'ACCEPTED', { respondedMin: -1 })] }, 'expired request');
    eq(pending(r, 'expired request'), 'RESPONSE_OUTSIDE_REQUEST_WINDOW', 'reason');
  });

  await check('3. response dated BEFORE the request existed -> not eligible', async () => {
    const r = await evaluateParity({ hospitals: [H1()], events: [requestedEvent(CASE, 'H-1', -3, 15), responseEvent(CASE, 'H-1', 'ACCEPTED', { respondedMin: -10 })] }, 'pre-dated');
    eq(pending(r, 'pre-dated'), 'RESPONSE_OUTSIDE_REQUEST_WINDOW', 'reason');
  });

  await check('3. SUPERSEDED request: a response naming the older request is unusable; one naming the current request is', async () => {
    const events = (name: string) => [request(CASE, 'H-1', 'AR-1', -10), request(CASE, 'H-1', 'AR-2', -3), responseEvent(CASE, 'H-1', 'ACCEPTED', { respondedMin: -2, requestId: name })];
    const old = await evaluateParity({ hospitals: [H1()], events: events('AR-1') }, 'superseded');
    eq(pending(old, 'superseded'), 'RESPONSE_REQUEST_SUPERSEDED', 'reason');
    const cur = await evaluateParity({ hospitals: [H1()], events: events('AR-2') }, 'current');
    eq(cand(cur, 'H-1').verdict, 'ELIGIBLE', 'current request accepted');
    const bogus = await evaluateParity({ hospitals: [H1()], events: events('AR-demo') }, 'unknown id');
    eq(pending(bogus, 'unknown request id'), 'RESPONSE_REQUEST_SUPERSEDED', 'a response naming no known request is uncorrelated');
  });

  await check('3. CANCELLED request: the response cannot resolve anything (engine-level rule, live ledger)', async () => {
    const ledger = new AcceptanceLedger();
    const req = P(requestedEvent(CASE, 'H-1'));
    const resp = responseEvent(CASE, 'H-1', 'ACCEPTED');
    ledger.recordRequest(req);
    ledger.applyResponse(withTrust(P(resp), (resp as any).metadata));
    ledger.cancelRequest(req.requestId, iso(-1));
    const shadow = new FeasibilityShadow({ hospitals: () => [H1()], ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0), newId: counter(), policy: createFreshnessPolicy() });
    const res = await shadow.evaluate({ context: 'candidate-generation', requirement: requirement(), requirementProvenance: 'RULE_DERIVED', trigger: { eventId: randomUUID(), eventType: 'care.requirement.created', sourceId: 's' }, origin: ORIGIN, evaluatedAt: iso(0) });
    const acc = res!.decision.candidates[0].hardConstraints.find(c => c.ruleId === 'HC-ACC-04')!;
    eq([res!.decision.candidates[0].verdict, acc.reasonCode], ['PENDING_ACCEPTANCE', 'RESPONSE_REQUEST_CANCELLED'], 'cancelled');
  });

  await check('3. only a valid exchange may resolve an UNKNOWN capability; every invalid one leaves it UNKNOWN', async () => {
    const noTrauma = () => hospital('H-1', 1, { capabilities: { emergency: true, icu: true } });
    const clin = async (events: AnyEvent[], why: string) => {
      const r = await evaluateParity({ hospitals: [noTrauma()], events }, why);
      return `${rule(r, 'H-1', 'HC-CLIN-01').outcome}/${rule(r, 'H-1', 'HC-CLIN-01').reasonCode}`;
    };
    eq(await clin([requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED')], 'valid'), 'PASS/CAPABILITY_CONFIRMED_BY_RESPONSE', 'valid exchange confirms');
    for (const [why, events] of [
      ['no request', [responseEvent(CASE, 'H-1', 'ACCEPTED')]],
      ['wrong case', [requestedEvent('CASE-B', 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED')]],
      ['expired request', [requestedEvent(CASE, 'H-1', -60, 15), responseEvent(CASE, 'H-1', 'ACCEPTED', { respondedMin: -1 })]],
      ['unstamped provenance', [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED', { trusted: null })]],
    ] as [string, AnyEvent[]][]) {
      eq(await clin(events, why), 'UNKNOWN/NOT_LISTED', `${why}: capability stays UNKNOWN`);
    }
  });

  // ============================================================ 4. live === replay
  function rng(seed: number) {
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pickOf = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)];
  type Ev = { eventId: string; eventType: string; timestamp: string; payload: any; metadata?: any };

  function generate(seed: number): Ev[] {
    const r = rng(seed);
    const out: Ev[] = [];
    for (const c of ['A', 'B']) for (const h of ['H1', 'H2']) {
      for (const [id, at] of [['R1', -10], ['R2', -5]] as [string, number][]) {
        if (r() < 0.7) out.push({ eventId: randomUUID(), eventType: 'hospital.acceptance.requested', timestamp: iso(at), payload: { requestId: `${id}-${c}${h}`, caseId: c, hospitalId: h, requestedAt: iso(at), expiresAt: iso(at + 15) } });
      }
    }
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
    for (let i = 0; i < 14; i++) {
      const c = pickOf(r, ['A', 'B']), h = pickOf(r, ['H1', 'H2']);
      const responded = pickOf(r, [-9, -8, -8, -6, -4, -4]);
      const status = pickOf(r, ['ACCEPTED', 'LIMITED', 'REJECTED', 'UNAVAILABLE', 'ACCEPTED']);
      const trust = pickOf(r, ['SYNTHETIC_DEMO', 'HOSPITAL_CONFIRMED', undefined]);
      out.push({
        eventId: randomUUID(), eventType: 'hospital.acceptance.received', timestamp: iso(responded),
        payload: {
          responseId: pickOf(r, ids), requestId: `${pickOf(r, ['R1', 'R2', 'X'])}-${c}${h}`, caseId: c, hospitalId: h, status,
          acceptedCapabilities: status === 'REJECTED' || status === 'UNAVAILABLE' ? [] : ['EMERGENCY'], limitations: [],
          respondedAt: iso(responded), validUntil: iso(pickOf(r, [-12, 10, 20])), responderRole: 'C', source: 'SYNTHETIC_DEMO',
        },
        metadata: trust ? { sourceType: 't', trustedEvidence: { status: trust, environment: 'DEMO' } } : undefined,
      });
    }
    // redeliveries: same eventId again
    for (const e of [...out]) if (r() < 0.2) out.push({ ...e });
    return out;
  }
  const shuffle = <T,>(xs: T[], r: () => number) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const applyLive = (events: Ev[]) => {
    const l = new AcceptanceLedger();
    for (const e of events) {
      if (e.eventType === 'hospital.acceptance.requested') l.recordRequest(e.payload);
      else l.applyResponse(withTrust(e.payload, e.metadata));
    }
    return l;
  };
  const viewsOf = (l: AcceptanceLedger) => JSON.stringify(['A', 'B'].flatMap(c => ['H1', 'H2'].flatMap(h => [-5, 0, 20].map(m => l.view(c, h, T0 + m * 60000)))));

  await check('4. live ledger === replayed ledger (byte-identical state and views) across 300 random histories and arrival orders', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const events = generate(seed);
      const r = rng(seed * 7919);
      const live = applyLive(events);                                   // arrival order 1 (as generated)
      const live2 = applyLive(shuffle(events, r));                      // arrival order 2 (out of order)
      const replay = AcceptanceLedger.fromEvents(shuffle(events, r));   // replay from history in yet another order
      eq(live.snapshot() === replay.snapshot(), true, `seed ${seed}: live state === replay state`);
      eq(live2.snapshot() === replay.snapshot(), true, `seed ${seed}: any arrival order gives the same state`);
      eq(viewsOf(live) === viewsOf(replay) && viewsOf(live2) === viewsOf(replay), true, `seed ${seed}: identical views`);
    }
  });

  await check('4. ONE ordering rule: equal respondedAt -> more restrictive wins, then responseId; identical in both orders and in replay', () => {
    const a = (id: string, status: string) => ({ eventId: randomUUID(), eventType: 'hospital.acceptance.received', timestamp: iso(-2),
      payload: { responseId: id, requestId: 'R', caseId: 'A', hospitalId: 'H', status, acceptedCapabilities: ['EMERGENCY'], limitations: [], respondedAt: iso(-2), validUntil: iso(20), responderRole: 'C', source: 'SYNTHETIC_DEMO' },
      metadata: { sourceType: 't', trustedEvidence: { status: 'SYNTHETIC_DEMO', environment: 'DEMO' } } });
    const acc = a('r-b', 'ACCEPTED'), rej = a('r-a', 'REJECTED');
    for (const order of [[acc, rej], [rej, acc]]) {
      eq(applyLive(order).view('A', 'H', T0).response?.status, 'REJECTED', 'REJECTED wins the tie in any order');
      eq(AcceptanceLedger.fromEvents(order).view('A', 'H', T0).response?.status, 'REJECTED', 'and in replay');
    }
    const x = a('r-1', 'ACCEPTED'), y = a('r-2', 'ACCEPTED');
    eq(applyLive([x, y]).view('A', 'H', T0).response?.responseId, 'r-2', 'same status: higher responseId');
    eq(applyLive([y, x]).view('A', 'H', T0).response?.responseId, 'r-2', 'same status: higher responseId (reversed)');
  });

  await check('4. already-expired / late / duplicate / stale / conflicting responses are handled by the same rule live and in replay', () => {
    const l = new AcceptanceLedger();
    const base = (over: Partial<HospitalAvailabilityResponse>): HospitalAvailabilityResponse => ({ responseId: 'r', requestId: 'R', caseId: 'A', hospitalId: 'H', status: 'ACCEPTED', acceptedCapabilities: ['EMERGENCY'], limitations: [], respondedAt: iso(-5), validUntil: iso(20), responderRole: 'C', source: 'SYNTHETIC_DEMO', trustedSource: 'SYNTHETIC_DEMO', ...over });
    eq(l.applyResponse(base({ responseId: 'a' })), 'APPLIED', 'first');
    eq(l.applyResponse(base({ responseId: 'a' })), 'DUPLICATE', 'duplicate');
    eq(l.applyResponse(base({ responseId: 'b', respondedAt: iso(-9), validUntil: iso(20) })), 'STALE', 'stale');
    eq(l.applyResponse(base({ responseId: 'c', respondedAt: iso(-8), validUntil: iso(-9) })), 'INVALID', 'window impossible: validUntil before respondedAt');
    eq(l.applyResponse(base({ responseId: 'd', respondedAt: iso(-30), validUntil: iso(-1) })), 'STALE', 'late (arrives after it expired) is kept, ranked by respondedAt, expired by the engine');
    eq(l.applyResponse(base({ responseId: 'a', status: 'REJECTED' })), 'CONFLICT', 'same id, different payload');
    eq(l.view('A', 'H', T0).response?.responseId, 'b', 'a conflicted id is excluded from every view (neither copy is trusted); the best remaining response is used');
  });

  // ============================================================ 5. evidence environment boundary
  await check('5. trust matrix: the grade is derived from the principal and environment, never from the claim', () => {
    eq(deriveTrustedStatus({ role: 'HOSPITAL', isDemo: true }, 'DEMO'), 'SYNTHETIC_DEMO', 'demo persona in DEMO');
    eq(deriveTrustedStatus({ role: 'HOSPITAL', isDemo: true }, 'PRODUCTION'), 'UNVERIFIED', 'demo persona in PRODUCTION');
    eq(deriveTrustedStatus({ role: 'HOSPITAL', isDemo: false }, 'PRODUCTION'), 'HOSPITAL_CONFIRMED', 'real hospital principal');
    eq(deriveTrustedStatus({ role: 'ADMIN', isDemo: false }, 'PRODUCTION'), 'UNVERIFIED', 'other roles never confirm');
    eq(deriveTrustedStatus({ role: 'HOSPITAL', isDemo: false }, 'PRODUCTION', 'AUTHORIZED_FEED'), 'AUTHORIZED_FEED', 'only a server-configured adapter can grant AUTHORIZED_FEED');
  });

  await check('5. forged sourceType / trustedEvidence / payload.source are discarded at ingestion (AWS handler, real Cognito-shaped principal)', async () => {
    const puts: any[] = [];
    const handler = createIngestionHandler({ store: new LocalStateStore(), now: () => T0, put: async e => { puts.push(JSON.parse(e.detail)); } });
    const claims = { requestContext: { authorizer: { claims: { sub: 'u1', 'cognito:groups': ['HOSPITAL'], 'custom:hospitalId': 'HOSP-BLR-001' } } } };
    const forged = {
      eventId: randomUUID(), eventType: 'hospital.capacity.updated', timestamp: iso(0), version: '1.0', source: { type: 'hospital', id: 'HOSP-BLR-001' },
      payload: { hospitalId: 'HOSP-BLR-001', emergencyStatus: 'AVAILABLE', traumaStatus: 'AVAILABLE', icuStatus: 'AVAILABLE', ventilatorStatus: 'AVAILABLE' },
      metadata: { sourceType: 'AUTHORIZED_FEED', confidence: 1, trustedEvidence: { status: 'AUTHORIZED_FEED', environment: 'PRODUCTION' } },
    };
    const res = await handler({ ...claims, body: JSON.stringify(forged) });
    eq(res.statusCode, 202, 'accepted');
    const stamped = puts[0].metadata.trustedEvidence;
    eq(stamped.status, 'HOSPITAL_CONFIRMED', 'AUTHORIZED_FEED claim did not upgrade the evidence');
    eq(puts[0].metadata.sourceType, 'AUTHORIZED_FEED', 'the claim is preserved only as an informational legacy field');
    // a non-evidence event cannot smuggle a stamp through either
    const other = { eventId: randomUUID(), eventType: 'ambulance.location.updated', timestamp: iso(0), version: '1.0', source: { type: 'ambulance', id: 'AMB-BLR-001' }, payload: { ambulanceId: 'AMB-BLR-001', coordinates: { latitude: 13, longitude: 77.6 }, speedKmh: 10, heading: 0 }, metadata: { sourceType: 'x', trustedEvidence: { status: 'AUTHORIZED_FEED', environment: 'PRODUCTION' } } };
    await handler({ requestContext: { authorizer: { claims: { sub: 'u2', 'cognito:groups': ['AMBULANCE'], 'custom:ambulanceId': 'AMB-BLR-001' } } }, body: JSON.stringify(other) });
    eq(puts[1].metadata.trustedEvidence, undefined, 'stamp stripped from a non-evidence event');
  });

  await check('5. stamping overwrites a client-supplied stamp on local events too', () => {
    const e: any = { eventId: randomUUID(), eventType: 'hospital.acceptance.received', timestamp: iso(0), version: '1.0', source: { type: 'hospital', id: 'H' }, payload: {}, metadata: { sourceType: 'AUTHORIZED_FEED', trustedEvidence: { status: 'AUTHORIZED_FEED', environment: 'PRODUCTION' } } };
    eq(stampTrustedEvidence(e, { role: 'HOSPITAL', isDemo: true }, 'DEMO').metadata.trustedEvidence, { status: 'SYNTHETIC_DEMO', environment: 'DEMO' }, 'demo persona -> SYNTHETIC_DEMO');
    eq(stampTrustedEvidence(e, { role: 'HOSPITAL', isDemo: true }, 'PRODUCTION').metadata.trustedEvidence, { status: 'UNVERIFIED', environment: 'PRODUCTION' }, 'demo persona in production -> UNVERIFIED');
  });

  await check('5. a capacity update that only CLAIMS AUTHORIZED_FEED (no trusted stamp) yields UNVERIFIED evidence -> UNKNOWN', async () => {
    const claimed = applyCapacityUpdate(hospital('H-1', 1), { hospitalId: 'H-1', emergencyStatus: 'AVAILABLE', traumaStatus: 'AVAILABLE', icuStatus: 'AVAILABLE', ventilatorStatus: 'AVAILABLE' },
      { timestamp: iso(-1), source: { type: 'hospital', id: 'H-1' }, metadata: { sourceType: 'AUTHORIZED_FEED', confidence: 1 } }, T0);
    if (claimed.kind !== 'APPLIED') throw new Error('not applied');
    const r = await evaluateDual({ hospitals: [claimed.next], events: [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED')] });
    eq([rule(r, 'H-1', 'HC-OPS-01').outcome, rule(r, 'H-1', 'HC-OPS-01').reasonCode], ['UNKNOWN', 'EVIDENCE_NOT_OPERATIONAL_GRADE'], 'claim ignored');
    const trusted = applyCapacityUpdate(hospital('H-1', 1), { hospitalId: 'H-1', emergencyStatus: 'AVAILABLE', traumaStatus: 'AVAILABLE', icuStatus: 'AVAILABLE', ventilatorStatus: 'AVAILABLE' },
      { timestamp: iso(-1), source: { type: 'hospital', id: 'H-1' }, metadata: { sourceType: 'whatever', trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } } }, T0);
    if (trusted.kind !== 'APPLIED') throw new Error('not applied');
    const r2 = await evaluateDual({ hospitals: [trusted.next], events: [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED')] });
    eq(rule(r2, 'H-1', 'HC-OPS-01').outcome, 'PASS', 'the trusted stamp is what counts');
  });

  await check('5. PRODUCTION: SYNTHETIC_DEMO can never satisfy an operational rule; DEMO may. (capacity, acceptance, listing)', async () => {
    const synth = () => withCapacity(hospital('H-1', 1, { dataStatus: 'SYNTHETIC_DEMO' }), { emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE' }, -1, 'SYNTHETIC_DEMO');
    const events = () => [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED', { trusted: 'SYNTHETIC_DEMO', source: 'SYNTHETIC_DEMO' })];
    const demo = await evaluateParity({ hospitals: [synth()], events: events() }, 'demo');
    eq(cand(demo, 'H-1').verdict, 'ELIGIBLE', 'DEMO: synthetic evidence supports simulation');
    const prod = await evaluateParity({ hospitals: [synth()], events: events(), policy: PROD }, 'production');
    eq(cand(prod, 'H-1').verdict === 'ELIGIBLE', false, 'PRODUCTION: never ELIGIBLE on synthetic evidence');
    eq([rule(prod, 'H-1', 'HC-OPS-01').outcome, rule(prod, 'H-1', 'HC-OPS-01').reasonCode], ['UNKNOWN', 'EVIDENCE_NOT_OPERATIONAL_GRADE'], 'capacity');
    eq(rule(prod, 'H-1', 'HC-ACC-04').reasonCode, 'RESPONSE_EVIDENCE_NOT_TRUSTED', 'acceptance');
    eq([rule(prod, 'H-1', 'HC-CLIN-01').outcome, rule(prod, 'H-1', 'HC-CLIN-01').reasonCode], ['UNKNOWN', 'EVIDENCE_NOT_OPERATIONAL_GRADE'], 'synthetic listing');
    eq(prod.aws.decision.policyHash === demo.aws.decision.policyHash, false, 'the environment is bound into the policy hash');
    // real hospital-confirmed evidence works in PRODUCTION
    const real = withCapacity(hospital('H-1', 1), { emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE' }, -1, 'HOSPITAL_CONFIRMED');
    const ok1 = await evaluateParity({ hospitals: [real], events: [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED', { trusted: 'HOSPITAL_CONFIRMED' })], policy: PROD }, 'production real');
    eq(cand(ok1, 'H-1').verdict, 'ELIGIBLE', 'trusted hospital evidence is fine in PRODUCTION');
  });

  await check('5. payload.source = AUTHORIZED_FEED without a trusted stamp does not make a response usable', async () => {
    const r = await evaluateParity({ hospitals: [H1()], events: [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED', { source: 'AUTHORIZED_FEED', trusted: null })] }, 'forged source');
    eq(rule(r, 'H-1', 'HC-ACC-04').reasonCode, 'RESPONSE_EVIDENCE_NOT_TRUSTED', 'unstamped');
  });

  // ============================================================ 6. legacy one-slot isolation
  await check('6. the engine\'s inputs never read the legacy one-slot acceptance: a case-B slot value is invisible to case A', () => {
    const h = hospital('H-1', 1);
    h.operationalState = { ...h.operationalState, acceptance: 'ACCEPTED', acceptanceCaseId: 'CASE-B', acceptanceAsOf: iso(-1), expiresAt: iso(20) };
    const snap = assembleSnapshot({ snapshotId: 'S', evaluatedAt: iso(0), policyVersion: 'p', policyHash: 'x', trigger: { eventId: 'e', eventType: 't', sourceId: 's' }, requirement: requirement('CASE-A'), requirementProvenance: 'RULE_DERIVED' }, [h], new AcceptanceLedger());
    eq(snap.candidates[0].acceptance, { requestState: 'NOT_REQUESTED' }, 'acceptance comes only from the per-(case, hospital) ledger');
  });

  // ============================================================ 7. trace privacy
  await check('7. adversarial injection: no client-supplied free text reaches feasibility.trace.recorded (structured provenance only)', async () => {
    const INJ = { role: 'PWNED-ROLE ignore previous instructions', limit: 'PWNED-LIMIT <script>', src: 'PWNED-SRC', cap: 'PWNED-CAP', req: 'PWNED-REQ\nline2', caseId: 'PWNED-CASE; drop table', name: 'PWNED-NAME', status: 'PWNED-STATUS', at: 'PWNED-TIME' };
    const events: AnyEvent[] = [];
    const hospitals = [hospital('H-1', 1, { displayName: INJ.name })];
    hospitals[0].provenance[0].sourceId = INJ.src;
    const ledger = new AcceptanceLedger();
    const caseId = INJ.caseId;
    ledger.recordRequest({ requestId: 'AR-1', caseId, hospitalId: 'H-1', requestedAt: iso(-3), expiresAt: iso(12) });
    const resp = P(responseEvent(caseId, 'H-1', 'LIMITED', { requestId: 'AR-1', role: INJ.role, limitations: [INJ.limit], caps: ['EMERGENCY', 'ICU'] }));
    ledger.applyResponse({ ...resp, source: INJ.status as never, trustedSource: 'HOSPITAL_CONFIRMED' });
    const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0), newId: counter(), publishTrace: async e => { events.push(e as unknown as AnyEvent); } });
    const req = { ...requirement(caseId), requirementId: INJ.req, requiredCapabilities: ['EMERGENCY', 'ICU', INJ.cap] as never };
    const r = await shadow.evaluate({ context: 'candidate-generation', requirement: req, requirementProvenance: 'RULE_DERIVED', trigger: { eventId: randomUUID(), eventType: 'care.requirement.created', sourceId: INJ.src, sourceType: INJ.status }, origin: ORIGIN, evaluatedAt: iso(0) });
    if (!r) throw new Error('no result');
    eq(events.length, 1, 'one event');
    const wire = JSON.stringify(events[0]);
    for (const [k, v] of Object.entries(INJ)) ok(!wire.includes(v.split('\n')[0].split(';')[0].split(' ')[0]), `${k} text must not appear in the trace event`);
    ok(FeasibilityTraceRecordedSchema.safeParse(events[0]).success, 'still schema-valid');
    // the responderRole never reaches even the STORED trace's evidence refs
    ok(!JSON.stringify(r.trace).includes('PWNED-ROLE'), 'responderRole is not in the stored trace either');
    // nor does hospital-supplied LIMITATIONS text (fixed: factorAcceptanceKind now reports a count, never the text)
    ok(!JSON.stringify(r.trace).includes(INJ.limit), 'limitations text is not in the stored trace (factor summary/value)');
    const traceCandidates: any[] = r ? r.trace.candidates : [];
    const accFactor: any = (traceCandidates[0]?.contextualFactors ?? []).find((f: any) => f.factorId === 'SF-ACC-KIND');
    ok(!('limitations' in (accFactor?.value ?? {})), 'no raw limitations array on the acceptance factor');
    eq(accFactor?.value?.limitationsCount, 1, 'a structured count is reported instead');
    // structural guarantee: the ref schema is strict and has no free-text `source` field
    const payload = (events[0] as any).payload;
    const withSource = JSON.parse(JSON.stringify(payload));
    const refOwner = withSource.candidates.flatMap((c: any) => c.constraints).find((c: any) => c.evidenceRefs?.length);
    if (refOwner) {
      refOwner.evidenceRefs[0].source = 'client text';
      ok(!FeasibilityTraceRecordedSchema.safeParse({ ...(events[0] as any), payload: withSource }).success, 'a free-text source field is rejected by the schema');
    }
    eq(payload.requirement.unrecognizedCapabilityCount, 1, 'unrecognised capability is counted, not echoed');
    ok(/^h:[0-9a-f]{24}$/.test(payload.caseId), 'non-id-shaped identifiers are replaced by a one-way hash');
    // the schema also forbids the old shape
    ok(!('sourceId' in payload.trigger), 'no free-text trigger source');
  });

  await check('7. every string leaf in a trace event is an enum/code/id/hash/timestamp (allow-list audit of the wire format)', async () => {
    const r = await evaluateDual({ hospitals: [H1()], events: [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'LIMITED', { limitations: ['some text'], caps: ['EMERGENCY', 'TRAUMA', 'ICU'] })] });
    const leaves: string[] = [];
    const walk = (k: string, v: unknown) => { if (typeof v === 'string') leaves.push(`${k}=${v}`); else if (Array.isArray(v)) v.forEach(x => walk(k, x)); else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(kk, vv); };
    walk('', (r.awsEvents[0] as any).payload);
    const SHAPES = /^(?:[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}|\d{4}-\d\d-\d\dT[\d:.]+Z|[0-9a-f]{64}|candidates\[\d+\]\.[A-Za-z.]+|Configurable prototype defaults — not clinical guarantees)$/;
    const bad = leaves.filter(l => !SHAPES.test(l.slice(l.indexOf('=') + 1)));
    eq(bad, [], 'no leaf outside the allowed shapes');
  });

  // ============================================================ 8. policy hash binding
  await check('8. different policies -> different policy hash -> different snapshot and audit hashes; identical policy -> identical hashes', async () => {
    const A = createFreshnessPolicy({ OPERATIONAL_CAPACITY: { maxAgeSeconds: 1800 } });
    const B = createFreshnessPolicy({ OPERATIONAL_CAPACITY: { maxAgeSeconds: 60 } });
    eq(A.version === B.version, true, 'the version STRING collides ("...+overrides") — the string cannot be the identity');
    eq(hashPolicy(A) === hashPolicy(B), false, 'but the policy hash differs');
    const ev = { hospitals: [withCapacity(H1(), { emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE' }, -1)], events: [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED')] };
    const ra = await evaluateParity({ ...ev, policy: A }, 'A'), rb = await evaluateParity({ ...ev, policy: B }, 'B'), ra2 = await evaluateParity({ ...ev, policy: createFreshnessPolicy({ OPERATIONAL_CAPACITY: { maxAgeSeconds: 1800 } }) }, 'A again');
    eq(ra.aws.decision.snapshotHash === rb.aws.decision.snapshotHash, false, 'snapshot hash differs');
    eq(ra.aws.trace.auditHash === rb.aws.trace.auditHash, false, 'audit hash differs');
    eq([ra.aws.decision.snapshotHash, ra.aws.trace.auditHash, ra.aws.decision.policyHash], [ra2.aws.decision.snapshotHash, ra2.aws.trace.auditHash, ra2.aws.decision.policyHash], 'identical policy -> identical hashes');
    eq(ra.aws.trace.policyHash, hashPolicy(A), 'the trace records the policy hash');
    eq((ra.awsEvents[0] as any).payload.policy.hash, hashPolicy(A), 'and so does the trace event');
    // rule-level change with an unchanged version string is still caught
    const C = createFreshnessPolicy({ OPERATIONAL_CAPACITY: { onStale: 'WARN' } });
    eq(hashPolicy(C) === hashPolicy(B) || hashPolicy(C) === hashPolicy(A), false, 'onStale is part of the identity');
  });

  await check('8. the engine refuses a snapshot assembled under a different effective policy', () => {
    const A = createFreshnessPolicy(), B = createFreshnessPolicy({ OPERATIONAL_CAPACITY: { maxAgeSeconds: 60 } }, A.version);
    const snap = assembleSnapshot({ snapshotId: 'S', evaluatedAt: iso(0), policyVersion: A.version, policyHash: hashPolicy(A), trigger: { eventId: 'e', eventType: 't', sourceId: 's' }, requirement: requirement(), requirementProvenance: 'RULE_DERIVED' }, [H1()], new AcceptanceLedger());
    let threw = false;
    try { evaluateFeasibility(snap, B, { decisionId: 'd', traceId: 't' }); } catch (e) { threw = /Policy hash mismatch/.test((e as Error).message); }
    eq(threw, true, 'same version string, different rules -> refused');
  });

  // ============================================================ 9. current destination (shadow-only)
  await check('9. current destination: feasible -> required ICU becomes UNAVAILABLE -> INELIGIBLE; observation only, no route change, no state change, no trace event', async () => {
    const store = new LocalStateStore();
    await store.setHospital(JSON.parse(JSON.stringify(withCapacity(hospital('HOSP-X', 1), { emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE' }, -1))));
    await store.setAmbulance({ ambulanceId: 'AMB-X', status: 'EN_ROUTE_TO_HOSPITAL', assignedPatient: CASE, destinationHospital: 'HOSP-X', currentLocation: ORIGIN, lastUpdated: iso(-1), provenance: [] } as never);
    const reqEv = requestedEvent(CASE, 'HOSP-X'), respEv = responseEvent(CASE, 'HOSP-X', 'ACCEPTED');
    await store.recordEvent(reqEv);
    await store.recordEvent(respEv);
    // Mirror what the lambda cores write inline (see materializedAcceptance.ts): recordEvent alone
    // is the audit trail; the shadow now reads the materialized index.
    await store.putAcceptanceRequest!(CASE, 'HOSP-X', (reqEv as any).payload);
    await store.putAcceptanceResponse!(CASE, 'HOSP-X', withTrust((respEv as any).payload, (respEv as any).metadata));
    const bus = new MemoryBus();
    const shadow = createStoreBackedShadow({ store, bus, mapping: stubMapping(), log: () => undefined, clock: () => iso(0), newId: counter() });
    const trigger = { eventId: randomUUID(), eventType: 'hospital.capacity.updated', sourceId: 'HOSP-X', sourceType: 'hospital' };
    const before = JSON.stringify(await store.getAmbulance('AMB-X'));

    const o1 = await shadow.observeDestination({ caseId: CASE, hospitalId: 'HOSP-X', requirement: requirement(), trigger, origin: ORIGIN, ambulanceId: 'AMB-X' });
    eq([o1?.verdict, o1?.feasible], ['ELIGIBLE', true], 'the held destination is feasible');

    await store.setHospital(JSON.parse(JSON.stringify(withCapacity((await store.getHospital('HOSP-X'))!, { icu: 'UNAVAILABLE' }, -0.5))));
    const o2 = await shadow.observeDestination({ caseId: CASE, hospitalId: 'HOSP-X', requirement: requirement(), trigger, origin: ORIGIN, ambulanceId: 'AMB-X' });
    eq([o2?.verdict, o2?.feasible, o2?.blockingReasons], ['INELIGIBLE', false, ['OPERATIONAL_UNAVAILABLE']], 'no longer feasible');
    eq(o1?.policyHash === o2?.policyHash && !!o1?.snapshotHash && o1?.snapshotHash !== o2?.snapshotHash, true, 'each observation is tied to its evidence snapshot');

    eq(JSON.stringify(await store.getAmbulance('AMB-X')), before, 'NO route/destination change: the ambulance record is byte-identical');
    eq(bus.published.length, 0, 'nothing published: no destination.changed, no route event, no trace event');
    eq(shadow.getTraces().length, 0, 'not a decision trace');
    eq(shadow.getDisagreements().length, 0, 'not compared with legacy');
    eq(shadow.getDestinationObservations(CASE).map(o => o.feasible), [true, false], 'observations recorded for inspection');
  });

  // ============================================================ 10. shadow timeout
  class DelayedMapping implements MappingProvider {
    readonly name = 'delayed';
    constructor(private readonly delayMs: number) {}
    async geocode(): Promise<GeoPoint> { return ORIGIN; }
    async reverseGeocode(coordinates: GeoPoint): Promise<Location> { return { coordinates, address: 'x' } as unknown as Location; }
    async calculateRoute(_req: RouteRequest): Promise<RouteResult> {
      await new Promise(r => setTimeout(r, this.delayMs));
      return { distanceMeters: 1000, durationSeconds: 100, legs: [], provider: 'mock', synthetic: true, trafficAware: false };
    }
    async calculateDistance(): Promise<{ distanceMeters: number }> { return { distanceMeters: 1 }; }
    async calculateETA(): Promise<ETAResult> { return { durationSeconds: 1, calculatedAt: iso(0) }; }
  }
  const evalInput = () => ({ context: 'candidate-generation' as const, requirement: requirement(), requirementProvenance: 'RULE_DERIVED' as const, trigger: { eventId: randomUUID(), eventType: 'care.requirement.created', sourceId: 's' }, origin: ORIGIN, evaluatedAt: iso(0) });

  await check('10. shadow timeout: a deliberately slow provider is abandoned, recorded as TIMEOUT, and its late completion changes nothing', async () => {
    const events: AnyEvent[] = [];
    const ledger = new AcceptanceLedger();
    const shadow = new FeasibilityShadow({ hospitals: () => [H1()], ledger, mapping: new DelayedMapping(400), timeoutMs: 40, log: () => undefined, clock: () => iso(0), newId: counter(), publishTrace: async e => { events.push(e as unknown as AnyEvent); } });
    const started = Date.now();
    const r = await shadow.evaluate(evalInput());
    const elapsed = Date.now() - started;
    eq(r, undefined, 'no result');
    ok(elapsed < 300, `returned within the budget, not after the slow provider (${elapsed} ms)`);
    eq(shadow.getFailures().map(f => f.kind), ['TIMEOUT'], 'recorded as a shadow failure');
    await new Promise(r2 => setTimeout(r2, 600)); // let the abandoned work finish
    eq([shadow.getTraces().length, events.length, shadow.getDisagreements().length], [0, 0, 0], 'the late completion stored/published nothing');
  });

  await check('10. shadow completes in time -> recorded normally; shadow throws -> recorded as ERROR; both leave the caller unaffected', async () => {
    const events: AnyEvent[] = [];
    const fast = new FeasibilityShadow({ hospitals: () => [H1()], ledger: new AcceptanceLedger(), mapping: new DelayedMapping(5), timeoutMs: 500, log: () => undefined, clock: () => iso(0), newId: counter(), publishTrace: async e => { events.push(e as unknown as AnyEvent); } });
    ok(!!(await fast.evaluate(evalInput())), 'result');
    eq([fast.getTraces().length, events.length, fast.getFailures().length], [1, 1, 0], 'recorded');
    const broken = new FeasibilityShadow({ hospitals: () => { throw new Error('boom'); }, ledger: new AcceptanceLedger(), mapping: stubMapping(), timeoutMs: 500, log: () => undefined });
    eq(await broken.evaluate(evalInput()), undefined, 'contained');
    eq(broken.getFailures().map(f => f.kind), ['ERROR'], 'recorded as ERROR');
  });

  await check('10. the pure package has no timers: timeouts live only in the service layer', () => {
    const root = path.resolve(__dirname, '../../packages/feasibility/src');
    for (const f of fs.readdirSync(root).filter(x => x.endsWith('.ts'))) {
      const code = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      ok(!/setTimeout|setInterval|Promise\.race|Date\.now\(|new Date\(\)/.test(code), `${f} must not use timers or the wall clock`);
    }
  });

  // ============================================================ ledger robustness (input to blocker 2)
  await check('2. a poisoned / malformed / missing history never prevents the rest from loading', () => {
    const good = requestedEvent(CASE, 'H-1'), goodResp = responseEvent(CASE, 'H-1', 'ACCEPTED');
    const poison: any[] = [
      { eventId: 'p1', eventType: 'hospital.acceptance.received', timestamp: iso(0), payload: null },
      { eventId: 'p2', eventType: 'hospital.acceptance.received', timestamp: iso(0), payload: { responseId: 5, status: 'ACCEPTED' } },
      { eventId: 'p3', eventType: 'hospital.acceptance.requested', timestamp: iso(0), payload: 'garbage' },
      { eventId: 'p4', eventType: 'hospital.acceptance.received', timestamp: iso(0) },
      { eventId: 'p5', eventType: 'hospital.acceptance.received', timestamp: iso(0), payload: { responseId: 'x', requestId: 'r', caseId: CASE, hospitalId: 'H-1', status: 'ACCEPTED', respondedAt: 'not-a-date', validUntil: 'nope' } },
    ];
    const l = AcceptanceLedger.fromEvents([...poison, good, goodResp, ...poison]);
    eq(l.view(CASE, 'H-1', T0).response?.status, 'ACCEPTED', 'good events survive the poison');
    eq(l.view(CASE, 'H-1', T0).requestState, 'OUTSTANDING', 'request survives');
    eq(AcceptanceLedger.fromEvents([]).view(CASE, 'H-1', T0), { requestState: 'NOT_REQUESTED' }, 'missing history -> empty view, no throw');
    // a response payload missing its arrays (which legacy never reads) no longer throws
    const noArrays = { ...P(goodResp) }; delete noArrays.acceptedCapabilities; delete noArrays.limitations;
    eq(new AcceptanceLedger().applyResponse(withTrust(noArrays, undefined)), 'APPLIED', 'missing arrays tolerated');
  });

  console.log(`\n[Test] Feasibility remediation: ${passCount()} checks passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
