/**
 * AWS ingestion parity with the local POST /api/events rules (schema, future timestamps, RBAC,
 * acceptance correlation), plus the DynamoDB write-guard fix and the realtime-broadcast exclusion.
 * Nothing here touches a network: stores/buses are in-memory doubles or fakes.
 */
import { randomUUID } from 'crypto';
import type { AnyEvent } from '../../packages/event-schema/src';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { DynamoStateStore, HOSPITAL_WRITE_GUARD_FLOOR } from '../../services/api/src/infrastructure/stateStore/DynamoStateStore';
import { createIngestionHandler } from '../../services/api/src/lambdas/core/ingestionCore';
import { applyAcceptanceResponse, applyCapacityUpdate } from '../../services/api/src/stateTransitions';
import { CASE, check, eq, evaluateDual, hospital, iso, ok, passCount, requestedEvent, responseEvent, T0 } from './helpers/feasibilityHarness';

type Claims = Record<string, unknown> | undefined;
const claims = (group: string, extra: Record<string, string> = {}): Claims => ({ sub: `user-${group}`, 'cognito:groups': [group], ...extra });
const call = (h: ReturnType<typeof createIngestionHandler>, c: Claims, body: unknown) =>
  h({ requestContext: c ? { authorizer: { claims: c } } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) });
const parse = (r: { body: string }) => JSON.parse(r.body);

const withZ = (e: AnyEvent) => JSON.parse(JSON.stringify(e));
const capacity = (hospitalId: string, timestamp = iso(0), source = { type: 'hospital', id: hospitalId }) => ({
  eventId: randomUUID(), eventType: 'hospital.capacity.updated', timestamp, version: '1.0', source,
  payload: { hospitalId, emergencyStatus: 'UNAVAILABLE', traumaStatus: 'UNKNOWN', icuStatus: 'UNKNOWN', ventilatorStatus: 'UNKNOWN' },
});

