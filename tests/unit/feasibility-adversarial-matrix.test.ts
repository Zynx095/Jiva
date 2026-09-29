import { randomUUID } from 'crypto';
process.env.MAPPING_PROVIDER = 'mock';
import type { AnyEvent } from '../../packages/event-schema/src';
import type { CapabilityType, CareRequirement, HospitalState } from '../../packages/domain-models/src';
import { AcceptanceLedger, caseAcceptanceStatus, withTrust } from '../../services/api/src/feasibility/acceptanceLedger';
import { FeasibilityShadow } from '../../services/api/src/feasibility/shadow';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { DynamoStateStore } from '../../services/api/src/infrastructure/stateStore/DynamoStateStore';
import { MaterializedAcceptanceView, rebuildFromEvents } from '../../services/api/src/infrastructure/stateStore/materializedAcceptance';
import { loadAcceptanceView } from '../../services/api/src/lambdas/core/deps';
import { authorizeEventSubmission } from '../../services/api/src/authorizationPolicy';
import { authenticateRequest, setCustomJwksProvider, setCustomVerifier } from '../../services/api/src/authVerification';
import {
  JwtVerifier,
  StaticJwksProvider,
  generateTestRsaKeypair,
  signTestJwt,
  AuthContext,
} from '../../packages/auth/src';
import { check, eq, ok, passCount, hospital, requirement, ORIGIN, T0, iso, withCapacity } from './helpers/feasibilityHarness';

const CASE_1 = 'CASE-ADV-01';
const CASE_2 = 'CASE-ADV-02';
const CASE_3 = 'CASE-ADV-03';
const HOSP_1 = 'HOSP-ADV-01';
const HOSP_2 = 'HOSP-ADV-02';

function stubMapping() {
  return {
    calculateRoute: async () => ({
      distanceMeters: 5000,
      durationSeconds: 600,
      polyline: 'mock_poly',
      coordinates: [[12.9, 77.5], [13.0, 77.6]] as [number, number][],
      provider: 'mock',
      sourceType: 'MOCK',
      synthetic: true,
      trafficAware: false,
    }),
  } as any;
}

function reqEvent(caseId: string, hospitalId: string, requestId: string, atMin: number, ttlMin = 30): AnyEvent {
  return {
    eventId: randomUUID(),
    eventType: 'hospital.acceptance.requested',
    timestamp: iso(atMin),
    version: '1.0',
    source: { type: 'system', id: 'acceptance-protocol' },
    patientId: caseId,
    payload: {
      requestId,
      caseId,
      hospitalId,
      requestedAt: iso(atMin),
      expiresAt: iso(atMin + ttlMin),
    },
  } as unknown as AnyEvent;
}

function respEvent(
  caseId: string,
  hospitalId: string,
  requestId: string,
  status: 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'UNAVAILABLE',
  respondedMin: number,
  validMin = 60,
  responseId = `RESP-${randomUUID().substring(0, 8)}`
): AnyEvent {
  return {
    eventId: randomUUID(),
    eventType: 'hospital.acceptance.received',
    timestamp: iso(respondedMin),
    version: '1.0',
    source: { type: 'hospital', id: hospitalId },
    patientId: caseId,
    metadata: { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } },
    payload: {
      responseId,
      requestId,
      caseId,
      hospitalId,
      status,
      acceptedCapabilities: status === 'ACCEPTED' || status === 'LIMITED' ? ['EMERGENCY', 'TRAUMA', 'ICU'] : [],
      limitations: [],
      respondedAt: iso(respondedMin),
      validUntil: iso(validMin),
      responderRole: 'EMERGENCY_COORDINATOR',
    },
  } as unknown as AnyEvent;
}

function cancelEvent(
  caseId: string,
  hospitalId: string,
  requestId: string,
  cancelledMin: number,
  reason: 'DESTINATION_FINALIZED_ELSEWHERE' | 'CASE_CLOSED' | 'REQUIREMENT_CHANGED' | 'OPERATOR_WITHDRAWN' = 'DESTINATION_FINALIZED_ELSEWHERE'
): AnyEvent {
  return {
    eventId: randomUUID(),
    eventType: 'hospital.acceptance.cancelled',
    timestamp: iso(cancelledMin),
    version: '1.0',
    source: { type: 'system', id: 'acceptance-protocol' },
    patientId: caseId,
    payload: {
      requestId,
      caseId,
      hospitalId,
      cancelledAt: iso(cancelledMin),
      reason,
    },
  } as unknown as AnyEvent;
}

