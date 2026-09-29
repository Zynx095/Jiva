/**
 * Blocker 1 (cancellation consistency) and Blocker 2 (AWS materialized-index failure fallback).
 *
 * Blocker 1: `caseAcceptanceStatus()` (the legacy-facing case-scoped override) must treat a
 * cancelled request the same way the full engine's `responseUsability()` does -- a cancelled
 * request's response can never resolve eligibility as ACCEPTED/LIMITED.
 *
 * Blocker 2: when the case-scoped acceptance read throws (e.g. a materialized-index read failure
 * in AWS), `evaluateHospitals` must never silently trust the shared one-slot legacy field --
 * unknown/unavailable evidence must degrade to UNKNOWN (never a positive acceptance).
 */
process.env.MAPPING_PROVIDER = 'mock';
import { AcceptanceLedger, caseAcceptanceStatus } from '../../services/api/src/feasibility/acceptanceLedger';
import { evaluateHospitals } from '../../services/api/src/eligibilityEngine';
import { check, eq, ok, passCount, hospital, requirement, ORIGIN } from './helpers/feasibilityHarness';

const T0 = Date.parse('2026-09-27T10:00:00.000Z');
const iso = (min: number) => new Date(T0 + min * 60000).toISOString();
const CASE = 'CASE-CANCEL';
const HOSP = 'HOSP-CANCEL-01';

function req(requestId: string, atMin = -10, ttlMin = 30) {
  return { requestId, caseId: CASE, hospitalId: HOSP, requestedAt: iso(atMin), expiresAt: iso(atMin + ttlMin) };
}
function resp(status: 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'UNAVAILABLE', requestId: string, respondedMin = -5, validMin = 60, responseId = `R-${requestId}`) {
  return {
    responseId, requestId, caseId: CASE, hospitalId: HOSP, status,
    acceptedCapabilities: status === 'ACCEPTED' || status === 'LIMITED' ? ['EMERGENCY'] : [],
    limitations: [], respondedAt: iso(respondedMin), validUntil: iso(validMin), responderRole: 'CLINICAL_COORDINATOR',
  } as any;
}

