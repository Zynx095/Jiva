import { randomUUID } from 'crypto';
import type { AnyEvent } from '../../../packages/event-schema/src';
import type { CapabilityType, CareRequirement, DataStatus, HospitalState, OperationalState } from '../../../packages/domain-models/src';
import type { MappingProvider } from '../../../packages/mapping/src';
import { LocalStateStore } from '../../../services/api/src/infrastructure/stateStore/LocalStateStore';
import type { IEventBus, EventHandler } from '../../../services/api/src/infrastructure/eventBus/types';
import { AcceptanceLedger, withTrust } from '../../../services/api/src/feasibility/acceptanceLedger';
import { FeasibilityShadow } from '../../../services/api/src/feasibility/shadow';
import type { ShadowContext } from '../../../services/api/src/feasibility/shadow';
import type { FreshnessPolicy } from '../../../packages/feasibility/src';
import { createStoreBackedShadow } from '../../../services/api/src/lambdas/core/deps';

// ------------------------------------------------------------------ tiny assertion helpers

let passed = 0;
export const passCount = () => passed;
export async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
export function eq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual) ?? 'undefined';
  const e = JSON.stringify(expected) ?? 'undefined';
  const clip = (v: string) => (v.length > 600 ? `${v.slice(0, 600)}…(${v.length} chars)` : v);
  if (a !== e) throw new Error(`${msg}: expected ${clip(e)}, got ${clip(a)}`);
}
export function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// ------------------------------------------------------------------ time

export const T0 = Date.parse('2026-09-27T10:00:00.000Z');
export const iso = (min: number, base = T0) => new Date(base + min * 60000).toISOString();
export const SEED_TIME = iso(-60 * 24 * 30);

// ------------------------------------------------------------------ fixtures

export const CASE = 'CASE-A';
export const ORIGIN = { latitude: 13.0358, longitude: 77.597 };
export const CAPS: CapabilityType[] = ['EMERGENCY', 'TRAUMA', 'ICU'];

export function requirement(caseId = CASE, caps: CapabilityType[] = CAPS): CareRequirement {
  return {
    requirementId: `REQ-${caseId}`,
    caseId,
    requiredCapabilities: caps,
    optionalCapabilities: [],
    severity: 'CRITICAL',
    createdAt: iso(-10),
    source: 'assessment-engine',
  };
}

const UNKNOWN_OP: OperationalState = {
  emergency: 'UNKNOWN', icu: 'UNKNOWN', trauma: 'UNKNOWN', nicu: 'UNKNOWN', picu: 'UNKNOWN', ventilator: 'UNKNOWN',
  acceptance: 'UNKNOWN', source: 'UNKNOWN',
};

/** Hospital record as the state store holds it. Location index makes ETA/distance distinct per id. */
export function hospital(id: string, idx = 1, over: Partial<HospitalState> = {}): HospitalState {
  return {
    hospitalId: id,
    displayName: `Hospital ${id}`,
    address: { fullAddress: 'x', city: 'Bengaluru', district: 'Bengaluru Urban', state: 'Karnataka', country: 'India' },
    location: { latitude: 13.0 + idx * 0.02, longitude: 77.6 + idx * 0.02, coordinateSource: 'test' },
    capabilities: { emergency: true, trauma: true, icu: true, ventilator: true },
    historicalCapacity: { icuBeds: 500, totalBeds: 900 },
    operationalState: { ...UNKNOWN_OP },
    utilizationIndicators: [],
    provenance: [{ sourceId: 'registry', sourceName: 'Registry', sourceType: 'GOVERNMENT_REGISTRY', retrievedAt: SEED_TIME, verificationStatus: 'PUBLIC_LISTED', confidence: 0.9 }],
    verificationStatus: 'PUBLIC_LISTED',
    dataStatus: 'PUBLIC_LISTED',
    ...over,
  };
}

