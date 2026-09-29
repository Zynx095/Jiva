/**
 * PROMOTION PREPARATION (the engine stays shadow-only). Pins facts an authoritative mode would depend on:
 *  - DynamoDB case history is paginated, never silently truncated
 *  - the 500-event history window is NOT safe for hospital-wide UNAVAILABLE (documented blocker, demonstrated)
 *  - static capability listings: Policy 1 (Option B) behaviour, approved and pinned
 *  - acceptance cancellation: schema, ledger, engine, replay equivalence, not externally submittable
 *  - official simulations never send a placeholder requestId
 *  - soak counters classify forced errors / timeouts / policy mismatch
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { AnyEvent } from '../../packages/event-schema/src';
import { AnyEventSchema } from '../../packages/event-schema/src';
import type { ETAResult, Location, MappingProvider, RouteRequest, RouteResult } from '../../packages/mapping/src';
import type { GeoPoint } from '../../packages/domain-models/src';
import { AcceptanceLedger, withTrust } from '../../services/api/src/feasibility/acceptanceLedger';
import { FeasibilityShadow } from '../../services/api/src/feasibility/shadow';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { DynamoStateStore } from '../../services/api/src/infrastructure/stateStore/DynamoStateStore';
import { createStoreBackedShadow, loadLedger } from '../../services/api/src/lambdas/core/deps';
import { authorizeEventSubmission } from '../../services/api/src/authorizationPolicy';
import {
  CASE, cand, check, counter, eq, evaluateDual, evaluateParity, hospital, iso, MemoryBus, ok, ORIGIN, passCount,
  requestedEvent, requirement, responseEvent, rule, stubMapping, T0, withCapacity,
} from './helpers/feasibilityHarness';

const P = (e: AnyEvent) => (e as any).payload;
const cancelled = (caseId: string, hospitalId: string, requestId: string, atMin = -1): AnyEvent => ({
  eventId: randomUUID(), eventType: 'hospital.acceptance.cancelled', timestamp: iso(atMin), version: '1.0', source: { type: 'system', id: 'acceptance-protocol' },
  payload: { requestId, caseId, hospitalId, cancelledAt: iso(atMin), reason: 'DESTINATION_FINALIZED_ELSEWHERE' },
}) as unknown as AnyEvent;

async function main() {
  console.log('[Test] Promotion preparation (shadow-only): history, capability policy, cancellation, simulations, soak\n');

  // ============================================================ history model
  await check('history: DynamoStateStore.queryEventsByCase follows LastEvaluatedKey (the ascending sort key means an unpaginated read drops the NEWEST events)', async () => {
    const pages = [
      { Items: [{ data: { n: 1 } }, { data: { n: 2 } }], LastEvaluatedKey: { PK: 'a' } },
      { Items: [{ data: { n: 3 } }], LastEvaluatedKey: { PK: 'b' } },
      { Items: [{ data: { n: 4 } }] },
    ];
    const seenKeys: unknown[] = []; const consistent: unknown[] = [];
    const dyn = new DynamoStateStore({ tableName: 't', region: 'ap-south-1' });
    (dyn as any).docClient = { send: async (cmd: any) => { seenKeys.push(cmd.input.ExclusiveStartKey); consistent.push(cmd.input.ConsistentRead); return pages[seenKeys.length - 1]; } };
    eq((await dyn.queryEventsByCase('C')).map((e: any) => e.n), [1, 2, 3, 4], 'all pages, in order');
    eq(seenKeys, [undefined, { PK: 'a' }, { PK: 'b' }], 'each page continued from the previous key');
    eq(consistent, [true, true, true], 'strongly consistent reads');
    const runaway = new DynamoStateStore({ tableName: 't', region: 'ap-south-1' });
    (runaway as any).docClient = { send: async () => ({ Items: [{ data: {} }], LastEvaluatedKey: { PK: 'x' } }) };
    let threw = false;
    try { await runaway.queryEventsByCase('C'); } catch (e) { threw = /refusing to return a truncated history/.test((e as Error).message); }
    eq(threw, true, 'a runaway partition is an error, never a silent truncation');
  });

  await check('history: KNOWN BLOCKER — a hospital-wide UNAVAILABLE for ANOTHER case is invisible once it falls outside the 500 most recent events', async () => {
    const store = new LocalStateStore();
    const h = withCapacity(hospital('H-1', 1), { emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE' }, -1);
    await store.setHospital(JSON.parse(JSON.stringify(h)));
    const unavailable = responseEvent('CASE-OTHER', 'H-1', 'UNAVAILABLE', { respondedMin: -1, validMin: 40 });
    const mine = [requestedEvent(CASE, 'H-1', -3, 15), responseEvent(CASE, 'H-1', 'ACCEPTED', { respondedMin: -2 })];
    const record = async (events: AnyEvent[]) => { for (const e of events) await store.recordEvent(e); };
    await record([unavailable]);
    const evaluate = async (ledger: () => Promise<AcceptanceLedger>) => {
      const s = new FeasibilityShadow({ hospitals: () => store.listHospitals(), ledger, mapping: stubMapping(), log: () => undefined, clock: () => iso(0), newId: counter() });
      const r = await s.evaluate({ context: 'candidate-generation', requirement: requirement(), requirementProvenance: 'RULE_DERIVED', trigger: { eventId: randomUUID(), eventType: 'care.requirement.created', sourceId: 's' }, origin: ORIGIN, evaluatedAt: iso(0) });
      return r!.decision.candidates[0];
    };
    await record(mine);
    // control: inside the window the shadow sees it
    eq((await evaluate(() => loadLedger(store, CASE))).verdict, 'INELIGIBLE', 'inside the window: UNAVAILABLE seen -> INELIGIBLE');
    // 600 unrelated events (GPS pings) push it out of the latest-500 window
    for (let i = 0; i < 600; i++) {
      await store.recordEvent({ eventId: randomUUID(), eventType: 'ambulance.location.updated', timestamp: iso(-1, T0 + i), version: '1.0', source: { type: 'ambulance', id: 'AMB-1' }, payload: { ambulanceId: 'AMB-1', coordinates: { latitude: 13, longitude: 77.6 }, speedKmh: 10, heading: 0 } } as unknown as AnyEvent);
    }
    const windowed = await evaluate(() => loadLedger(store, CASE));
    const complete = await evaluate(async () => AcceptanceLedger.fromEvents(await store.listRecentEvents(100000)));
    eq(complete.verdict, 'INELIGIBLE', 'with the COMPLETE history the hospital is (correctly) INELIGIBLE');
    eq(windowed.verdict, 'ELIGIBLE', 'with the 500-event window the same hospital is ELIGIBLE — unsafe direction; an authoritative engine must not run on this');
  });

  // ============================================================ static capability policy (pinned)
  await check('capability policy (Policy 1 / Option B, pinned): a static listing satisfies the capability rule only for PUBLIC_LISTED / HOSPITAL_CONFIRMED / AUTHORIZED_FEED; HISTORICAL / UNVERIFIED / UNKNOWN / NOT_DISCLOSED are unusable on their own', async () => {
    const outcomes: Record<string, string> = {};
    for (const ds of ['HISTORICAL', 'UNVERIFIED', 'PUBLIC_LISTED', 'HOSPITAL_CONFIRMED', 'AUTHORIZED_FEED', 'UNKNOWN', 'NOT_DISCLOSED']) {
      const h: any = hospital('H-1', 1);
      h.evidence = { capabilities: { value: { emergency: true, trauma: true, icu: true }, source: 'src', sourceType: 'X', observedAt: iso(-100), confidence: 0.5, dataStatus: ds } };
      const r = await evaluateDual({ hospitals: [h], events: [] });
      outcomes[ds] = `${rule(r, 'H-1', 'HC-CLIN-01').outcome}/${rule(r, 'H-1', 'HC-CLIN-01').reasonCode}`;
    }
    eq(outcomes, {
      HISTORICAL: 'UNKNOWN/EVIDENCE_NOT_OPERATIONAL_GRADE', UNVERIFIED: 'UNKNOWN/EVIDENCE_NOT_OPERATIONAL_GRADE',
      PUBLIC_LISTED: 'PASS/CAPABILITY_LISTED', HOSPITAL_CONFIRMED: 'PASS/CAPABILITY_LISTED', AUTHORIZED_FEED: 'PASS/CAPABILITY_LISTED',
      UNKNOWN: 'UNKNOWN/NOT_DISCLOSED', NOT_DISCLOSED: 'UNKNOWN/NOT_DISCLOSED',
    }, 'Policy 1 (Option B) pinned behaviour');
    // but a listing alone can never make a hospital ELIGIBLE: acceptance and live status are still required
    const h: any = hospital('H-1', 1); h.evidence = { capabilities: { value: { emergency: true, trauma: true, icu: true }, source: 's', sourceType: 'X', observedAt: iso(-100), confidence: 0.1, dataStatus: 'UNVERIFIED' } };
    const r = await evaluateDual({ hospitals: [h], events: [] });
    eq(cand(r, 'H-1').verdict === 'ELIGIBLE', false, 'never ELIGIBLE on a listing alone');
  });

  // ============================================================ cancellation
  await check('cancellation: the event is schema-valid, system-generated only (no role can submit it)', () => {
    const e = cancelled(CASE, 'H-1', 'AR-1');
    ok(AnyEventSchema.safeParse(e).success, 'schema-valid');
    for (const auth of [{ userId: 'a', role: 'ADMIN' }, { userId: 'm', role: 'MANAGEMENT' }, { userId: 'h', role: 'HOSPITAL', hospitalId: 'H-1' }] as any[]) {
      ok(authorizeEventSubmission(auth, e) !== null, `${auth.role} must not submit a cancellation`);
    }
    ok(!AnyEventSchema.safeParse({ ...e, payload: { ...P(e), reason: 'free text reason' } }).success, 'reason is an enum, not free text');
  });

  await check('cancellation: a cancelled request makes every response to it unusable; the engine says why (local === AWS)', async () => {
    const req = requestedEvent(CASE, 'H-1'), id = P(req).requestId;
    const a = await evaluateParity({ hospitals: [hospital('H-1', 1)], events: [req, responseEvent(CASE, 'H-1', 'ACCEPTED'), cancelled(CASE, 'H-1', id)] }, 'cancel after response');
    eq([cand(a, 'H-1').verdict, rule(a, 'H-1', 'HC-ACC-04').reasonCode], ['PENDING_ACCEPTANCE', 'RESPONSE_REQUEST_CANCELLED'], 'response ignored');
    const b = await evaluateParity({ hospitals: [hospital('H-1', 1)], events: [req, cancelled(CASE, 'H-1', id)] }, 'cancel, no response');
    eq(rule(b, 'H-1', 'HC-ACC-04').reasonCode, 'REQUEST_CANCELLED_NO_RESPONSE', 'no response');
    // a NEW request after the cancellation is a fresh exchange and can be answered
    const req2 = requestedEvent(CASE, 'H-1', -1, 15); P(req2).requestId = 'AR-2';
    const c = await evaluateParity({ hospitals: [hospital('H-1', 1)], events: [req, cancelled(CASE, 'H-1', id, -2), req2, responseEvent(CASE, 'H-1', 'ACCEPTED', { respondedMin: -0.5, requestId: 'AR-2' })] }, 'new request');
    eq(cand(c, 'H-1').verdict, 'ELIGIBLE', 're-request after cancellation works');
  });

  await check('cancellation: order-independent (cancel may arrive before the request or the response); live === replay', () => {
    const req = requestedEvent(CASE, 'H-1'), resp = responseEvent(CASE, 'H-1', 'ACCEPTED'), can = cancelled(CASE, 'H-1', P(req).requestId);
    const mk = (order: AnyEvent[]) => {
      const l = new AcceptanceLedger();
      for (const e of order) {
        if (e.eventType === 'hospital.acceptance.requested') l.recordRequest(P(e));
        else if (e.eventType === 'hospital.acceptance.cancelled') l.applyCancellation(P(e));
        else l.applyResponse(withTrust(P(e), (e as any).metadata));
      }
      return l;
    };
    const orders = [[req, resp, can], [can, req, resp], [resp, can, req], [can, resp, req]];
    const ref = mk(orders[0]);
    for (const o of orders) {
      eq(mk(o).snapshot() === ref.snapshot(), true, 'live state identical in any order');
      eq(AcceptanceLedger.fromEvents(o.map(e => ({ ...(e as any) }))).snapshot() === ref.snapshot(), true, 'replay identical');
    }
    eq(ref.view(CASE, 'H-1', T0).requestState, 'REQUEST_CANCELLED', 'state');
  });

  // ============================================================ simulations
  await check('simulations: no official script sends a placeholder requestId; every response names the request the flow generated', () => {
    const dir = path.resolve(__dirname, '../../scripts');
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      if (!src.includes("'hospital.acceptance.received'")) continue;
      ok(!/requestId:\s*['"`]/.test(src), `${f}: literal requestId placeholder`);
      ok(/requestIdFor\(|requestIdOf\(/.test(src) || /async function requestIdFor/.test(src), `${f}: must resolve the real requestId`);
    }
  });

  // ============================================================ soak counters
  class HookMapping implements MappingProvider {
    readonly name = 'hook';
    constructor(private readonly hook: () => Promise<void> | void) {}
    async geocode(): Promise<GeoPoint> { return ORIGIN; }
    async reverseGeocode(coordinates: GeoPoint): Promise<Location> { return { coordinates, address: 'x' } as unknown as Location; }
    async calculateRoute(_r: RouteRequest): Promise<RouteResult> { await this.hook(); return { distanceMeters: 1000, durationSeconds: 100, legs: [], provider: 'mock', synthetic: true, trafficAware: false }; }
    async calculateDistance(): Promise<{ distanceMeters: number }> { return { distanceMeters: 1 }; }
    async calculateETA(): Promise<ETAResult> { return { durationSeconds: 1, calculatedAt: iso(0) }; }
  }
  const input = () => ({ context: 'candidate-generation' as const, requirement: requirement(), requirementProvenance: 'RULE_DERIVED' as const, trigger: { eventId: randomUUID(), eventType: 'care.requirement.created', sourceId: 's' }, origin: ORIGIN, evaluatedAt: iso(0) });

  await check('soak: forced exception, timeout, sink failure, policy mismatch and malformed evidence are each classified; none escapes to the caller', async () => {
    const hospitals = [hospital('H-1', 1)];
    const mk = (mapping: MappingProvider, over: Partial<ConstructorParameters<typeof FeasibilityShadow>[0]> = {}) =>
      new FeasibilityShadow({ hospitals: () => hospitals, ledger: new AcceptanceLedger(), mapping, log: () => undefined, clock: () => iso(0), newId: counter(), timeoutMs: 60, ...over });

    const healthy = mk(new HookMapping(() => undefined));
    await healthy.evaluate(input());
    eq([healthy.getSoakSummary().completed, healthy.getSoakSummary().wouldHaveFallenBack], [1, 0], 'healthy');

    const thrower = mk(new HookMapping(() => { throw new Error('provider exploded'); }));
    // route failure is CONTAINED INSIDE the evaluation as an unknown ETA (D1): it is not an error
    ok(!!(await thrower.evaluate(input())), 'a failed route yields a result with unknown ETA');
    eq(thrower.getSoakSummary().errors, 0, 'route failure is not a shadow error');

    const broken = mk(new HookMapping(() => undefined), { hospitals: () => { throw new Error('store down'); } });
    eq(await broken.evaluate(input()), undefined, 'exception contained');
    eq([broken.getSoakSummary().errors, broken.getSoakSummary().wouldHaveFallenBack], [1, 1], 'exception counted');

    const slow = mk(new HookMapping(() => new Promise(r => setTimeout(r, 300))));
    eq(await slow.evaluate(input()), undefined, 'timeout contained');
    eq([slow.getSoakSummary().timeouts, slow.getSoakSummary().wouldHaveFallenBack], [1, 1], 'timeout counted');
    await new Promise(r => setTimeout(r, 400));

    const sink = mk(new HookMapping(() => undefined), { publishTrace: async () => { throw new Error('sink down'); } });
    ok(!!(await sink.evaluate(input())), 'the decision is still returned');
    eq([sink.getSoakSummary().traceSinkFailures, sink.getSoakSummary().completed], [1, 1], 'sink failure counted; evaluation still completed');

    let shadowRef: FeasibilityShadow;
    const drift = mk(new HookMapping(() => { shadowRef.policy.rules.OPERATIONAL_CAPACITY.maxAgeSeconds = 1; })); // policy changed mid-evaluation, same version string
    shadowRef = drift;
    eq(await drift.evaluate(input()), undefined, 'policy mismatch contained');
    eq([drift.getSoakSummary().policyMismatches, drift.getSoakSummary().errors], [1, 1], 'policy mismatch classified');

    const malformed = mk(new HookMapping(() => undefined), { hospitals: () => [{ hospitalId: 'H-BAD' } as never] });
    eq(await malformed.evaluate(input()), undefined, 'malformed hospital evidence contained');
    eq(malformed.getSoakSummary().errors, 1, 'malformed evidence counted');
    for (const s of [healthy, broken, slow, sink, drift, malformed]) eq(s.getSoakSummary().legacyAuthoritative, true, 'legacy stays authoritative');
  });

  // ============================================================ P1 replay/derived-state determinism (end-to-end)
  await check('replay determinism, end-to-end: events -> materialized records -> snapshot -> verdict/hash are identical across every valid arrival order', async () => {
    const req1 = requestedEvent(CASE, 'H-1', -10, 30), req2 = requestedEvent(CASE, 'H-2', -10, 30);
    const resp1 = responseEvent(CASE, 'H-1', 'LIMITED', { caps: ['EMERGENCY', 'TRAUMA'], respondedMin: -5 });
    const resp2 = responseEvent(CASE, 'H-2', 'ACCEPTED', { respondedMin: -3 });
    const wide = responseEvent('CASE-OTHER', 'H-1', 'UNAVAILABLE', { respondedMin: -8, validMin: 25 }); // hospital-wide; applies regardless of order
    const orders: AnyEvent[][] = [
      [req1, req2, resp1, resp2, wide],
      [req2, req1, wide, resp2, resp1],
      [wide, req1, resp1, req2, resp2],
      [req1, resp1, req2, wide, resp2],
    ];
    const results = [];
    for (const events of orders) {
      const store = new LocalStateStore();
      await store.setHospital(JSON.parse(JSON.stringify(hospital('H-1', 1))));
      await store.setHospital(JSON.parse(JSON.stringify(hospital('H-2', 2))));
      for (const e of events) {
        await store.recordEvent(e);
        const p: any = (e as any).payload;
        if (e.eventType === 'hospital.acceptance.requested') await store.putAcceptanceRequest!(p.caseId, p.hospitalId, p);
        else if (e.eventType === 'hospital.acceptance.received') await store.putAcceptanceResponse!(p.caseId, p.hospitalId, withTrust(p, (e as any).metadata));
      }
      const bus = new MemoryBus();
      const shadow = createStoreBackedShadow({ store, bus, mapping: stubMapping(), log: () => undefined, clock: () => iso(0), newId: counter() });
      const r = await shadow.evaluate({ context: 'candidate-generation', requirement: requirement(), requirementProvenance: 'RULE_DERIVED', trigger: { eventId: '11111111-1111-4111-8111-111111111111', eventType: 'care.requirement.created', sourceId: 's' }, origin: ORIGIN, evaluatedAt: iso(0) });
      results.push(r!);
    }
    const ref = results[0];
    for (let i = 1; i < results.length; i++) {
      eq(results[i].decision, ref.decision, `order ${i}: decision identical`);
      eq(results[i].decision.snapshotHash, ref.decision.snapshotHash, `order ${i}: snapshot hash identical`);
      eq(results[i].trace.auditHash, ref.trace.auditHash, `order ${i}: audit hash identical`);
    }
    eq(cand({ aws: ref } as any, 'H-1').verdict, 'INELIGIBLE', 'H-1 correctly fails on LIMITED missing ICU, in every order');
    // Documented ordering rule: WITHIN one (case, hospital) key, later respondedAt wins, ties broken
    // by restrictiveness then responseId (compareResponses); requests order by requestedAt then
    // requestId. Across DIFFERENT keys, order never matters -- proven above by permuting requests,
    // responses and an unrelated hospital-wide fact all against each other.
  });

  console.log(`\n[Test] Promotion preparation: ${passCount()} checks passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
