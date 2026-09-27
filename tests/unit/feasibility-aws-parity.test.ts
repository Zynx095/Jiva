/**
 * Local vs AWS parity for the Care Feasibility Engine (shadow) on FROZEN evidence.
 *
 * "local" = live in-memory acceptance ledger (as the local state engines maintain it)
 * "AWS"   = store-backed shadow whose ledger/requirements are rebuilt from the event history
 *           (what a stateless lambda can do)
 * Same evidence, same injected clock/ids/mapping -> every field (decision, trace, auditHash,
 * snapshotHash, trace-event payload) must be byte-identical. Each scenario then asserts the
 * approved semantics on the shared result.
 */
import type { CapabilityType, HospitalState } from '../../packages/domain-models/src';
import { applyAcceptanceResponse } from '../../services/api/src/stateTransitions';
import {
  CAPS, CASE, cand, capacityEvent, check, eq, evaluateDual, evaluateParity, hospital, iso, locKey, ok,
  passCount, requestedEvent, requirement, responseEvent, rule, withCapacity,
} from './helpers/feasibilityHarness';

const accepted = (h: string, caseId = CASE) => [requestedEvent(caseId, h), responseEvent(caseId, h, 'ACCEPTED')];

async function main() {
  console.log('[Test] Feasibility local/AWS parity on frozen evidence\n');

  // ---------------------------------------------------------------- 2-5 operational freshness (A3/D6)

  await check('2. fresh AVAILABLE passes the operational rules (and is ELIGIBLE once accepted)', async () => {
    const h = withCapacity(hospital('H-1', 1), { emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE' }, -5, 'SYNTHETIC_DEMO');
    const pending = await evaluateParity({ hospitals: [h], events: [] }, 'fresh available/pending');
    eq(rule(pending, 'H-1', 'HC-OPS-01').outcome, 'PASS', 'HC-OPS-01');
    eq(rule(pending, 'H-1', 'HC-OPS-02').outcome, 'PASS', 'HC-OPS-02');
    eq(cand(pending, 'H-1').verdict, 'PENDING_ACCEPTANCE', 'fresh AVAILABLE alone is not acceptance');
    const done = await evaluateParity({ hospitals: [h], events: accepted('H-1') }, 'fresh available/accepted');
    eq(cand(done, 'H-1').verdict, 'ELIGIBLE', 'accepted');
  });

  await check('3. fresh UNAVAILABLE fails (INELIGIBLE), even with a current ACCEPTED response', async () => {
    const h = withCapacity(hospital('H-1', 1), { emergency: 'UNAVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE' }, -5);
    const r = await evaluateParity({ hospitals: [h], events: accepted('H-1') }, 'fresh unavailable');
    eq(rule(r, 'H-1', 'HC-OPS-01').outcome, 'FAIL', 'HC-OPS-01');
    eq(cand(r, 'H-1').verdict, 'INELIGIBLE', 'verdict');
    eq(r.aws.decision.outcome, 'NO_FEASIBLE_CANDIDATE', 'outcome');
  });

  await check('4. expired AVAILABLE -> UNKNOWN/STALE (never PASS, never ELIGIBLE)', async () => {
    const h = withCapacity(hospital('H-1', 1), { emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE' }, -45);
    const r = await evaluateParity({ hospitals: [h], events: [] }, 'expired available');
    const c = rule(r, 'H-1', 'HC-OPS-01');
    eq([c.outcome, c.reasonCode], ['UNKNOWN', 'EVIDENCE_STALE'], 'HC-OPS-01');
    ok(cand(r, 'H-1').verdict !== 'ELIGIBLE', 'must not be ELIGIBLE');
    eq(c.evidenceRefs[0].freshness, 'STALE', 'evidence flagged STALE');
  });

  await check('5. expired UNAVAILABLE -> UNKNOWN (loses the ability to assert unavailability; never AVAILABLE)', async () => {
    const h = withCapacity(hospital('H-1', 1), { emergency: 'UNAVAILABLE', icu: 'UNAVAILABLE', trauma: 'UNAVAILABLE' }, -45);
    const r = await evaluateParity({ hospitals: [h], events: [] }, 'expired unavailable');
    eq(rule(r, 'H-1', 'HC-OPS-01').outcome, 'UNKNOWN', 'HC-OPS-01');
    eq(rule(r, 'H-1', 'HC-OPS-02').outcome, 'UNKNOWN', 'HC-OPS-02');
    eq(cand(r, 'H-1').verdict, 'PENDING_ACCEPTANCE', 'not INELIGIBLE, not ELIGIBLE');
  });

  await check('   explicit validUntil beats the freshness default (acceptance validity governs, both environments)', async () => {
    // Response validUntil 90 min away: still valid although older than the 60-min default cap would suggest.
    const e = [requestedEvent(CASE, 'H-1', -100, 40), responseEvent(CASE, 'H-1', 'ACCEPTED', { respondedMin: -80, validMin: 10 })];
    const r = await evaluateParity({ hospitals: [hospital('H-1', 1)], events: e }, 'validUntil precedence');
    eq(cand(r, 'H-1').verdict, 'ELIGIBLE', 'valid until validUntil');
    const expired = [requestedEvent(CASE, 'H-1', -10, 30), responseEvent(CASE, 'H-1', 'ACCEPTED', { respondedMin: -5, validMin: -1 })];
    const r2 = await evaluateParity({ hospitals: [hospital('H-1', 1)], events: expired }, 'validUntil expired');
    eq(rule(r2, 'H-1', 'HC-ACC-04').reasonCode, 'ACCEPTANCE_EXPIRED', 'expired');
  });

  // ---------------------------------------------------------------- 6-7 capability semantics (D2)

  await check('6. unknown capability -> UNKNOWN -> INDETERMINATE (not INELIGIBLE)', async () => {
    const r = await evaluateParity({
      hospitals: [hospital('H-1', 1)], events: [], requirement: requirement(CASE, ['EMERGENCY', 'MRI'] as CapabilityType[]),
    }, 'unknown capability');
    eq(rule(r, 'H-1', 'HC-CLIN-01').outcome, 'UNKNOWN', 'rule');
    eq(cand(r, 'H-1').verdict, 'INDETERMINATE', 'verdict');
  });

  await check('7. explicit capability=false -> INELIGIBLE', async () => {
    const h = hospital('H-1', 1, { capabilities: { emergency: true, trauma: false, icu: true } });
    const r = await evaluateParity({ hospitals: [h], events: accepted('H-1') }, 'explicit false');
    eq(rule(r, 'H-1', 'HC-CLIN-01').reasonCode, 'CAPABILITY_NOT_PROVIDED', 'reason');
    eq(cand(r, 'H-1').verdict, 'INELIGIBLE', 'verdict');
    // ... and a positive response cannot flip an explicit negative (the demo UI echoes requested capabilities)
    const echoed = [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'ACCEPTED', { caps: CAPS })];
    const r2 = await evaluateParity({ hospitals: [h], events: echoed }, 'explicit false + echoed acceptance');
    eq(cand(r2, 'H-1').verdict, 'INELIGIBLE', 'explicit false wins over a positive response');
    ok(rule(r2, 'H-1', 'HC-CLIN-01').rationale.includes('not overridden'), 'contradiction recorded');
    // an UNKNOWN capability, by contrast, may be resolved by the hospital's own current response
    const unlisted = hospital('H-2', 2, { capabilities: { emergency: true, icu: true } });
    const r3 = await evaluateParity({ hospitals: [unlisted], events: [requestedEvent(CASE, 'H-2'), responseEvent(CASE, 'H-2', 'ACCEPTED', { caps: CAPS })] }, 'unknown resolved by response');
    eq(rule(r3, 'H-2', 'HC-CLIN-01').reasonCode, 'CAPABILITY_CONFIRMED_BY_RESPONSE', 'unknown resolved');
  });

  // ---------------------------------------------------------------- 8-9 LIMITED (D4/A2)

  await check('8. LIMITED that omits a required capability (ICU) -> INELIGIBLE', async () => {
    const e = [requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'LIMITED', { caps: ['EMERGENCY', 'TRAUMA'], limitations: ['ICU capacity limited'] })];
    const r = await evaluateParity({ hospitals: [hospital('H-1', 1)], events: e }, 'limited missing');
    eq(rule(r, 'H-1', 'HC-ACC-03').reasonCode, 'LIMITED_MISSING_CAPABILITY', 'reason');
    eq(cand(r, 'H-1').verdict, 'INELIGIBLE', 'verdict');
  });

  await check('9. LIMITED satisfying every required capability -> ELIGIBLE, but ranks after a full ACCEPTED', async () => {
    const e = [
      requestedEvent(CASE, 'H-1'), responseEvent(CASE, 'H-1', 'LIMITED', { caps: CAPS }),
      requestedEvent(CASE, 'H-2'), responseEvent(CASE, 'H-2', 'ACCEPTED'),
    ];
    const r = await evaluateParity({ hospitals: [hospital('H-1', 1), hospital('H-2', 5)], events: e }, 'limited ok');
    eq(cand(r, 'H-1').verdict, 'ELIGIBLE', 'limited eligible');
    eq(r.aws.decision.selectedHospitalId, 'H-2', 'ACCEPTED preferred although farther');
    eq(r.aws.decision.candidates.map(c => c.hospitalId), ['H-2', 'H-1'], 'order');
  });

  // ---------------------------------------------------------------- 10 required unit unavailable (D3)

  await check('10. required ICU unavailable blocks selection; the same status is ignored when ICU is not required', async () => {
    const down = withCapacity(hospital('H-1', 1), { emergency: 'AVAILABLE', trauma: 'AVAILABLE', icu: 'UNAVAILABLE' }, -3);
    const okH = withCapacity(hospital('H-2', 5), { emergency: 'AVAILABLE', trauma: 'AVAILABLE', icu: 'AVAILABLE' }, -3);
    const ev = { hospitals: [down, okH], events: [...accepted('H-1'), ...accepted('H-2')] };
    const r = await evaluateParity(ev, 'icu down');
    eq(rule(r, 'H-1', 'HC-OPS-02').reasonCode, 'OPERATIONAL_UNAVAILABLE', 'rule');
    eq(cand(r, 'H-1').verdict, 'INELIGIBLE', 'blocked');
    eq(r.aws.decision.selectedHospitalId, 'H-2', 'selection skips it');
    // rerouting: excluding the current destination must not land on the ICU-down hospital
    const reroute = await evaluateParity({ ...ev, hospitals: [down, okH, withCapacity(hospital('H-3', 9), { emergency: 'AVAILABLE', trauma: 'AVAILABLE', icu: 'AVAILABLE' }, -3)], events: [...ev.events, ...accepted('H-3')], context: 'destination-selection' }, 'icu down reroute');
    ok(reroute.aws.decision.selectedHospitalId !== 'H-1', 'reroute never picks the ICU-down hospital');
    const notRequired = await evaluateParity({ ...ev, requirement: requirement(CASE, ['EMERGENCY', 'TRAUMA']) }, 'icu not required');
    eq(cand(notRequired, 'H-1').verdict, 'ELIGIBLE', 'ICU status irrelevant when not required');
  });

  // ---------------------------------------------------------------- 11 failed route (D1)

  await check('11. failed route -> unknown ETA (null), never 0, never ranked closest', async () => {
    const near = hospital('H-NEAR', 1);
    const far = hospital('H-FAR', 9);
    const r = await evaluateParity({
      hospitals: [near, far], events: [...accepted('H-NEAR'), ...accepted('H-FAR')], failRouteFor: [locKey(near)],
    }, 'route failed');
    const t = r.aws.trace.candidates.find(c => c.hospitalId === 'H-NEAR')!;
    eq([t.transit.etaMinutes, t.transit.durationSeconds, t.transit.etaStatus], [null, null, 'UNKNOWN'], 'trace ETA');
    eq(r.aws.decision.candidates.map(c => c.hospitalId), ['H-FAR', 'H-NEAR'], 'unknown ETA sorts last');
    eq(r.aws.decision.selectedHospitalId, 'H-FAR', 'selection');
    eq(cand(r, 'H-NEAR').orderKey.etaKnown, false, 'orderKey');
  });

  // ---------------------------------------------------------------- 12 multi-case acceptance (D5)

  await check('12. one hospital holds valid acceptances for several cases at once (both environments)', async () => {
    const events = [
      requestedEvent('CASE-A', 'H-1'), requestedEvent('CASE-B', 'H-1'),
      responseEvent('CASE-A', 'H-1', 'ACCEPTED', { respondedMin: -2 }),
      responseEvent('CASE-B', 'H-1', 'ACCEPTED', { respondedMin: -1 }),
    ];
    const h = hospital('H-1', 1);
    const a = await evaluateParity({ hospitals: [h], events, requirement: requirement('CASE-A') }, 'multi-case A');
    const b = await evaluateParity({ hospitals: [h], events, requirement: requirement('CASE-B') }, 'multi-case B');
    eq(cand(a, 'H-1').verdict, 'ELIGIBLE', 'case A still ELIGIBLE after B answered');
    eq(cand(b, 'H-1').verdict, 'ELIGIBLE', 'case B ELIGIBLE');
    // a response for A newer than A's own acceptance revises it, whatever B did (per-case ordering)
    const late = [...events, responseEvent('CASE-A', 'H-1', 'REJECTED', { respondedMin: -0.5 })];
    const a2 = await evaluateParity({ hospitals: [h], events: late, requirement: requirement('CASE-A') }, 'multi-case late');
    eq(cand(a2, 'H-1').verdict, 'INELIGIBLE', 'A revised by its own newer response');
    eq(cand(await evaluateParity({ hospitals: [h], events: late, requirement: requirement('CASE-B') }, 'multi-case B2'), 'H-1').verdict, 'ELIGIBLE', 'B unaffected');
  });

  await check('   legacy hospital slot stays last-writer (frozen behaviour) while the engine sees both cases', () => {
    const h0 = hospital('H-1', 1);
    const respA = (responseEvent('CASE-A', 'H-1', 'ACCEPTED', { respondedMin: -5 }) as any).payload;
    const respB = (responseEvent('CASE-B', 'H-1', 'ACCEPTED', { respondedMin: -1 }) as any).payload;
    const env = { sourceType: 'hospital', sourceId: 'H-1' };
    const afterA = applyAcceptanceResponse(h0, respA, env, Date.parse(iso(0)));
    ok(afterA.kind === 'APPLIED', 'A applied');
    const afterB = applyAcceptanceResponse((afterA as { next: HospitalState }).next, respB, env, Date.parse(iso(0)));
    ok(afterB.kind === 'APPLIED', 'B applied');
    eq((afterB as { next: HospitalState }).next.operationalState.acceptanceCaseId, 'CASE-B', 'legacy slot = last writer (D5 lives on in legacy until promotion)');
  });

  // ---------------------------------------------------------------- 13 deterministic ordering

  await check('13. ordering: verdict -> ACCEPTED over LIMITED -> known ETA -> distance -> hospitalId (input order irrelevant)', async () => {
    const hs = [hospital('H-A', 2), hospital('H-B', 4), hospital('H-C', 6), hospital('H-D', 3), hospital('H-E', 8), hospital('H-F', 5)];
    const events = [
      ...accepted('H-A'),                                                                           // ACCEPTED, near
      ...accepted('H-B'),                                                                           // ACCEPTED, farther
      requestedEvent(CASE, 'H-C'), responseEvent(CASE, 'H-C', 'LIMITED', { caps: CAPS }),           // LIMITED (ELIGIBLE)
      requestedEvent(CASE, 'H-D'),                                                                  // pending, request outstanding
      requestedEvent(CASE, 'H-F'), responseEvent(CASE, 'H-F', 'REJECTED'),                          // INELIGIBLE
    ];
    const base = await evaluateParity({ hospitals: hs, events }, 'order');
    eq(base.aws.decision.candidates.map(c => c.hospitalId), ['H-A', 'H-B', 'H-C', 'H-D', 'H-E', 'H-F'], 'order');
    ['ELIGIBLE', 'ELIGIBLE', 'ELIGIBLE', 'PENDING_ACCEPTANCE', 'PENDING_ACCEPTANCE', 'INELIGIBLE'].forEach((v, i) =>
      eq(base.aws.decision.candidates[i].verdict, v, `verdict #${i}`));
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 10; i++) {
      const shuffled = [...hs].sort(() => rand() - 0.5);
      const r = await evaluateParity({ hospitals: shuffled, events: [...events].sort(() => rand() - 0.5) }, `order shuffle ${i}`);
      eq(r.aws.decision.candidates.map(c => c.hospitalId), ['H-A', 'H-B', 'H-C', 'H-D', 'H-E', 'H-F'], `shuffle ${i}`);
      eq(r.aws.trace.auditHash, base.aws.trace.auditHash, `auditHash stable under shuffle ${i}`);
    }
    // ties: identical location -> equal ETA and distance -> hospitalId decides
    const tie = await evaluateParity({ hospitals: [hospital('H-Z', 3), hospital('H-Y', 3)], events: [...accepted('H-Z'), ...accepted('H-Y')] }, 'tie');
    eq(tie.aws.decision.candidates.map(c => c.hospitalId), ['H-Y', 'H-Z'], 'tie broken by id');
  });

  // ---------------------------------------------------------------- 14 hash determinism

  await check('14. trace hashes are deterministic, environment-independent and evidence-sensitive', async () => {
    const hs = [hospital('H-1', 1), hospital('H-2', 3)];
    const events = [...accepted('H-1')];
    const a = await evaluateDual({ hospitals: hs, events });
    const b = await evaluateDual({ hospitals: hs, events });
    eq(a.aws.trace.auditHash, b.aws.trace.auditHash, 'repeat run auditHash');
    eq(a.aws.decision.snapshotHash, b.aws.decision.snapshotHash, 'repeat run snapshotHash');
    eq(a.aws.trace.auditHash, a.local.trace.auditHash, 'local == AWS auditHash');
    eq(a.aws.decision.snapshotHash, a.local.decision.snapshotHash, 'local == AWS snapshotHash');
    ok(/^[0-9a-f]{64}$/.test(a.aws.trace.auditHash as string), 'sha256 hex');
    // evidence-sensitive
    const changed = await evaluateDual({ hospitals: [hospital('H-1', 1), hospital('H-2', 3, { capabilities: { emergency: true } })], events });
    ok(changed.aws.decision.snapshotHash !== a.aws.decision.snapshotHash, 'snapshotHash changes with evidence');
    ok(changed.aws.trace.auditHash !== a.aws.trace.auditHash, 'auditHash changes with evidence');
    // policy sensitive: different configured freshness => different policyVersion recorded in the trace
    eq(a.aws.trace.policyVersion, 'prototype-defaults-2026-09-27', 'policy version recorded');
  });

  // ---------------------------------------------------------------- 17 financial / insurance unknown

  await check('17. emergency with unknown financial/insurance evidence is not blocked; both factors report UNKNOWN', async () => {
    const r = await evaluateParity({ hospitals: [hospital('H-1', 1)], events: accepted('H-1') }, 'unknown fin/ins');
    eq(cand(r, 'H-1').verdict, 'ELIGIBLE', 'not blocked');
    eq(r.aws.decision.outcome, 'SELECTED', 'selected');
    const fin = cand(r, 'H-1').contextualFactors.find(f => f.factorId === 'SF-FIN-EXPOSURE')!;
    const ins = cand(r, 'H-1').contextualFactors.find(f => f.factorId === 'SF-INS-COMPAT')!;
    eq([fin.level, fin.reasonCode, fin.affectsOrdering], ['UNKNOWN', 'NO_FINANCIAL_EVIDENCE', false], 'financial');
    eq([ins.level, ins.reasonCode, ins.affectsOrdering], ['UNKNOWN', 'NO_INSURANCE_EVIDENCE', false], 'insurance');
    eq(ins.value!.compatibility, 'UNKNOWN', 'compatibility');
    eq([r.aws.decision.coverage.withFinancialEvidence, r.aws.decision.coverage.withInsuranceEvidence], [0, 0], 'coverage is explicit');
  });

  // ---------------------------------------------------------------- 18 non-operational evidence

  await check('18. public / historical / unverified evidence can never satisfy or fail an operational rule', async () => {
    for (const ds of ['PUBLIC_LISTED', 'HISTORICAL', 'UNVERIFIED', 'NOT_DISCLOSED', 'UNKNOWN']) {
      for (const st of ['AVAILABLE', 'UNAVAILABLE'] as const) {
        const h = withCapacity(hospital('H-1', 1), { emergency: st, icu: st, trauma: st }, -2, ds);
        const r = await evaluateParity({ hospitals: [h], events: accepted('H-1') }, `${ds}/${st}`);
        eq([rule(r, 'H-1', 'HC-OPS-01').outcome, rule(r, 'H-1', 'HC-OPS-01').reasonCode], ['UNKNOWN', 'EVIDENCE_NOT_OPERATIONAL_GRADE'], `${ds}/${st} ED`);
        eq(rule(r, 'H-1', 'HC-OPS-02').outcome, 'UNKNOWN', `${ds}/${st} units`);
        ok(cand(r, 'H-1').verdict === 'ELIGIBLE', `${ds}/${st}: non-operational evidence neither blocks nor decides (acceptance governs)`);
      }
    }
    // a public listing with 500 historical ICU beds and seed UNKNOWN state: no operational PASS
    const seed = await evaluateParity({ hospitals: [hospital('H-1', 1)], events: [] }, 'seed unknown');
    eq([rule(seed, 'H-1', 'HC-OPS-01').outcome, rule(seed, 'H-1', 'HC-OPS-01').reasonCode], ['UNKNOWN', 'EVIDENCE_NOT_OPERATIONAL_GRADE'], 'seed state is UNKNOWN, not AVAILABLE');
    eq(cand(seed, 'H-1').verdict, 'PENDING_ACCEPTANCE', 'seed verdict');
    // seeded synthetic demo state carries no observation time: usable dataStatus, but UNTIMED -> UNKNOWN
    const demo = hospital('H-D', 1, { operationalState: { emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE', nicu: 'UNKNOWN', picu: 'UNKNOWN', ventilator: 'AVAILABLE', acceptance: 'UNKNOWN', source: 'SYNTHETIC_DEMO' } });
    const seeded = await evaluateParity({ hospitals: [demo], events: [] }, 'seeded synthetic');
    eq([rule(seeded, 'H-D', 'HC-OPS-01').outcome, rule(seeded, 'H-D', 'HC-OPS-01').reasonCode], ['UNKNOWN', 'EVIDENCE_UNTIMED'], 'seeded AVAILABLE without an observation time is not current evidence');
  });

  console.log(`\n[Test] Feasibility local/AWS frozen-evidence parity: ${passCount()} checks passed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
