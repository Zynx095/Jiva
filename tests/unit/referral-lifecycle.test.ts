/**
 * Phase 4 — referral correlation rules (pure) and case-scoped expiry (real local engines, in-process).
 *
 * The expiry scenarios reproduce two defects of the former shared-slot expiry and prove the fix:
 *   A. an EARLIER case's answer lapsing while another case's newer answer occupies the hospital's slot
 *      used to reroute nobody — now that case's ambulance is re-evaluated;
 *   B. a LATER case's answer lapsing used to reroute every ambulance heading to the hospital — now only
 *      its own case is affected; an ambulance with a valid answer of its own keeps its destination.
 */
process.env.MAPPING_PROVIDER = 'mock';
process.env.ACCEPTANCE_EXPIRY_CHECK_MS = '3600000'; // the test drives expiry explicitly

import { randomUUID } from 'crypto';
import type { AnyEvent } from '../../packages/event-schema/src';
import { checkReferralAnswer, MAX_ACCEPTANCE_VALIDITY_MS } from '../../services/api/src/acceptanceCorrelation';
import { check, eq, ok, run } from './helpers/assert';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const NOW = Date.parse('2026-10-12T10:00:00.000Z');
const at = (min: number, base = NOW) => new Date(base + min * 60_000).toISOString();