/** Apply a capacity report the way the capacity handler records it (capacityAsOf + provenance). */
export function withCapacity(
  h: HospitalState,
  statuses: Partial<Pick<OperationalState, 'emergency' | 'icu' | 'trauma' | 'ventilator' | 'nicu' | 'picu'>>,
  asOfMin: number,
  dataStatus: DataStatus | string = 'HOSPITAL_CONFIRMED'
): HospitalState {
  const at = iso(asOfMin);
  return {
    ...h,
    operationalState: { ...h.operationalState, ...statuses, capacityAsOf: at, source: 'HOSPITAL_CONFIRMED' },
    provenance: [...h.provenance, {
      sourceId: h.hospitalId, sourceName: 'Capacity Update', sourceType: 'hospital', retrievedAt: at, asOf: at,
      verificationStatus: dataStatus as DataStatus,
      // the trusted grade the ingestion adapter would have stamped (the claim above is never read)
      trustedStatus: dataStatus as DataStatus, confidence: 1,
    }],
  };
}

// ------------------------------------------------------------------ events

const base = (eventType: string, timestamp: string, source: { type: string; id: string }, payload: unknown, extra: object = {}) =>
  ({ eventId: randomUUID(), eventType, timestamp, version: '1.0', source, payload, ...extra }) as unknown as AnyEvent;

export const requestedEvent = (caseId: string, hospitalId: string, atMin = -3, ttlMin = 15, caps: string[] = CAPS) =>
  base('hospital.acceptance.requested', iso(atMin), { type: 'system', id: 'acceptance-protocol' }, {
    requestId: `AR-${caseId}-${hospitalId}`, caseId, hospitalId, requiredCapabilities: caps, optionalCapabilities: [],
    requestedAt: iso(atMin), expiresAt: iso(atMin + ttlMin),
  });

export function responseEvent(
  caseId: string, hospitalId: string, status: 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'UNAVAILABLE',
  o: { respondedMin?: number; validMin?: number; caps?: string[]; limitations?: string[]; responseId?: string; source?: string; trusted?: string | null; requestId?: string; role?: string } = {}
) {
  const respondedMin = o.respondedMin ?? -2;
  return base('hospital.acceptance.received', iso(respondedMin), { type: 'hospital', id: hospitalId }, {
    responseId: o.responseId || `R-${randomUUID().slice(0, 8)}`,
    requestId: o.requestId ?? `AR-${caseId}-${hospitalId}`, caseId, hospitalId, status,
    acceptedCapabilities: o.caps ?? (status === 'REJECTED' || status === 'UNAVAILABLE' ? [] : CAPS),
    limitations: o.limitations ?? [], respondedAt: iso(respondedMin), validUntil: iso(o.validMin ?? 30),
    responderRole: o.role ?? 'CLINICAL_COORDINATOR', source: o.source || 'HOSPITAL_CONFIRMED',
  }, o.trusted === null ? {} : { metadata: { sourceType: 'test', trustedEvidence: { status: o.trusted ?? o.source ?? 'HOSPITAL_CONFIRMED', environment: 'DEMO' } } });
}

export const capacityEvent = (hospitalId: string, statuses: { emergencyStatus?: string; traumaStatus?: string; icuStatus?: string; ventilatorStatus?: string }, atMin = -1) =>
  base('hospital.capacity.updated', iso(atMin), { type: 'hospital', id: hospitalId }, {
    hospitalId, emergencyStatus: 'UNKNOWN', traumaStatus: 'UNKNOWN', icuStatus: 'UNKNOWN', ventilatorStatus: 'UNKNOWN', ...statuses,
  }, { metadata: { confidence: 1, sourceType: 'SYNTHETIC_DEMO', trustedEvidence: { status: 'SYNTHETIC_DEMO', environment: 'DEMO' } } });

// ------------------------------------------------------------------ doubles