async function main() {
  console.log('[Test] AWS ingestion RBAC / correlation and DynamoDB write guard\n');

  const puts: { detailType: string; detail: string; resource: string }[] = [];
  const store = new LocalStateStore();
  // The handler's clock is pinned to the harness time base so request expiry is deterministic.
  const handler = createIngestionHandler({ store, now: () => T0, put: async e => { puts.push(e); } });

  // outstanding request for CASE / HOSP-BLR-001, recorded the way the emergency lambda records it
  await store.recordEvent(requestedEvent(CASE, 'HOSP-BLR-001', 0, 15));
  await store.recordEvent({ ...requestedEvent('CASE-OLD', 'HOSP-BLR-001', -60, 15) });          // expired 45 min ago
  await store.recordEvent({ ...requestedEvent('CASE-OTHER', 'HOSP-BLR-002', 0, 15) });          // for another hospital

  const acc = (caseId: string, hospitalId: string, o: object = {}) => {
    const e: any = withZ(responseEvent(caseId, hospitalId, 'ACCEPTED', { respondedMin: 0 }));
    return { ...e, ...o }; // timestamp = respondedAt = T0, validUntil = T0 + 30 min
  };

  await check('401: unauthenticated callers are rejected before anything else', async () => {
    const r = await call(handler, undefined, acc(CASE, 'HOSP-BLR-001'));
    eq(r.statusCode, 401, 'status');
    eq(puts.length, 0, 'nothing published');
  });

  await check('400: malformed input never reaches the bus and never leaks internals', async () => {
    const H = claims('ADMIN');
    for (const [name, body, expected] of [
      ['invalid JSON', '{not json', 'invalid_body'],
      ['array body', '[]', 'invalid_body'],
      ['missing ids', {}, 'invalid_event'],
      ['unknown type', { eventId: randomUUID(), eventType: 'made.up', timestamp: iso(0), source: { type: 'system', id: 'x' }, payload: {} }, 'unknown_event_type'],
      ['bad payload', { ...capacity('HOSP-BLR-001'), payload: { hospitalId: 1 } }, 'validation_failed'],
      ['future timestamp', capacity('HOSP-BLR-001', iso(60)), 'validation_failed'],
    ] as const) {
      const r = await call(handler, H, body);
      eq([r.statusCode, parse(r).error], [400, expected], name);
      ok(!/at \w|node_modules|\\\\/.test(r.body), `${name}: no stack trace`);
    }
    eq(puts.length, 0, 'nothing published');
  });

  await check('403: same RBAC as local (scope, source match, system-only event types)', async () => {
    const cases: [string, Claims, unknown][] = [
      ['patient posts hospital capacity', claims('PATIENT', { 'custom:caseId': CASE }), capacity('HOSP-BLR-001')],
      ['hospital 1 posts capacity for hospital 2', claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-BLR-001' }), capacity('HOSP-BLR-002')],
      ['hospital source/payload mismatch', claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-BLR-001' }), capacity('HOSP-BLR-002', undefined, { type: 'hospital', id: 'HOSP-BLR-001' })],
      ['ambulance posts an acceptance', claims('AMBULANCE', { 'custom:ambulanceId': 'AMB-BLR-001' }), acc(CASE, 'HOSP-BLR-001')],
      ['admin posts system event destination.changed', claims('ADMIN'), { eventId: randomUUID(), eventType: 'destination.changed', timestamp: iso(0), version: '1.0', source: { type: 'system', id: 'routing-engine' }, payload: { ambulanceId: 'A', hospitalId: 'H', reason: 'x' } }],
      ['management posts hospital.candidate.generated', claims('MANAGEMENT'), { eventId: randomUUID(), eventType: 'hospital.candidate.generated', timestamp: iso(0), version: '1.0', source: { type: 'system', id: 'eligibility-engine' }, payload: { caseId: CASE, candidates: [] } }],
    ];
    for (const [name, c, body] of cases) {
      const r = await call(handler, c, body);
      eq([name, r.statusCode], [name, 403], name);
    }
    eq(puts.length, 0, 'nothing published');
  });

  await check('403: a genuine feasibility trace event cannot be injected by ANY role (admin included)', async () => {
    const r = await evaluateDual({ hospitals: [hospital('H-1', 1)], events: [] });
    const trace = withZ(r.awsEvents[0]);
    trace.timestamp = iso(0); // inside the handler's clock so only RBAC can reject it
    ok(!!trace.payload && trace.eventType === 'feasibility.trace.recorded', 'a genuine, otherwise valid trace event');
    for (const g of ['ADMIN', 'MANAGEMENT', 'HOSPITAL', 'AMBULANCE', 'PATIENT']) {
      const res = await call(handler, claims(g, { 'custom:hospitalId': 'H-1', 'custom:caseId': CASE }), trace);
      eq(res.statusCode, 403, `${g} injecting a trace`);
      ok(/system-generated/.test(parse(res).message), `${g}: reason`);
    }
    eq(puts.length, 0, 'nothing published');
  });

  await check('409: acceptance correlation — only an answer to an open request for that case AND hospital', async () => {
    const H1 = claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-BLR-001' });
    const noRequest = await call(handler, H1, acc('CASE-NEVER', 'HOSP-BLR-001'));
    eq([noRequest.statusCode, parse(noRequest).error], [409, 'no_outstanding_request'], 'never requested');
    const expired = await call(handler, H1, acc('CASE-OLD', 'HOSP-BLR-001'));
    eq(expired.statusCode, 409, 'request expired');
    const wrongHospital = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-BLR-001' }), acc('CASE-OTHER', 'HOSP-BLR-001'));
    eq(wrongHospital.statusCode, 409, 'request was addressed to another hospital');
    eq(puts.length, 0, 'nothing published');
  });

  await check('400: a response claiming non-operational provenance is rejected (evidence taxonomy enforced at the door)', async () => {
    for (const src of ['PUBLIC_LISTED', 'HISTORICAL', 'UNVERIFIED', 'GOVERNMENT_REGISTRY']) {
      const e = acc(CASE, 'HOSP-BLR-001');
      e.payload.source = src;
      const r = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-BLR-001' }), e);
      eq([src, r.statusCode, parse(r).error], [src, 400, 'validation_failed'], `source ${src}`);
    }
    eq(puts.length, 0, 'nothing published');
  });

  await check('202: a valid, correlated, scoped acceptance is published as the VALIDATED event with correlation ids', async () => {
    const e = acc(CASE, 'HOSP-BLR-001');
    e.payload.junk = 'smuggled';
    e.smuggled = 'top-level';
    const r = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-BLR-001' }), e);
    eq([r.statusCode, parse(r).status], [202, 'accepted'], 'accepted');
    eq(puts.length, 1, 'published once');
    const detail = JSON.parse(puts[0].detail);
    eq([puts[0].detailType, puts[0].resource, detail.correlationId, detail.causationId], ['hospital.acceptance.received', CASE, CASE, e.eventId], 'correlation');
    ok(!('smuggled' in detail) && !('junk' in detail.payload), 'unknown fields stripped by schema validation');
    // management/admin also pass their own checks
    const adminCap = await call(handler, claims('ADMIN'), capacity('HOSP-BLR-003'));
    eq(adminCap.statusCode, 202, 'admin capacity');
  });

  await check('the deployed ingestion wrapper enforces the same gate (401 without claims, 400 on garbage) with no network', async () => {
    const { handler: deployed } = await import('../../services/api/src/lambdas/ingestion');
    eq((await deployed({ body: '{}' })).statusCode, 401, 'no claims');
    const bad = await deployed({ requestContext: { authorizer: { claims: claims('ADMIN') } }, body: '{bad' });
    eq(bad.statusCode, 400, 'garbage');
  });

  // ---------------------------------------------------------------- DynamoDB write guard

  await check('DynamoDB hospital write guard: a capacity update no longer stamps "now" and cannot cause a later acceptance to be dropped', async () => {
    type Item = Record<string, any>;
    const table = new Map<string, Item>();
    const fakeDoc = {
      send: async (cmd: any) => {
        const input = cmd.input;
        if (cmd.constructor.name !== 'PutCommand') return {};
        const key = `${input.Item.PK}|${input.Item.SK}`;
        const existing = table.get(key);
        if (input.ConditionExpression?.includes('#confirmed <= :newConfirmed') && existing && !(existing.lastConfirmedAt <= input.ExpressionAttributeValues[':newConfirmed'])) {
          const err: any = new Error('conditional check failed'); err.name = 'ConditionalCheckFailedException'; throw err;
        }
        table.set(key, input.Item);
        return {};
      },
    };
    const dyn = new DynamoStateStore({ tableName: 't', region: 'ap-south-1' });
    (dyn as any).docClient = fakeDoc;
    const base = hospital('HOSP-X', 1);

    await dyn.setHospital(base);                                                    // seed, never confirmed
    eq(table.get('HOSPITAL#HOSP-X|STATE#CURRENT')!.lastConfirmedAt, HOSPITAL_WRITE_GUARD_FLOOR, 'seed does not stamp now');

    const nowMs = Date.now();
    const cap = applyCapacityUpdate(base, { hospitalId: 'HOSP-X', emergencyStatus: 'AVAILABLE', traumaStatus: 'AVAILABLE', icuStatus: 'AVAILABLE', ventilatorStatus: 'AVAILABLE' },
      { timestamp: iso(0, nowMs), source: { type: 'hospital', id: 'HOSP-X' } }, nowMs);
    ok(cap.kind === 'APPLIED', 'capacity applied');
    await dyn.setHospital((cap as any).next);                                       // capacity processed "just now"
    eq(table.get('HOSPITAL#HOSP-X|STATE#CURRENT')!.lastConfirmedAt, HOSPITAL_WRITE_GUARD_FLOOR, 'capacity update does not stamp now either');

    // an acceptance the hospital sent BEFORE that capacity update was processed (earlier respondedAt)
    const payload: any = (responseEvent('CASE-Z', 'HOSP-X', 'ACCEPTED', { respondedMin: -1 }) as any).payload;
    payload.respondedAt = iso(-1, nowMs); payload.validUntil = iso(30, nowMs);
    const acc2 = applyAcceptanceResponse((cap as any).next, payload, { sourceType: 'hospital', sourceId: 'HOSP-X' }, nowMs);
    ok(acc2.kind === 'APPLIED', 'acceptance applied');
    await dyn.setHospital((acc2 as any).next);
    eq(table.get('HOSPITAL#HOSP-X|STATE#CURRENT')!.data.operationalState.acceptance, 'ACCEPTED', 'acceptance persisted (previously silently dropped)');

    // ordering protection is intact: an OLDER acceptance can no longer overwrite the newer one
    const older: any = { ...payload, responseId: 'old', respondedAt: iso(-20, nowMs) };
    const stale = { ...(acc2 as any).next, operationalState: { ...(acc2 as any).next.operationalState, acceptance: 'REJECTED', lastConfirmedAt: older.respondedAt } };
    await dyn.setHospital(stale);
    eq(table.get('HOSPITAL#HOSP-X|STATE#CURRENT')!.data.operationalState.acceptance, 'ACCEPTED', 'older write rejected by the guard');
  });

  // ---------------------------------------------------------------- realtime broadcast exclusion

  await check('the WebSocket broadcaster never relays a feasibility trace event', async () => {
    process.env.WEBSOCKET_ENDPOINT = 'https://example.invalid';
    const { handler: ws } = await import('../../services/api/src/lambdas/websocketHandler');
    const res = await ws({ 'detail-type': 'feasibility.trace.recorded', detail: { eventType: 'feasibility.trace.recorded' } });
    eq(res, { statusCode: 200, body: 'Skipped' }, 'skipped before any AWS call');
  });

  console.log(`\n[Test] AWS ingestion RBAC / write guard: ${passCount()} checks passed.`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