run('Phase 4 — referral correlation and case-scoped expiry', async () => {
  // ---------------------------------------------------------------- pure correlation
  const open = { requestId: 'AR-1', expiresAt: at(15) };
  const answer = (o: Partial<{ requestId: string; status: string; respondedAt: string; validUntil: string }> = {}) =>
    ({ requestId: 'AR-1', status: 'ACCEPTED', respondedAt: at(0), validUntil: at(30), ...o });
  const verdict = (o: Parameters<typeof checkReferralAnswer>[0], a = answer()) => {
    const r = checkReferralAnswer(o, a, NOW);
    return r.ok ? 'OK' : `${r.status}:${r.error}`;
  };

  await check('an answer needs an open referral: none, cancelled or past its deadline → 409', () => {
    eq(verdict(undefined), '409:no_outstanding_request', 'never asked');
    eq(verdict({ ...open, cancelledAt: at(-1) }), '409:no_outstanding_request', 'cancelled');
    eq(verdict({ ...open, expiresAt: at(-1) }), '409:no_outstanding_request', 'expired');
  });

  await check('an answer must name THE open referral (no stale, invented or other-case request ids) → 409', () => {
    eq(verdict(open, answer({ requestId: 'AR-demo-control' })), '409:request_mismatch', 'invented id');
    eq(verdict(open, answer({ requestId: 'AR-0-previous' })), '409:request_mismatch', 'stale id');
    eq(verdict(open), 'OK', 'correct id');
  });

  await check('answer times must be possible; the validity window is bounded; refusals carry no window', () => {
    eq(verdict(open, answer({ respondedAt: at(5) })), '400:validation_failed', 'responded in the future');
    eq(verdict(open, answer({ validUntil: at(0) })), '400:validation_failed', 'acceptance valid for no time');
    eq(verdict(open, answer({ validUntil: at(-5) })), '400:validation_failed', 'acceptance expired before it was given');
    eq(verdict(open, answer({ validUntil: new Date(NOW + MAX_ACCEPTANCE_VALIDITY_MS + 60_000).toISOString() })), '400:validation_failed', 'more than 6 hours');
    eq(verdict(open, answer({ validUntil: new Date(NOW + MAX_ACCEPTANCE_VALIDITY_MS).toISOString() })), 'OK', 'exactly 6 hours');
    eq(verdict(open, answer({ status: 'REJECTED', validUntil: at(0) })), 'OK', 'a refusal needs no validity window');
    eq(verdict(open, answer({ status: 'LIMITED', respondedAt: at(0.5) })), 'OK', 'clock skew under a minute tolerated');
  });

  // ---------------------------------------------------------------- engines, in-process
  const { eventBus } = await import('../../services/api/src/eventBus');
  const engines = await import('../../services/api/src/stateEngines');
  const stores = await import('../../services/api/src/stateStore');
  await stores.preloadData();
  engines.initializeStateEngines();
  const log: AnyEvent[] = [];
  eventBus.on('*', (e: AnyEvent) => { log.push(e); });
  const settle = async () => { let n = -1; let stable = 0; while (stable < 4) { await sleep(40); stable = log.length === n ? stable + 1 : 0; n = log.length; } };

  const SCENE = { latitude: 13.0431, longitude: 77.5891 }; // Hebbal: HOSP-BLR-001 is the closest
  const mk = (eventType: string, source: { type: string; id: string }, payload: unknown, extra: object = {}) =>
    ({ eventId: randomUUID(), eventType, timestamp: new Date().toISOString(), version: '1.0', source, payload, ...extra }) as unknown as AnyEvent;
  const emergency = (caseId: string) => mk('patient.emergency.created', { type: 'system', id: 'dispatch' }, { condition: 'Severe polytrauma', location: SCENE, severity: 'CRITICAL' }, { patientId: caseId });
  const dispatch = (amb: string, caseId: string) => mk('ambulance.dispatched', { type: 'system', id: 'dispatch' }, { ambulanceId: amb, caseId, destination: SCENE, estimatedEtaMinutes: 5 });
  const requestIdOf = (caseId: string, hospitalId: string) =>
    (log.filter(e => e.eventType === 'hospital.acceptance.requested' && (e.payload as any).caseId === caseId && (e.payload as any).hospitalId === hospitalId).pop()?.payload as any)?.requestId;
  const accept = (caseId: string, hospitalId: string, validMin: number) => mk('hospital.acceptance.received', { type: 'hospital', id: hospitalId }, {
    responseId: `R-${randomUUID().slice(0, 8)}`, requestId: requestIdOf(caseId, hospitalId), caseId, hospitalId, status: 'ACCEPTED',
    acceptedCapabilities: ['EMERGENCY', 'TRAUMA', 'ICU'], limitations: [], respondedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + validMin * 60_000).toISOString(), responderRole: 'CLINICAL_COORDINATOR', source: 'SYNTHETIC_DEMO',
  }, { metadata: { sourceType: 'test', trustedEvidence: { status: 'SYNTHETIC_DEMO', environment: 'DEMO' } } });
  const send = async (e: AnyEvent) => { await eventBus.publish(e); await settle(); };
  const fresh = async () => { engines.resetEngines(); await stores.localStoreInstance.reset(); log.length = 0; };
  const dest = (amb: string) => stores.ambulancesStore.get(amb)?.destinationHospital;
  const expiredEvents = () => log.filter(e => e.eventType === 'hospital.acceptance.expired').map(e => e.payload as any);

  await check('A: an earlier case\'s lapsed answer reroutes THAT case even while a newer case occupies the hospital\'s slot', async () => {
    await fresh();
    await send(emergency('CASE-EA')); await send(emergency('CASE-EB'));
    await send(accept('CASE-EA', 'HOSP-BLR-001', 10));
    await send(accept('CASE-EA', 'HOSP-BLR-004', 30));
    await send(dispatch('AMB-BLR-001', 'CASE-EA'));
    eq(dest('AMB-BLR-001'), 'HOSP-BLR-001', 'initial destination: closest accepting hospital');
    await send(accept('CASE-EB', 'HOSP-BLR-001', 60)); // the shared slot now shows case B (valid 60 min)
    eq(stores.hospitalsStore.get('HOSP-BLR-001')!.operationalState.acceptanceCaseId, 'CASE-EB', 'slot belongs to the newer case');
    engines.checkAcceptanceExpiry(Date.now() + 11 * 60_000);
    await settle(); await sleep(150); await settle();
    eq(dest('AMB-BLR-001'), 'HOSP-BLR-004', 'case A re-evaluated: its own answer at 001 lapsed');
    ok(expiredEvents().some(p => p.caseId === 'CASE-EA' && p.hospitalId === 'HOSP-BLR-001' && p.kind === 'RESPONSE_VALIDITY'), 'case-scoped expiry announced');
    ok(log.some(e => e.eventType === 'route.recalculated' && (e.payload as any).oldHospitalId === 'HOSP-BLR-001' && (e.payload as any).newHospitalId === 'HOSP-BLR-004'), 'reroute published');
  });

  await check('B: a later case\'s lapsed answer never takes another case\'s valid destination', async () => {
    await fresh();
    await send(emergency('CASE-EC')); await send(emergency('CASE-ED'));
    await send(accept('CASE-EC', 'HOSP-BLR-001', 60));
    await send(accept('CASE-EC', 'HOSP-BLR-004', 60));
    await send(dispatch('AMB-BLR-001', 'CASE-EC'));
    eq(dest('AMB-BLR-001'), 'HOSP-BLR-001', 'case C heading to 001 with a 60-minute answer');
    await send(accept('CASE-ED', 'HOSP-BLR-001', 10)); // slot now shows case D, valid 10 min
    engines.checkAcceptanceExpiry(Date.now() + 11 * 60_000);
    await settle(); await sleep(150); await settle();
    eq(dest('AMB-BLR-001'), 'HOSP-BLR-001', 'case C keeps its destination');
    ok(expiredEvents().some(p => p.caseId === 'CASE-ED' && p.kind === 'RESPONSE_VALIDITY'), 'case D expiry announced');
    ok(!expiredEvents().some(p => p.caseId === 'CASE-EC'), 'no expiry for case C');
    eq(stores.hospitalsStore.get('HOSP-BLR-001')!.operationalState.acceptance, 'UNKNOWN', 'the shared slot still shows UNKNOWN once its answer lapsed');
  });

  await check('an expiry is announced once, however often the engine ticks', async () => {
    const before = expiredEvents().length;
    engines.checkAcceptanceExpiry(Date.now() + 12 * 60_000);
    engines.checkAcceptanceExpiry(Date.now() + 13 * 60_000);
    await settle();
    eq(expiredEvents().length, before, 'no duplicates');
  });

  await check('an unanswered referral closes at its deadline: announced once (REQUEST_UNANSWERED), then no longer answerable', async () => {
    await fresh();
    await send(emergency('CASE-EE'));
    ok(!!engines.outstandingRequest('CASE-EE', 'HOSP-BLR-002'), 'referral open');
    await send(accept('CASE-EE', 'HOSP-BLR-001', 30)); // 001 answers; 002 and 004 never do
    engines.checkAcceptanceExpiry(Date.now() + 16 * 60_000);
    await settle();
    const unanswered = expiredEvents().filter(p => p.kind === 'REQUEST_UNANSWERED');
    eq(unanswered.map(p => p.hospitalId).sort(), ['HOSP-BLR-002', 'HOSP-BLR-004'], 'only the silent hospitals');
    ok(unanswered.every(p => p.caseId === 'CASE-EE' && typeof p.requestId === 'string' && p.requestId.startsWith('AR-')), 'names case and referral');
    eq(engines.outstandingRequest('CASE-EE', 'HOSP-BLR-002'), undefined, 'closed: a late answer will be refused');
    engines.checkAcceptanceExpiry(Date.now() + 17 * 60_000);
    await settle();
    eq(expiredEvents().filter(p => p.kind === 'REQUEST_UNANSWERED').length, 2, 'not announced again');
  });
});