async function main() {
  // ---------------------------------------------------------------- Blocker 1: cancellation

  await check('accepted request (no cancellation) -> ACCEPTED, unaffected by the fix', () => {
    const l = new AcceptanceLedger();
    l.recordRequest(req('AR-1'));
    l.applyResponse(resp('ACCEPTED', 'AR-1'));
    const status = caseAcceptanceStatus(l.view(CASE, HOSP, T0), T0);
    eq(status, { status: 'ACCEPTED', expired: false }, 'plain accepted request must still resolve ACCEPTED');
  });

  await check('cancelled request with no response -> UNKNOWN, unaffected by the fix', () => {
    const l = new AcceptanceLedger();
    l.recordRequest(req('AR-2'));
    l.cancelRequest('AR-2', iso(-1));
    const status = caseAcceptanceStatus(l.view(CASE, HOSP, T0), T0);
    eq(status, { status: 'UNKNOWN', expired: false }, 'cancelled request with no response was already UNKNOWN');
  });

  await check('accepted then cancelled -> UNKNOWN, not ACCEPTED (the fix)', () => {
    const l = new AcceptanceLedger();
    l.recordRequest(req('AR-3'));
    l.applyResponse(resp('ACCEPTED', 'AR-3'));
    l.cancelRequest('AR-3', iso(-1));
    const status = caseAcceptanceStatus(l.view(CASE, HOSP, T0), T0);
    eq(status, { status: 'UNKNOWN', expired: false }, 'a cancelled request must never leave its ACCEPTED response usable');
  });

  await check('cancelled then a stale/late ACCEPTED response arrives -> still UNKNOWN', () => {
    const l = new AcceptanceLedger();
    l.recordRequest(req('AR-4'));
    l.cancelRequest('AR-4', iso(-8)); // cancelled before the response arrives
    l.applyResponse(resp('ACCEPTED', 'AR-4', -5));
    const status = caseAcceptanceStatus(l.view(CASE, HOSP, T0), T0);
    eq(status, { status: 'UNKNOWN', expired: false }, 'a late response against a cancelled request must not resolve acceptance');
  });

  await check('duplicate cancellation is idempotent -> still UNKNOWN', () => {
    const l = new AcceptanceLedger();
    l.recordRequest(req('AR-5'));
    l.applyResponse(resp('ACCEPTED', 'AR-5'));
    l.cancelRequest('AR-5', iso(-1));
    l.cancelRequest('AR-5', iso(-1)); // duplicate
    const status = caseAcceptanceStatus(l.view(CASE, HOSP, T0), T0);
    eq(status, { status: 'UNKNOWN', expired: false }, 'duplicate cancellation must not change the outcome');
  });

  await check('out-of-order cancellation (earlier cancelledAt arrives second) keeps the earliest', () => {
    const l = new AcceptanceLedger();
    l.recordRequest(req('AR-6'));
    l.applyResponse(resp('ACCEPTED', 'AR-6'));
    l.cancelRequest('AR-6', iso(-2));
    l.cancelRequest('AR-6', iso(-9)); // arrives second but is earlier -- ledger keeps the earliest
    const status = caseAcceptanceStatus(l.view(CASE, HOSP, T0), T0);
    eq(status, { status: 'UNKNOWN', expired: false }, 'out-of-order cancellation must still resolve to cancelled/UNKNOWN');
  });

  await check('cancellation cannot make a hospital eligible: REJECTED stays REJECTED when cancelled', () => {
    const l = new AcceptanceLedger();
    l.recordRequest(req('AR-7'));
    l.applyResponse(resp('REJECTED', 'AR-7'));
    l.cancelRequest('AR-7', iso(-1));
    const status = caseAcceptanceStatus(l.view(CASE, HOSP, T0), T0);
    ok(status.status !== 'ACCEPTED' && status.status !== 'LIMITED', 'a cancelled request must never surface as accepted');
    eq(status, { status: 'REJECTED', expired: false }, 'a negative response still stands after cancellation (conservative, not positive)');
  });

  await check('cancellation cannot make a hospital eligible: newer request supersedes an old cancellation', () => {
    const l = new AcceptanceLedger();
    l.recordRequest(req('AR-8', -20, 5)); // expires quickly
    l.cancelRequest('AR-8', iso(-18));
    l.recordRequest(req('AR-9', -10, 30)); // a fresh, uncancelled request supersedes it
    l.applyResponse(resp('ACCEPTED', 'AR-9', -5));
    const status = caseAcceptanceStatus(l.view(CASE, HOSP, T0), T0);
    eq(status, { status: 'ACCEPTED', expired: false }, 'a fresh, uncancelled request must resolve normally');
  });

  // ---------------------------------------------------------------- Blocker 2: fallback safety

  await check('acceptanceOverride failure degrades to UNKNOWN (PENDING_ACCEPTANCE), never ELIGIBLE', async () => {
    const h = hospital(HOSP, 1, {
      operationalState: {
        emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE', nicu: 'UNKNOWN', picu: 'UNKNOWN', ventilator: 'AVAILABLE',
        acceptance: 'ACCEPTED', acceptanceCaseId: 'SOME-OTHER-CASE', expiresAt: iso(120), source: 'HOSPITAL_CONFIRMED',
      } as any,
    });
    const candidates = await evaluateHospitals(requirement(CASE), ORIGIN, {
      hospitals: [h],
      acceptanceOverride: () => { throw new Error('materialized index unavailable'); },
    });
    const c = candidates.find(x => x.hospitalId === HOSP)!;
    ok(!!c, 'candidate must still be produced (legacy decision is never blocked)');
    eq(c.operationalEligibility, 'PENDING_ACCEPTANCE', 'a failed case-scoped read must never resolve to ELIGIBLE');
    eq(c.acceptanceStatus, 'PENDING', 'a failed case-scoped read must report PENDING, not the shared slot\'s ACCEPTED');
  });

  await check('acceptanceOverride failure never leaks a different case\'s shared-slot ACCEPTED as eligible', async () => {
    // The shared slot says ACCEPTED for a *different* case; the pre-fix fallback (legacySlot()) would
    // have reported this hospital ACCEPTED for the WRONG case too, since it only compares
    // acceptanceCaseId, which is exactly the one-slot bug the case-scoped ledger fixes.
    const h = hospital(HOSP, 1, {
      operationalState: {
        emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE', nicu: 'UNKNOWN', picu: 'UNKNOWN', ventilator: 'AVAILABLE',
        acceptance: 'ACCEPTED', acceptanceCaseId: CASE, expiresAt: iso(120), source: 'HOSPITAL_CONFIRMED',
      } as any,
    });
    const candidates = await evaluateHospitals(requirement(CASE), ORIGIN, {
      hospitals: [h],
      acceptanceOverride: async () => { throw new Error('DynamoDB GetCommand failed'); },
    });
    const c = candidates.find(x => x.hospitalId === HOSP)!;
    eq(c.operationalEligibility, 'PENDING_ACCEPTANCE', 'even a shared slot that matches this case must not be trusted on read failure');
  });

  await check('acceptanceOverride success path is untouched: real ACCEPTED still resolves ELIGIBLE', async () => {
    const h = hospital(HOSP, 1, {
      operationalState: {
        emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE', nicu: 'UNKNOWN', picu: 'UNKNOWN', ventilator: 'AVAILABLE',
        acceptance: 'UNKNOWN', source: 'UNKNOWN',
      } as any,
    });
    const candidates = await evaluateHospitals(requirement(CASE), ORIGIN, {
      hospitals: [h],
      acceptanceOverride: async () => ({ status: 'ACCEPTED', expired: false }),
    });
    const c = candidates.find(x => x.hospitalId === HOSP)!;
    eq(c.operationalEligibility, 'ELIGIBLE', 'a healthy override must still resolve ELIGIBLE as before');
  });

  console.log(`\nfeasibility-cancellation-fallback: ${passCount()} assertions passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
