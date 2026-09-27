import { v4 as uuidv4 } from 'uuid';
import type { AnyEvent } from '@jiva/event-schema';
import type { CareRequirement } from '@jiva/domain-models';
import type { MappingProvider } from '@jiva/mapping';
import type { IStateStore } from '../../infrastructure/stateStore/types';
import type { IEventBus } from '../../infrastructure/eventBus/types';
import { AcceptanceLedger, type AcceptanceView } from '../../feasibility/acceptanceLedger';
import { MaterializedAcceptanceView } from '../../infrastructure/stateStore/materializedAcceptance';
import { FeasibilityShadow } from '../../feasibility/shadow';
import type { FreshnessPolicy } from '@jiva/feasibility';

/**
 * Dependencies of the AWS lambda cores. Handlers are built by factories over these so the exact
 * same code runs against DynamoDB/EventBridge in AWS and against in-memory doubles in tests —
 * that is what makes local/AWS parity testable without a deployment.
 */
export interface LambdaDeps {
  store: IStateStore;
  bus: IEventBus;
  mapping: MappingProvider;
  /** Shadow feasibility runner (observability only). Omit to disable. */
  shadow?: FeasibilityShadow;
  now?: () => number;
  newId?: () => string;
}

export const nowMs = (d: LambdaDeps) => (d.now ? d.now() : Date.now());
export const nowIso = (d: LambdaDeps) => new Date(nowMs(d)).toISOString();
export const newId = (d: LambdaDeps) => (d.newId ? d.newId() : uuidv4());

/** Publish a system event (same envelope local stateEngines use). */
export function publishSystem(d: LambdaDeps, event: Record<string, unknown>): Promise<void> {
  return d.bus.publish({
    eventId: newId(d),
    timestamp: nowIso(d),
    version: '1.0',
    ...event,
  } as unknown as AnyEvent);
}

/**
 * Record an event in the history BEFORE publishing it. Used for acceptance requests so the
 * outstanding-request ledger is consistent immediately (the consuming lambda then sees a duplicate
 * eventId and skips, which is harmless: it does nothing for requests beyond recording them).
 */
export async function recordThenPublish(d: LambdaDeps, event: Record<string, unknown>): Promise<void> {
  const full = { eventId: newId(d), timestamp: nowIso(d), version: '1.0', ...event } as unknown as AnyEvent;
  await d.store.recordEvent(full);
  await d.bus.publish(full);
}

const RECENT_EVENT_WINDOW = 500;

/**
 * Acceptance ledger rebuilt from the event history: this case's events plus a recent window of all
 * events (so a hospital-wide UNAVAILABLE reported for another case is visible). Only acceptance
 * requested/received events are ever consulted (see AcceptanceLedger.fromEvents).
 *
 * `before` restricts to events strictly earlier than the given (timestamp, eventId): used for the
 * duplicate-responseId check so that of two events sharing a responseId exactly one (the earliest)
 * is treated as first — no symmetric "both ignored" outcome under concurrent lambdas.
 */
export async function loadLedger(
  store: IStateStore,
  caseId: string,
  before?: { timestamp: string; eventId: string }
): Promise<AcceptanceLedger> {
  const [caseEvents, recent] = await Promise.all([store.queryEventsByCase(caseId), store.listRecentEvents(RECENT_EVENT_WINDOW)]);
  const byId = new Map<string, AnyEvent>();
  for (const e of [...recent, ...caseEvents]) byId.set(e.eventId, e);
  let events = [...byId.values()];
  if (before) {
    events = events.filter(e => e.timestamp < before.timestamp || (e.timestamp === before.timestamp && e.eventId < before.eventId));
  }
  return AcceptanceLedger.fromEvents(events);
}

/** Latest care requirement for a case, reconstructed from history. */
export async function loadRequirement(store: IStateStore, caseId: string): Promise<CareRequirement | undefined> {
  const events = (await store.queryEventsByCase(caseId))
    .filter(e => e.eventType === 'care.requirement.created' && e.payload.caseId === caseId)
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  const e = events[0];
  if (!e || e.eventType !== 'care.requirement.created') return undefined;
  const p = e.payload;
  return {
    requirementId: p.requirementId,
    caseId: p.caseId,
    requiredCapabilities: p.requiredCapabilities as CareRequirement['requiredCapabilities'],
    optionalCapabilities: p.optionalCapabilities as CareRequirement['optionalCapabilities'],
    severity: p.severity,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    source: e.source.id,
  };
}

/**
 * Build the store-backed shadow runner used by the AWS lambdas. The trace event is recorded in
 * the history (audit) and published to the bus; no rule routes it to any processor.
 */
/**
 * Acceptance evidence for one evaluation. If the store implements the materialized indexes
 * (both LocalStateStore and DynamoStateStore do), reads are O(1) indexed lookups scoped to exactly
 * the hospitals being evaluated — no event-history window of any size. Otherwise this falls back to
 * `loadLedger`'s bounded event-replay (kept only for a store that implements neither).
 */
export async function loadAcceptanceView(store: IStateStore, caseId: string, hospitalIds: string[], evaluatedAtMs: number): Promise<AcceptanceView> {
  if (store.getAcceptanceRecord && store.getHospitalWideUnavailable) {
    const getAcceptanceRecord = store.getAcceptanceRecord.bind(store);
    const getHospitalWideUnavailable = store.getHospitalWideUnavailable.bind(store);
    return new MaterializedAcceptanceView({ getAcceptanceRecord, getHospitalWideUnavailable }).preload(caseId, hospitalIds, evaluatedAtMs);
  }
  return loadLedger(store, caseId);
}

export function createStoreBackedShadow(deps: { store: IStateStore; bus: IEventBus; mapping: MappingProvider; log?: (m: string) => void; clock?: () => string; newId?: () => string; timeoutMs?: number; policy?: FreshnessPolicy }): FeasibilityShadow {
  return new FeasibilityShadow({
    hospitals: () => deps.store.listHospitals(),
    ledger: (caseId, hospitalIds, evaluatedAtMs) => loadAcceptanceView(deps.store, caseId, hospitalIds, evaluatedAtMs),
    requirementSource: caseId => (deps.store.getLatestRequirement ? deps.store.getLatestRequirement(caseId) : loadRequirement(deps.store, caseId)),
    mapping: deps.mapping,
    log: deps.log,
    clock: deps.clock,
    newId: deps.newId,
    timeoutMs: deps.timeoutMs,
    policy: deps.policy,
    publishTrace: async event => {
      await deps.store.recordEvent(event);
      await deps.bus.publish(event);
    },
  });
}