/** Deterministic route stub: distance/duration are pure functions of the coordinates. */
export function stubMapping(failFor: string[] = []): MappingProvider {
  return {
    name: 'stub',
    async geocode() { return ORIGIN; },
    async reverseGeocode(c) { return { coordinates: c, address: 'stub' }; },
    async calculateDistance() { return { distanceMeters: 0 }; },
    async calculateETA() { return { durationSeconds: 0, calculatedAt: iso(0) }; },
    async calculateRoute(req) {
      const key = `${req.destination.latitude},${req.destination.longitude}`;
      if (failFor.includes(key)) throw new Error('provider down');
      const dLat = (req.destination.latitude - req.origin.latitude) * 111000;
      const dLng = (req.destination.longitude - req.origin.longitude) * 108000;
      const meters = Math.round(Math.sqrt(dLat * dLat + dLng * dLng) * 1.3);
      return { distanceMeters: meters, durationSeconds: Math.round(meters / 8), legs: [], provider: 'mock', synthetic: true, trafficAware: false, sourceType: 'synthetic' };
    },
  } as MappingProvider;
}

export const locKey = (h: HospitalState) => `${h.location!.latitude},${h.location!.longitude}`;

export class MemoryBus implements IEventBus {
  published: AnyEvent[] = [];
  failPublish = false;
  private handlers = new Map<string, EventHandler[]>();
  async publish(event: AnyEvent) {
    if (this.failPublish) throw new Error('bus down');
    this.published.push(event);
    for (const h of [...(this.handlers.get(event.eventType) || []), ...(this.handlers.get('*') || [])]) await h(event);
  }
  on(t: string, h: EventHandler) { this.handlers.set(t, [...(this.handlers.get(t) || []), h]); }
  off(t: string, h: EventHandler) { this.handlers.set(t, (this.handlers.get(t) || []).filter(x => x !== h)); }
  async isHealthy() { return true; }
  getProviderName() { return 'MemoryBus'; }
  ofType(t: string) { return this.published.filter(e => e.eventType === t); }
}

/**
 * Minimal EventBridge: delivers published events to the lambda handlers per the CDK rules
 * (see aws-stack.ts), FIFO, until quiescent. Events with no matching rule go nowhere.
 */
export class EventRouter {
  readonly bus = new MemoryBus();
  private queue: AnyEvent[] = [];
  readonly deliveries: { eventType: string; target: string }[] = [];
  constructor(private rules: { target: string; detailTypes: string[]; handler: (e: { 'detail-type': string; detail: any }) => Promise<unknown> }[]) {
    const publish = this.bus.publish.bind(this.bus);
    this.bus.publish = async (event: AnyEvent) => { await publish(event); this.queue.push(event); };
  }
  async send(event: AnyEvent) {
    this.queue.push(event);
    await this.drain();
  }
  async drain() {
    let guard = 0;
    while (this.queue.length) {
      if (guard++ > 500) throw new Error('event storm');
      const event = this.queue.shift()!;
      for (const r of this.rules) {
        if (r.detailTypes.includes(event.eventType)) {
          this.deliveries.push({ eventType: event.eventType, target: r.target });
          await r.handler({ 'detail-type': event.eventType, detail: JSON.parse(JSON.stringify(event)) });
        }
      }
    }
  }
}

// ------------------------------------------------------------------ dual (local-style vs AWS-style) evaluation

export interface Evidence {
  hospitals: HospitalState[];
  /** acceptance requested/received events, in arrival order */
  events: AnyEvent[];
  requirement?: CareRequirement;
  evaluatedAt?: string;
  failRouteFor?: string[];
  /** Effective policy for BOTH sides (default: prototype defaults, DEMO environment). */
  policy?: FreshnessPolicy;
  /** ETA is computed only for non-INELIGIBLE candidates. */
  context?: ShadowContext;
}

/** Deterministic, uuid-shaped ids (the event schema requires uuid eventIds). */
export const counter = () => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; };

export interface DualResult {
  local: NonNullable<Awaited<ReturnType<FeasibilityShadow['evaluate']>>>;
  aws: NonNullable<Awaited<ReturnType<FeasibilityShadow['evaluate']>>>;
  localEvents: AnyEvent[];
  awsEvents: AnyEvent[];
  awsStore: LocalStateStore;
}