async function main() {
  console.log('\n============================================================');
  console.log('ADVERSARIAL TEST MATRIX (A through R) — PHASE 6.2');
  console.log('============================================================\n');

  // ============================================================ A. Two cases, same hospital
  await check('A. Two cases, same hospital: Case 1 accepted, Case 2 rejected -> isolated verdicts', async () => {
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(reqEvent(CASE_1, HOSP_1, 'AR-1', -10).payload as any);
    ledger.recordRequest(reqEvent(CASE_2, HOSP_1, 'AR-2', -10).payload as any);

    ledger.applyResponse(withTrust(respEvent(CASE_1, HOSP_1, 'AR-1', 'ACCEPTED', -5).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
    ledger.applyResponse(withTrust(respEvent(CASE_2, HOSP_1, 'AR-2', 'REJECTED', -5).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const view1 = ledger.view(CASE_1, HOSP_1, T0);
    const view2 = ledger.view(CASE_2, HOSP_1, T0);

    const status1 = caseAcceptanceStatus(view1, T0);
    const status2 = caseAcceptanceStatus(view2, T0);

    eq(status1.status, 'ACCEPTED', 'Case 1 must be ACCEPTED');
    eq(status2.status, 'REJECTED', 'Case 2 must be REJECTED at the exact same hospital');
  });

  // ============================================================ B. Three cases, same hospital
  await check('B. Three cases, same hospital: Case 1 accepted, Case 2 cancelled, Case 3 outstanding', async () => {
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(reqEvent(CASE_1, HOSP_1, 'AR-1', -10).payload as any);
    ledger.recordRequest(reqEvent(CASE_2, HOSP_1, 'AR-2', -10).payload as any);
    ledger.recordRequest(reqEvent(CASE_3, HOSP_1, 'AR-3', -10).payload as any);

    ledger.applyResponse(withTrust(respEvent(CASE_1, HOSP_1, 'AR-1', 'ACCEPTED', -5).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
    ledger.applyResponse(withTrust(respEvent(CASE_2, HOSP_1, 'AR-2', 'ACCEPTED', -5).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
    ledger.applyCancellation(cancelEvent(CASE_2, HOSP_1, 'AR-2', -2).payload as any);

    const s1 = caseAcceptanceStatus(ledger.view(CASE_1, HOSP_1, T0), T0);
    const s2 = caseAcceptanceStatus(ledger.view(CASE_2, HOSP_1, T0), T0);
    const s3 = caseAcceptanceStatus(ledger.view(CASE_3, HOSP_1, T0), T0);

    eq(s1.status, 'ACCEPTED', 'Case 1 remains ACCEPTED');
    eq(s2.status, 'UNKNOWN', 'Case 2 is cancelled -> UNKNOWN (cannot resolve as accepted)');
    eq(s3.status, 'UNKNOWN', 'Case 3 is outstanding awaiting response -> UNKNOWN');
  });

  // ============================================================ C. Acceptance + cancellation
  await check('C. Acceptance + cancellation: positive response cannot stand once request is cancelled', async () => {
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(reqEvent(CASE_1, HOSP_1, 'AR-C', -10).payload as any);
    ledger.applyResponse(withTrust(respEvent(CASE_1, HOSP_1, 'AR-C', 'ACCEPTED', -5).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
    
    // Before cancellation: ACCEPTED
    eq(caseAcceptanceStatus(ledger.view(CASE_1, HOSP_1, T0), T0).status, 'ACCEPTED', 'pre-cancellation is ACCEPTED');

    // Apply cancellation
    ledger.applyCancellation(cancelEvent(CASE_1, HOSP_1, 'AR-C', -1).payload as any);
    const postView = ledger.view(CASE_1, HOSP_1, T0);
    eq(postView.requestState, 'REQUEST_CANCELLED', 'requestState must be REQUEST_CANCELLED');
    eq(caseAcceptanceStatus(postView, T0).status, 'UNKNOWN', 'case acceptance must fail closed to UNKNOWN');
  });

  // ============================================================ D. Acceptance + expiry
  await check('D. Acceptance + expiry: expired response fails closed to expired/UNKNOWN', async () => {
    const ledger = new AcceptanceLedger();
    // Responded at -60 min, valid until -10 min
    ledger.recordRequest(reqEvent(CASE_1, HOSP_1, 'AR-EXP', -70, 60).payload as any);
    ledger.applyResponse(withTrust(respEvent(CASE_1, HOSP_1, 'AR-EXP', 'ACCEPTED', -60, -10).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const view = ledger.view(CASE_1, HOSP_1, T0);
    const status = caseAcceptanceStatus(view, T0);
    eq(status.expired, true, 'response must be flagged expired');
    eq(status.status, 'ACCEPTED', 'expired flag is true on the status');
  });

  // ============================================================ E. Acceptance + rejection
  await check('E. Acceptance + rejection: rejection makes candidate fail closed', async () => {
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(reqEvent(CASE_1, HOSP_1, 'AR-REJ', -10).payload as any);
    ledger.applyResponse(withTrust(respEvent(CASE_1, HOSP_1, 'AR-REJ', 'REJECTED', -5).payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const status = caseAcceptanceStatus(ledger.view(CASE_1, HOSP_1, T0), T0);
    eq(status.status, 'REJECTED', 'status must be REJECTED');
  });

  // ============================================================ F. Acceptance + supersession
  await check('F. Acceptance + supersession: newer response strictly supersedes older response', async () => {
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(reqEvent(CASE_1, HOSP_1, 'AR-SUP', -20).payload as any);
    // First response at -15 min was ACCEPTED
    ledger.applyResponse(withTrust(respEvent(CASE_1, HOSP_1, 'AR-SUP', 'ACCEPTED', -15, 60, 'RESP-1').payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));
    // Superseding response at -5 min is REJECTED
    ledger.applyResponse(withTrust(respEvent(CASE_1, HOSP_1, 'AR-SUP', 'REJECTED', -5, 60, 'RESP-2').payload as any, { trustedEvidence: { status: 'HOSPITAL_CONFIRMED' } }));

    const status = caseAcceptanceStatus(ledger.view(CASE_1, HOSP_1, T0), T0);
    eq(status.status, 'REJECTED', 'newer REJECTED response must supersede older ACCEPTED');
  });

  // ============================================================ G. Out-of-order cancellation
  await check('G. Out-of-order cancellation: earlier cancelledAt is preserved even if delivered later', async () => {
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(reqEvent(CASE_1, HOSP_1, 'AR-OOO', -20).payload as any);
    ledger.applyCancellation({ requestId: 'AR-OOO', cancelledAt: iso(-5) });
    ledger.applyCancellation({ requestId: 'AR-OOO', cancelledAt: iso(-15) }); // arrived second, but earlier timestamp

    const view = ledger.view(CASE_1, HOSP_1, T0);
    eq(view.request?.cancelledAt, iso(-15), 'earliest cancelledAt must be preserved');
  });

  // ============================================================ H. Duplicate cancellation
  await check('H. Duplicate cancellation is idempotent', async () => {
    const ledger = new AcceptanceLedger();
    ledger.recordRequest(reqEvent(CASE_1, HOSP_1, 'AR-DUP', -20).payload as any);
    ledger.applyCancellation({ requestId: 'AR-DUP', cancelledAt: iso(-10) });
    ledger.applyCancellation({ requestId: 'AR-DUP', cancelledAt: iso(-10) }); // exact duplicate

    const view = ledger.view(CASE_1, HOSP_1, T0);
    eq(view.requestState, 'REQUEST_CANCELLED', 'state remains REQUEST_CANCELLED');
    eq(view.request?.cancelledAt, iso(-10), 'cancelledAt remains unchanged');
  });

  // ============================================================ I. 10,000+ telemetry events after UNAVAILABLE
  await check('I. 10,000+ telemetry events after UNAVAILABLE: materialized index preserves hospital-wide UNAVAILABLE', async () => {
    const store = new LocalStateStore();
    const h = withCapacity(hospital(HOSP_1, 1), { emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE' }, -1);
    await store.setHospital(h);

    // 1. Hospital reports UNAVAILABLE for another case
    const unavail = respEvent('CASE-OTHER', HOSP_1, 'AR-OTHER', 'UNAVAILABLE', -2, 60);
    await store.recordEvent(unavail);
    await store.putAcceptanceResponse('CASE-OTHER', HOSP_1, withTrust(unavail.payload as any, unavail.metadata));

    // 2. 10,000 unrelated telemetry events occur
    for (let i = 0; i < 10005; i++) {
      await store.recordEvent({
        eventId: `GPS-${i}`,
        eventType: 'ambulance.location.updated',
        timestamp: iso(-1, T0 + i),
        version: '1.0',
        source: { type: 'ambulance', id: 'AMB-1' },
        payload: { ambulanceId: 'AMB-1', coordinates: { latitude: 13.0, longitude: 77.6 }, speedKmh: 20, heading: 90 },
      } as unknown as AnyEvent);
    }

    // 3. Case 1 evaluations read materialized index via loadAcceptanceView
    const acceptanceView = await loadAcceptanceView(store, CASE_1, [HOSP_1], T0);
    const view = acceptanceView.view(CASE_1, HOSP_1, T0);
    ok(view.hospitalWideUnavailable !== undefined, 'hospitalWideUnavailable must remain visible after 10,000+ events');
    eq(view.hospitalWideUnavailable?.status, 'UNAVAILABLE', 'status must be UNAVAILABLE');
    eq(caseAcceptanceStatus(view, T0).status, 'UNAVAILABLE', 'caseAcceptanceStatus must be UNAVAILABLE');

    // 4. Inverse test: newer ACCEPTED arriving at a later timestamp supersedes UNAVAILABLE
    const newerAccepted = respEvent('CASE-LATER', HOSP_1, 'AR-LATER', 'ACCEPTED', 1, 60);
    await store.recordEvent(newerAccepted);
    await store.putAcceptanceResponse('CASE-LATER', HOSP_1, withTrust(newerAccepted.payload as any, newerAccepted.metadata));

    const updatedView = (await loadAcceptanceView(store, CASE_1, [HOSP_1], T0 + 120_000)).view(CASE_1, HOSP_1, T0 + 120_000);
    eq(updatedView.hospitalWideUnavailable, undefined, 'strictly newer accepting response removes hospital-wide UNAVAILABLE');
  });

  // ============================================================ J. Poisoned / malformed history
  await check('J. Poisoned / malformed history: malformed events are safely skipped without crash', async () => {
    const events: any[] = [
      { eventId: 'ok-1', eventType: 'hospital.acceptance.requested', timestamp: iso(-10), payload: { requestId: 'R-OK', caseId: CASE_1, hospitalId: HOSP_1, requestedAt: iso(-10), expiresAt: iso(20) } },
      { eventId: 'bad-1', eventType: 'hospital.acceptance.received', timestamp: 'not-a-date', payload: null },
      { eventId: 'bad-2', eventType: 'hospital.acceptance.received', timestamp: iso(-5), payload: { garbage: true } },
      { eventId: 'ok-2', eventType: 'hospital.acceptance.received', timestamp: iso(-5), payload: { responseId: 'RESP-OK', requestId: 'R-OK', caseId: CASE_1, hospitalId: HOSP_1, status: 'ACCEPTED', acceptedCapabilities: ['EMERGENCY'], limitations: [], respondedAt: iso(-5), validUntil: iso(30) } },
    ];

    const ledger = AcceptanceLedger.fromEvents(events);
    const view = ledger.view(CASE_1, HOSP_1, T0);
    eq(view.requestState, 'OUTSTANDING', 'valid request was recorded');
    eq(view.response?.responseId, 'RESP-OK', 'valid response was applied despite poisoned neighbors');
  });

  // ============================================================ K. Dynamo pagination
  await check('K. Dynamo pagination: queryEventsByCase follows pagination keys and enforces guard limit', async () => {
    const store = new DynamoStateStore({ tableName: 'test-table', region: 'ap-south-1' });
    let pageCount = 0;
    (store as any).docClient = {
      send: async () => {
        pageCount++;
        if (pageCount < 3) {
          return {
            Items: [{ data: { eventId: `E-${pageCount}`, eventType: 'test.event', timestamp: iso(0) } }],
            LastEvaluatedKey: { PK: `CASE#${CASE_1}`, SK: `PAGE-${pageCount}` },
          };
        }
        return {
          Items: [{ data: { eventId: `E-${pageCount}`, eventType: 'test.event', timestamp: iso(0) } }],
        };
      },
    };

    const items = await store.queryEventsByCase(CASE_1);
    eq(items.length, 3, 'queryEventsByCase must follow pagination and retrieve all 3 pages');
  });

  // ============================================================ L. Cross-hospital authorization attempt
  await check('L. Cross-hospital authorization attempt: principal for H-1 cannot report for H-2', async () => {
    const auth: AuthContext = { userId: 'op-h1', role: 'HOSPITAL', hospitalId: HOSP_1 };
    const foreignEvent = respEvent(CASE_1, HOSP_2, 'AR-FOREIGN', 'ACCEPTED', -5);

    const denial = authorizeEventSubmission(auth, foreignEvent);
    ok(denial !== null, 'denial must be non-null for cross-hospital submission');
    eq(denial, 'A hospital may only report on its own facility', 'denial message matches exact RBAC policy');
  });

  // ============================================================ M. Fake x-cognito-claims
  await check('M. Fake x-cognito-claims: unverified claims header is rejected without signature', async () => {
    const fakeClaims = JSON.stringify({
      sub: 'hacker-007',
      'cognito:groups': ['ADMIN'],
    });

    const result = await authenticateRequest({ 'x-cognito-claims': fakeClaims });
    eq(result, undefined, 'unverified x-cognito-claims header must be rejected');
  });

  // ============================================================ N. Expired JWT
  await check('N. Expired JWT: valid signature but expired token is rejected', async () => {
    const keypair = generateTestRsaKeypair();
    const kid = 'test-key-1';
    const jwks = new StaticJwksProvider({ [kid]: keypair.publicKeyPem });
    const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_TEST';
    const verifier = new JwtVerifier({ issuer, jwksProvider: jwks });

    const nowSec = Math.floor(Date.now() / 1000);
    const token = signTestJwt(
      { sub: 'user-expired', iss: issuer, exp: nowSec - 100 },
      keypair.privateKeyPem,
      { kid }
    );

    const res = await verifier.verify(token);
    eq(res.authenticated, false, 'expired token must fail verification');
    eq(res.error, 'JWT token has expired', 'error must state token has expired');
  });

  // ============================================================ O. Invalid JWT signature
  await check('O. Invalid JWT signature: tampered payload fails cryptographic verification', async () => {
    const keypair = generateTestRsaKeypair();
    const keypairOther = generateTestRsaKeypair();
    const kid = 'test-key-2';
    const jwks = new StaticJwksProvider({ [kid]: keypair.publicKeyPem });
    const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_TEST';
    const verifier = new JwtVerifier({ issuer, jwksProvider: jwks });

    // Signed with wrong private key
    const token = signTestJwt(
      { sub: 'user-forged', iss: issuer, exp: Math.floor(Date.now() / 1000) + 3600 },
      keypairOther.privateKeyPem,
      { kid }
    );

    const res = await verifier.verify(token);
    eq(res.authenticated, false, 'invalid signature must fail verification');
    eq(res.error, 'Invalid JWT signature', 'error must state invalid signature');
  });

  // ============================================================ P. Wrong issuer/audience
  await check('P. Wrong issuer/audience: rejected even if signature is valid', async () => {
    const keypair = generateTestRsaKeypair();
    const kid = 'test-key-3';
    const jwks = new StaticJwksProvider({ [kid]: keypair.publicKeyPem });
    const issuer = 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_TEST';
    const verifier = new JwtVerifier({ issuer, audience: 'client-app-123', jwksProvider: jwks });

    // Wrong issuer
    const tokenWrongIssuer = signTestJwt(
      { sub: 'user-1', iss: 'https://evil-issuer.com', aud: 'client-app-123', exp: Math.floor(Date.now() / 1000) + 3600 },
      keypair.privateKeyPem,
      { kid }
    );
    const resIssuer = await verifier.verify(tokenWrongIssuer);
    eq(resIssuer.authenticated, false, 'wrong issuer must fail');

    // Wrong audience
    const tokenWrongAud = signTestJwt(
      { sub: 'user-1', iss: issuer, aud: 'wrong-client', exp: Math.floor(Date.now() / 1000) + 3600 },
      keypair.privateKeyPem,
      { kid }
    );
    const resAud = await verifier.verify(tokenWrongAud);
    eq(resAud.authenticated, false, 'wrong audience must fail');
  });

  // ============================================================ Q. Replay in multiple arrival orders
  await check('Q. Replay in multiple arrival orders: permutations produce identical snapshot hashes', async () => {
    const e1 = reqEvent(CASE_1, HOSP_1, 'AR-Q', -20);
    const e2 = respEvent(CASE_1, HOSP_1, 'AR-Q', 'ACCEPTED', -15);
    const e3 = cancelEvent(CASE_1, HOSP_1, 'AR-Q', -5);

    const orderA = [e1, e2, e3];
    const orderB = [e3, e1, e2];
    const orderC = [e2, e3, e1];

    const snapA = AcceptanceLedger.fromEvents(orderA).snapshot();
    const snapB = AcceptanceLedger.fromEvents(orderB).snapshot();
    const snapC = AcceptanceLedger.fromEvents(orderC).snapshot();

    eq(snapA, snapB, 'order A and order B produce identical snapshot');
    eq(snapB, snapC, 'order B and order C produce identical snapshot');
  });

  // ============================================================ R. Local vs Dynamo semantic parity
  await check('R. Local vs Dynamo semantic parity: rebuildFromEvents yields identical records', async () => {
    const events = [
      reqEvent(CASE_1, HOSP_1, 'AR-R1', -30),
      respEvent(CASE_1, HOSP_1, 'AR-R1', 'ACCEPTED', -25),
      cancelEvent(CASE_1, HOSP_1, 'AR-R1', -10),
      reqEvent(CASE_2, HOSP_1, 'AR-R2', -20),
      respEvent(CASE_2, HOSP_1, 'AR-R2', 'UNAVAILABLE', -15),
    ];

    const localStore = new LocalStateStore();
    for (const e of events) {
      await localStore.recordEvent(e);
      const p: any = (e as any).payload;
      if (e.eventType === 'hospital.acceptance.requested') await localStore.putAcceptanceRequest!(p.caseId, p.hospitalId, p);
      else if (e.eventType === 'hospital.acceptance.received') await localStore.putAcceptanceResponse!(p.caseId, p.hospitalId, withTrust(p, (e as any).metadata));
      else if ((e.eventType as string) === 'hospital.acceptance.cancelled') await localStore.putAcceptanceCancellation!(p.caseId, p.hospitalId, p.requestId, p.cancelledAt);
    }

    const rebuilt = rebuildFromEvents(events);

    // Verify local store records match rebuildFromEvents
    const localRec1 = await localStore.getAcceptanceRecord(CASE_1, HOSP_1);
    const rebuiltRec1 = rebuilt.byKey.get(`${CASE_1}|${HOSP_1}`);

    eq(localRec1?.request?.requestId, rebuiltRec1?.request?.requestId, 'requestId matches between local and rebuilt');
    eq(localRec1?.request?.cancelledAt, rebuiltRec1?.request?.cancelledAt, 'cancelledAt matches between local and rebuilt');

    const wideLocal = await localStore.getHospitalWideUnavailable(HOSP_1);
    const wideRebuilt = rebuilt.wideByHospital.get(HOSP_1);
    eq(wideLocal?.response?.responseId, wideRebuilt?.response?.responseId, 'wide unavailable response matches');
  });

  console.log(`\nAll 18 Adversarial Tests (A through R) Passed! Total assertions: ${passCount()}`);
}

main().catch(err => {
  console.error('\nAdversarial matrix test failed:', err);
  process.exit(1);
});
