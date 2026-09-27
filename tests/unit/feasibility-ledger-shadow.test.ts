import type { HospitalAvailabilityResponse, HospitalState } from '../../packages/domain-models/src';
import type { ETAResult, Location, MappingProvider, RouteRequest, RouteResult } from '../../packages/mapping/src';
import type { GeoPoint } from '../../packages/domain-models/src';
import { AcceptanceLedger } from '../../services/api/src/feasibility/acceptanceLedger';
import { assembleSnapshot } from '../../services/api/src/feasibility/snapshotAssembler';
import { FeasibilityShadow, toLegacyEligibility } from '../../services/api/src/feasibility/shadow';

const T0 = Date.parse('2026-09-27T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60000).toISOString();

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
function eq<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function resp(id: string, caseId: string, hospitalId: string, status: HospitalAvailabilityResponse['status'], respondedMin: number, validMin: number): HospitalAvailabilityResponse {
  return {
    responseId: id, requestId: `AR-${caseId}-${hospitalId}`, caseId, hospitalId, status,
    acceptedCapabilities: status === 'REJECTED' || status === 'UNAVAILABLE' ? [] : ['EMERGENCY', 'TRAUMA', 'ICU'],
    limitations: [], respondedAt: at(respondedMin), validUntil: at(validMin),
    responderRole: 'CLINICAL_COORDINATOR', source: 'SYNTHETIC_DEMO', trustedSource: 'SYNTHETIC_DEMO',
  };
}

function hospital(id: string, over: Partial<HospitalState> = {}): HospitalState {
  return {
    hospitalId: id,
    displayName: `Hospital ${id}`,
    address: { fullAddress: 'x', city: 'Bengaluru', district: 'Bengaluru Urban', state: 'Karnataka', country: 'India' },
    location: { latitude: 12.97, longitude: 77.59, coordinateSource: 'test' },
    capabilities: { emergency: true, trauma: true, icu: true },
    historicalCapacity: { icuBeds: 500 },
    operationalState: { emergency: 'AVAILABLE', icu: 'AVAILABLE', trauma: 'AVAILABLE', nicu: 'UNKNOWN', picu: 'UNKNOWN', ventilator: 'UNKNOWN', acceptance: 'UNKNOWN', source: 'SYNTHETIC_DEMO' },
    utilizationIndicators: [],
    provenance: [],
    verificationStatus: 'SYNTHETIC_DEMO',
    dataStatus: 'SYNTHETIC_DEMO',
    ...over,
  };
}

class RecordingMapping implements MappingProvider {
  readonly name = 'test';
  readonly calls: string[] = [];
  constructor(private readonly failFor: string[] = [], private readonly delayMs = 0) {}
  async geocode(): Promise<GeoPoint> { return { latitude: 12.9, longitude: 77.5 }; }
  async reverseGeocode(coordinates: GeoPoint): Promise<Location> {
    return { coordinates, address: 'test' } as unknown as Location;
  }
  async calculateRoute(req: RouteRequest): Promise<RouteResult> {
    const key = `${req.destination.latitude},${req.destination.longitude}`;
    this.calls.push(key);
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    if (this.failFor.includes(key)) throw new Error('provider down');
    return { distanceMeters: 4000, durationSeconds: 600, legs: [], provider: 'mock', synthetic: true, trafficAware: false, calculatedAt: at(0) };
  }
  async calculateDistance(): Promise<{ distanceMeters: number }> { return { distanceMeters: 4000 }; }
  async calculateETA(): Promise<ETAResult> { return { durationSeconds: 600, calculatedAt: at(0) }; }
}
const okMapping = (failFor: string[] = []) => new RecordingMapping(failFor);

const requirement = (caseId: string) => ({
  requirementId: `REQ-${caseId}`, caseId, requiredCapabilities: ['EMERGENCY', 'TRAUMA', 'ICU'] as const,
  optionalCapabilities: [], severity: 'CRITICAL' as const, createdAt: at(-10), source: 'assessment-engine',
});

async function main() {
  console.log('[Test] Feasibility acceptance ledger + shadow runner\n');

  // ---------------------------------------------------------------- ledger (D5)

  await check('D5: hospital H holds valid acceptances for case A and case B simultaneously', () => {
    const l = new AcceptanceLedger();
    eq(l.applyResponse(resp('r1', 'A', 'H', 'ACCEPTED', -5, 25)), 'APPLIED', 'A applied');
    eq(l.applyResponse(resp('r2', 'B', 'H', 'ACCEPTED', -1, 29)), 'APPLIED', 'B applied');
    eq(l.view('A', 'H', T0).response?.responseId, 'r1', 'A intact after B');
    eq(l.view('B', 'H', T0).response?.responseId, 'r2', 'B');
  });

  await check('D5: an older response for case A is not "stale" just because case B answered later', () => {
    const l = new AcceptanceLedger();
    l.applyResponse(resp('r2', 'B', 'H', 'ACCEPTED', -1, 29));
    eq(l.applyResponse(resp('r1', 'A', 'H', 'ACCEPTED', -5, 25)), 'APPLIED', 'per-case watermark');
  });

  await check('D5: a REJECTED for case B does not invalidate case A', () => {
    const l = new AcceptanceLedger();
    l.applyResponse(resp('r1', 'A', 'H', 'ACCEPTED', -5, 25));
    l.applyResponse(resp('r2', 'B', 'H', 'REJECTED', -1, 29));
    eq(l.view('A', 'H', T0).response?.status, 'ACCEPTED', 'A still accepted');
  });

  await check('Ledger preserves legacy idempotency and ordering rules per (case, hospital)', () => {
    const l = new AcceptanceLedger();
    eq(l.applyResponse(resp('r1', 'A', 'H', 'ACCEPTED', -5, 25)), 'APPLIED', 'first');
    eq(l.applyResponse(resp('r1', 'A', 'H', 'ACCEPTED', -5, 25)), 'DUPLICATE', 'duplicate responseId');
    eq(l.applyResponse(resp('r0', 'A', 'H', 'REJECTED', -10, 20)), 'STALE', 'older for same key');
    eq(l.applyResponse(resp('r3', 'A', 'H', 'ACCEPTED', -40, -1)), 'STALE', 'older and expired');
    eq(l.applyResponse(resp('r4', 'C', 'H', 'ACCEPTED', -40, -1)), 'APPLIED', 'late arrival is kept (the engine expires it at evaluation time)');
    eq(l.applyResponse(resp('r6', 'C', 'H', 'ACCEPTED', -40, -45)), 'INVALID', 'impossible window (validUntil before respondedAt)');
    eq(l.applyResponse(resp('r5', 'A', 'H', 'REJECTED', -1, 29)), 'APPLIED', 'newer revision');
    eq(l.view('A', 'H', T0).response?.status, 'REJECTED', 'revised');
  });

  await check('Ledger: hospital-wide UNAVAILABLE applies to all cases until a newer accepting response', () => {
    const l = new AcceptanceLedger();
    l.applyResponse(resp('u1', 'A', 'H', 'UNAVAILABLE', -5, 25));
    eq(l.view('Z', 'H', T0).hospitalWideUnavailable?.responseId, 'u1', 'applies to other case');
    l.applyResponse(resp('a1', 'B', 'H', 'ACCEPTED', -1, 29));
    eq(l.view('Z', 'H', T0).hospitalWideUnavailable, undefined, 'superseded');
  });

  await check('Ledger: request state OUTSTANDING -> REQUEST_EXPIRED; requestId mismatch is flagged, not rejected', () => {
    const l = new AcceptanceLedger();
    l.recordRequest({ requestId: 'AR-1', caseId: 'A', hospitalId: 'H', requestedAt: at(-1), expiresAt: at(14) });
    eq(l.view('A', 'H', T0).requestState, 'OUTSTANDING', 'outstanding');
    eq(l.view('A', 'H', T0 + 15 * 60000).requestState, 'REQUEST_EXPIRED', 'expired');
    l.applyResponse({ ...resp('r1', 'A', 'H', 'ACCEPTED', -1, 29), requestId: 'AR-demo' });
    eq(l.view('A', 'H', T0).requestIdMismatch, true, 'mismatch flagged');
    eq(l.view('A', 'H', T0).response?.responseId, 'r1', 'still applied');
  });

  // ---------------------------------------------------------------- snapshot

  await check('Snapshot: seeded operational state has no observation time -> UNTIMED (never assumed current)', () => {
    const s = assembleSnapshot({
      snapshotId: 'S', evaluatedAt: at(0), policyVersion: 'p', policyHash: 'x', trigger: { eventId: 'e', eventType: 't', sourceId: 's' },
      requirement: { ...requirement('A'), requiredCapabilities: ['EMERGENCY'] }, requirementProvenance: 'RULE_DERIVED',
    }, [hospital('H')], new AcceptanceLedger());
    eq(s.candidates[0].operational.observedAt, undefined, 'no observedAt');
  });

  await check('Snapshot: a CLAIMED capacity status (verificationStatus) is never read; only the trusted stamp counts (D11)', () => {
    const h = hospital('H', {
      operationalState: { ...hospital('H').operationalState, capacityAsOf: at(-1) },
      provenance: [{ sourceId: 'x', sourceName: 'Capacity Update', sourceType: 'hospital', retrievedAt: at(-1), verificationStatus: 'TOTALLY_REAL' as never, confidence: 1 }],
    });
    const s = assembleSnapshot({
      snapshotId: 'S', evaluatedAt: at(0), policyVersion: 'p', policyHash: 'x', trigger: { eventId: 'e', eventType: 't', sourceId: 's' },
      requirement: { ...requirement('A'), requiredCapabilities: ['EMERGENCY'] }, requirementProvenance: 'RULE_DERIVED',
    }, [h], new AcceptanceLedger());
    eq(s.candidates[0].operational.dataStatus, 'UNVERIFIED', 'sanitized');
  });

  await check('Snapshot is a copy: later store mutation does not change it', () => {
    const h = hospital('H');
    const s = assembleSnapshot({
      snapshotId: 'S', evaluatedAt: at(0), policyVersion: 'p', policyHash: 'x', trigger: { eventId: 'e', eventType: 't', sourceId: 's' },
      requirement: { ...requirement('A'), requiredCapabilities: ['EMERGENCY'] }, requirementProvenance: 'RULE_DERIVED',
    }, [h], new AcceptanceLedger());
    h.capabilities.trauma = false;
    eq(s.candidates[0].capabilities.value.trauma, true, 'snapshot unchanged');
  });

  // ---------------------------------------------------------------- shadow runner

  await check('Shadow: never mutates hospital state, records a trace, logs verdict disagreements', async () => {
    const ledger = new AcceptanceLedger();
    const hospitals = [
      hospital('H-OK'),
      hospital('H-UNLISTED', { capabilities: { emergency: true, icu: true } }), // D2: legacy says INELIGIBLE (missing), engine INDETERMINATE
    ];
    const before = JSON.stringify(hospitals);
    const logs: string[] = [];
    const shadow = new FeasibilityShadow({ hospitals: () => hospitals, ledger, mapping: okMapping(), log: m => logs.push(m) });
    const r = await shadow.evaluate({
      context: 'candidate-generation',
      requirement: requirement('A') as never,
      requirementProvenance: 'RULE_DERIVED',
      trigger: { eventId: 'e1', eventType: 'care.requirement.created', sourceId: 'assessment-engine' },
      origin: { latitude: 12.9, longitude: 77.5 },
      evaluatedAt: at(0),
      legacyCandidates: [
        { hospitalId: 'H-OK', operationalEligibility: 'ELIGIBLE' },          // legacy disagreement: no acceptance yet
        { hospitalId: 'H-UNLISTED', operationalEligibility: 'INELIGIBLE' },  // projection agrees (INDETERMINATE -> INELIGIBLE)
      ],
    });
    eq(JSON.stringify(hospitals), before, 'hospital state untouched');
    if (!r) throw new Error('shadow evaluation failed');
    eq(shadow.getTraces('A').length, 1, 'trace stored');
    eq(r.decision.candidates.find(c => c.hospitalId === 'H-UNLISTED')!.verdict, 'INDETERMINATE', 'engine verdict');
    const d = shadow.getDisagreements('A');
    eq(d.map(x => `${x.hospitalId}:${x.legacy}->${x.engine}`), ['H-OK:ELIGIBLE->PENDING_ACCEPTANCE'], 'disagreements');
    if (!logs.some(l => l.includes('DISAGREE'))) throw new Error('disagreement not logged');
  });

  await check('A1: INDETERMINATE projects to legacy INELIGIBLE, so it is never sent an acceptance request', () => {
    eq(toLegacyEligibility('INDETERMINATE'), 'INELIGIBLE', 'projection');
    eq(toLegacyEligibility('PENDING_ACCEPTANCE'), 'PENDING_ACCEPTANCE', 'pending');
  });

  await check('Shadow D1: route failure yields UNKNOWN ETA; selection disagreement is logged', async () => {
    const ledger = new AcceptanceLedger();
    const near = hospital('H-NEAR', { location: { latitude: 12.98, longitude: 77.6, coordinateSource: 'test' } });
    const far = hospital('H-FAR', { location: { latitude: 13.1, longitude: 77.7, coordinateSource: 'test' } });
    for (const h of ['H-NEAR', 'H-FAR']) ledger.recordRequest({ requestId: `AR-A-${h}`, caseId: 'A', hospitalId: h, requestedAt: at(-5), expiresAt: at(10) });
    ledger.applyResponse(resp('rn', 'A', 'H-NEAR', 'ACCEPTED', -1, 29));
    ledger.applyResponse(resp('rf', 'A', 'H-FAR', 'ACCEPTED', -1, 29));
    const mapping = okMapping(['12.98,77.6']);
    const shadow = new FeasibilityShadow({ hospitals: () => [near, far], ledger, mapping, log: () => undefined });
    const r = await shadow.evaluate({
      context: 'destination-selection',
      requirement: requirement('A') as never,
      requirementProvenance: 'RULE_DERIVED',
      trigger: { eventId: 'n/a', eventType: 'destination.selection', sourceId: 'test' },
      origin: { latitude: 12.9, longitude: 77.5 },
      evaluatedAt: at(0),
      // Legacy: route failure -> ETA 0 -> near hospital sorts first.
      legacySelection: { hospitalId: 'H-NEAR' },
    });
    eq(r!.decision.selectedHospitalId, 'H-FAR', 'engine picks known ETA');
    eq(r!.trace.candidates.find(c => c.hospitalId === 'H-NEAR')!.transit.etaMinutes, null, 'unknown ETA');
    eq(shadow.getDisagreements('A').map(d => d.kind), ['SELECTION'], 'selection disagreement');
  });

  await check('Shadow: mapping is called only for non-INELIGIBLE candidates', async () => {
    const mapping = okMapping();
    const shadow = new FeasibilityShadow({
      hospitals: () => [hospital('H-OK'), hospital('H-NO', { capabilities: { emergency: true, trauma: false, icu: true }, location: { latitude: 1, longitude: 1, coordinateSource: 't' } })],
      ledger: new AcceptanceLedger(), mapping, log: () => undefined,
    });
    await shadow.evaluate({ context: 'candidate-generation', requirement: requirement('A') as never, requirementProvenance: 'RULE_DERIVED',
      trigger: { eventId: 'e', eventType: 't', sourceId: 's' }, origin: { latitude: 12.9, longitude: 77.5 }, evaluatedAt: at(0) });
    eq(mapping.calls, ['12.97,77.59'], 'only the feasible candidate was routed');
  });

  await check('Shadow: internal failure is contained and returns undefined', async () => {
    const logs: string[] = [];
    const shadow = new FeasibilityShadow({
      hospitals: () => { throw new Error('store exploded'); },
      ledger: new AcceptanceLedger(), mapping: okMapping(), log: m => logs.push(m),
    });
    const r = await shadow.evaluate({ context: 'candidate-generation', requirement: requirement('A') as never, requirementProvenance: 'RULE_DERIVED',
      trigger: { eventId: 'e', eventType: 't', sourceId: 's' } });
    eq(r, undefined, 'contained');
    if (!logs.some(l => l.includes('evaluation failed'))) throw new Error('failure not logged');
  });

  console.log(`\n[Test] Feasibility ledger + shadow: ${passed} checks passed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