/**
 * The same FROZEN evidence evaluated two ways:
 *  local: live in-memory ledger fed by the acceptance hooks (as stateEngines does)
 *  aws:   store-backed shadow whose ledger is rebuilt from the recorded event history
 * Both use identical injected clock/ids/mapping, so every byte of the result is comparable.
 */
export async function evaluateDual(ev: Evidence): Promise<DualResult> {
  const evaluatedAt = ev.evaluatedAt || iso(0);
  const req = ev.requirement || requirement();
  const mapping = () => stubMapping(ev.failRouteFor || []);
  const trigger = { eventId: '11111111-1111-4111-8111-111111111111', eventType: 'care.requirement.created', sourceId: 'assessment-engine' };
  const input = { context: ev.context || 'candidate-generation', requirement: req, requirementProvenance: 'RULE_DERIVED' as const, trigger, origin: ORIGIN, originAsOf: iso(-1), evaluatedAt };

  // local-style
  const live = new AcceptanceLedger();
  for (const e of ev.events) {
    const p = (e as any).payload;
    if (e.eventType === 'hospital.acceptance.requested') live.recordRequest(p);
    else if (e.eventType === 'hospital.acceptance.received') live.applyResponse(withTrust(p, (e as any).metadata));
    else if ((e.eventType as string) === 'hospital.acceptance.cancelled') live.applyCancellation(p);
  }
  const localEvents: AnyEvent[] = [];
  const local = new FeasibilityShadow({
    hospitals: () => ev.hospitals, ledger: live, mapping: mapping(), log: () => undefined, policy: ev.policy,
    clock: () => evaluatedAt, newId: counter(), publishTrace: async e => { localEvents.push(e as unknown as AnyEvent); },
  });

  // AWS-style
  const store = new LocalStateStore();
  for (const h of ev.hospitals) await store.setHospital(JSON.parse(JSON.stringify(h)));
  // Mirror what the lambda cores do inline for every acceptance-protocol event: record the audit
  // event AND update the materialized index the shadow now reads (see materializedAcceptance.ts).
  for (const e of ev.events) {
    await store.recordEvent(e);
    const p: any = (e as any).payload;
    if (e.eventType === 'hospital.acceptance.requested') await store.putAcceptanceRequest!(p.caseId, p.hospitalId, p);
    else if (e.eventType === 'hospital.acceptance.received') await store.putAcceptanceResponse!(p.caseId, p.hospitalId, withTrust(p, (e as any).metadata));
    else if ((e.eventType as string) === 'hospital.acceptance.cancelled') await store.putAcceptanceCancellation!(p.caseId, p.hospitalId, p.requestId, p.cancelledAt);
  }
  const bus = new MemoryBus();
  const aws = createStoreBackedShadow({ store, bus, mapping: mapping(), log: () => undefined, clock: () => evaluatedAt, newId: counter(), policy: ev.policy });

  const l = await local.evaluate(input);
  const a = await aws.evaluate(input);
  if (!l || !a) throw new Error('shadow evaluation failed');
  return { local: l, aws: a, localEvents, awsEvents: bus.published, awsStore: store };
}

/** Assert local-style and AWS-style are byte-identical, then return the AWS-style result. */
export async function evaluateParity(ev: Evidence, label: string): Promise<DualResult> {
  const r = await evaluateDual(ev);
  eq(r.aws.decision, r.local.decision, `${label}: decision parity`);
  eq(r.aws.trace, r.local.trace, `${label}: trace parity (incl. auditHash)`);
  eq(r.awsEvents.map(e => (e as any).payload), r.localEvents.map(e => (e as any).payload), `${label}: trace event payload parity`);
  return r;
}

export const cand = (r: DualResult, id: string) => r.aws.decision.candidates.find(c => c.hospitalId === id)!;
export const rule = (r: DualResult, id: string, ruleId: string) => cand(r, id).hardConstraints.find(c => c.ruleId === ruleId)!;
