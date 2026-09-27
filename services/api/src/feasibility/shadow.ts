import { v4 as uuidv4 } from 'uuid';
import type {
  CareRequirement,
  DecisionTraceRecord,
  FeasibilityDecision,
  FeasibilitySnapshot,
  FeasibilityVerdict,
  GeoPoint,
  HospitalCandidate,
  HospitalState,
} from '@jiva/domain-models';
import type { MappingProvider } from '@jiva/mapping';
import {
  buildDecisionTrace,
  createFreshnessPolicy,
  evaluateFeasibility,
  FreshnessPolicy,
  hashPolicy,
  screenCandidates,
} from '@jiva/feasibility';
import { evidenceEnvironment } from '../evidenceTrust';
import type { FeasibilityTraceRecorded } from '@jiva/event-schema';
import { AcceptanceLedger, type AcceptanceView } from './acceptanceLedger';
import { assembleSnapshot } from './snapshotAssembler';
import { buildTraceEvent, buildTraceEventPayload } from './traceEvent';
import { enrichTransport } from './transportEnricher';

/**
 * SHADOW MODE runner for the Care Feasibility Engine.
 *
 * The engine runs alongside the legacy eligibility engine and NEVER controls a decision:
 * it writes no hospital/ambulance/patient state, triggers no acceptance/dispatch/routing, and its
 * failures are swallowed. It records a DecisionTraceRecord, logs every disagreement with the
 * legacy result, and - as OBSERVABILITY ONLY - hands a `feasibility.trace.recorded` event to the
 * injected `publishTrace` AFTER the decision has been fully computed. The emission result is never
 * read back: it cannot influence the decision that produced it.
 */

export type FeasibilityMode = 'off' | 'shadow';

/** Trace events are on by default in shadow mode; FEASIBILITY_TRACE_EVENTS=off silences publication. */
export function traceEventsEnabled(): boolean {
  return (process.env.FEASIBILITY_TRACE_EVENTS || 'on').toLowerCase() !== 'off';
}

export function feasibilityMode(): FeasibilityMode {
  const raw = (process.env.FEASIBILITY_ENGINE || 'shadow').toLowerCase();
  if (raw === 'off') return 'off';
  if (raw !== 'shadow') {
    console.warn(`[FeasibilityShadow] FEASIBILITY_ENGINE=${raw} is not enabled in this phase; running in shadow mode.`);
  }
  return 'shadow';
}

/** Effective policy = prototype defaults + FEASIBILITY_POLICY_OVERRIDES + the deployment evidence environment. */
function loadPolicy(): FreshnessPolicy {
  const environment = evidenceEnvironment();
  const raw = process.env.FEASIBILITY_POLICY_OVERRIDES;
  if (!raw) return createFreshnessPolicy({}, undefined, { environment });
  try {
    return createFreshnessPolicy(JSON.parse(raw), undefined, { environment });
  } catch {
    console.warn('[FeasibilityShadow] FEASIBILITY_POLICY_OVERRIDES is not valid JSON; using prototype defaults.');
    return createFreshnessPolicy({}, undefined, { environment });
  }
}

/** Default wall-clock budget for one shadow evaluation (service layer; the pure package has no timers). */
export const DEFAULT_SHADOW_TIMEOUT_MS = 2000;
function shadowTimeoutMs(): number {
  const raw = process.env.FEASIBILITY_SHADOW_TIMEOUT_MS;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SHADOW_TIMEOUT_MS;
}

/**
 * Soak instrumentation: how the shadow behaves over time. `legacyAuthoritative` is always true in
 * this phase. Every failure counted here is one where a promoted engine would have had to fall back
 * to the legacy result (which is exactly what happens today, because legacy is the only authority).
 */
export interface ShadowSoakSummary {
  legacyAuthoritative: true;
  started: number;
  completed: number;
  errors: number;
  timeouts: number;
  policyMismatches: number;
  traceSinkFailures: number;
  disagreements: number;
  /** Evaluations a promoted engine could NOT have used (error + timeout). */
  wouldHaveFallenBack: number;
}

export interface ShadowFailure { at: string; caseId: string; context: string; kind: 'ERROR' | 'TIMEOUT'; message: string }

/** Observation of the destination an ambulance currently holds. Observational only: never triggers routing. */
export interface DestinationObservation {
  at: string;
  caseId: string;
  hospitalId: string;
  verdict: FeasibilityVerdict;
  feasible: boolean;
  blockingReasons: string[];
  snapshotHash: string;
  policyHash: string;
}

/** Legacy projection: INDETERMINATE is conservatively shown as INELIGIBLE (not asked, not routed). */
export function toLegacyEligibility(v: FeasibilityVerdict): HospitalCandidate['operationalEligibility'] {
  return v === 'ELIGIBLE' ? 'ELIGIBLE' : v === 'PENDING_ACCEPTANCE' ? 'PENDING_ACCEPTANCE' : 'INELIGIBLE';
}

export interface ShadowDisagreement {
  at: string;
  caseId: string;
  context: ShadowContext;
  traceId: string;
  kind: 'VERDICT' | 'SELECTION';
  hospitalId?: string;
  legacy: string;
  engine: string;
  engineReasons: string[];
}

export type ShadowContext = 'candidate-generation' | 'destination-selection' | 'current-destination';

const MAX_TRACES_PER_CASE = 50;
const MAX_CASES = 200;
const MAX_DISAGREEMENTS = 1000;

export interface ShadowDeps {
  /** Hospital master + operational state. Async so AWS can read DynamoDB. */
  hospitals: () => Iterable<HospitalState> | Promise<Iterable<HospitalState>>;
  /**
   * Acceptance evidence source: a live projection (local, unbounded) or a per-evaluation lookup
   * (AWS: materialized indexes when the store exposes them, else a bounded event-history rebuild).
   * The factory form receives the ids of the hospitals actually being evaluated, so a store-backed
   * view can preload exactly those keys instead of guessing a history window.
   */
  ledger: AcceptanceView | ((caseId: string, hospitalIds: string[], evaluatedAtMs: number) => AcceptanceView | Promise<AcceptanceView>);
  mapping: MappingProvider;
  policy?: FreshnessPolicy;
  log?: (msg: string) => void;
  /** Wall-clock budget per evaluation in ms (0 disables). Default FEASIBILITY_SHADOW_TIMEOUT_MS or 2000. */
  timeoutMs?: number;
  /** Injectable for deterministic tests. Defaults: wall clock / uuid. */
  clock?: () => string;
  newId?: () => string;
  /** Where the case's real requirement comes from when the caller has only a fallback. */
  requirementSource?: (caseId: string) => CareRequirement | undefined | Promise<CareRequirement | undefined>;
  /** Observability sink for the trace event. Output only; its result/failure never affects decisions. */
  publishTrace?: (event: FeasibilityTraceRecorded) => Promise<void>;
}

export class FeasibilityShadow {
  readonly policy: FreshnessPolicy;
  private traces = new Map<string, DecisionTraceRecord[]>();
  private disagreements: ShadowDisagreement[] = [];
  private requirements = new Map<string, CareRequirement>();
  /** Incremented by reset(); in-flight evaluations from an earlier generation drop their output. */
  private generation = 0;
  private traceEventFailures = 0;
  private failures: ShadowFailure[] = [];
  private soak = { started: 0, completed: 0, errors: 0, timeouts: 0, policyMismatches: 0, totalDisagreements: 0 };
  private destinationObservations = new Map<string, DestinationObservation[]>();

  constructor(private readonly deps: ShadowDeps) {
    this.policy = deps.policy || loadPolicy();
  }

  reset(): void {
    this.generation++;
    this.traces.clear();
    this.disagreements = [];
    this.requirements.clear();
    this.failures = [];
    this.destinationObservations.clear();
    this.soak = { started: 0, completed: 0, errors: 0, timeouts: 0, policyMismatches: 0, totalDisagreements: 0 };
  }

  /** Bound any auxiliary shadow-side await (e.g. the requirement history query) by the shadow budget. */
  async bounded<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const budget = this.deps.timeoutMs ?? shadowTimeoutMs();
    if (!budget) return fn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'TIMEOUT'>(resolve => {
      timer = setTimeout(() => resolve('TIMEOUT'), budget);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      const r = await Promise.race([fn(), timedOut]);
      if (r === 'TIMEOUT') {
        this.recordFailure({ caseId: 'n/a', context: 'auxiliary-read', kind: 'TIMEOUT', message: `shadow-side read exceeded ${budget} ms` });
        return undefined;
      }
      return r as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getSoakSummary(): ShadowSoakSummary {
    const s = this.soak;
    return {
      legacyAuthoritative: true,
      started: s.started, completed: s.completed, errors: s.errors, timeouts: s.timeouts,
      policyMismatches: s.policyMismatches, traceSinkFailures: this.traceEventFailures,
      disagreements: s.totalDisagreements, wouldHaveFallenBack: s.errors + s.timeouts,
    };
  }

  getFailures(caseId?: string): ShadowFailure[] {
    return this.failures.filter(f => !caseId || f.caseId === caseId);
  }

  getDestinationObservations(caseId?: string): DestinationObservation[] {
    if (caseId) return [...(this.destinationObservations.get(caseId) || [])];
    return [...this.destinationObservations.values()].flat();
  }

  private recordFailure(f: Omit<ShadowFailure, 'at'>): void {
    this.failures.push({ at: new Date().toISOString(), ...f });
    if (this.failures.length > MAX_DISAGREEMENTS) this.failures.splice(0, this.failures.length - MAX_DISAGREEMENTS);
  }

  getTraceEventFailureCount(): number {
    return this.traceEventFailures;
  }

  /** Remember the case's actual requirement (legacy selectDestination hard-codes severity; D7). */
  recordRequirement(r: CareRequirement): void {
    this.requirements.set(r.caseId, { ...r, requiredCapabilities: [...r.requiredCapabilities], optionalCapabilities: [...r.optionalCapabilities] });
  }

  requirementFor(caseId: string): CareRequirement | undefined {
    return this.requirements.get(caseId);
  }

  /** Recorded requirement if any, else the injected source (AWS: latest care.requirement.created). */
  async resolveRequirement(caseId: string): Promise<CareRequirement | undefined> {
    return this.requirements.get(caseId) || (this.deps.requirementSource ? await this.deps.requirementSource(caseId) : undefined);
  }

  getTraces(caseId?: string): DecisionTraceRecord[] {
    if (caseId) return [...(this.traces.get(caseId) || [])];
    return [...this.traces.values()].flat();
  }

  getDisagreements(caseId?: string): ShadowDisagreement[] {
    return this.disagreements.filter(d => !caseId || d.caseId === caseId);
  }

  async evaluate(input: {
    context: ShadowContext;
    requirement: CareRequirement;
    requirementProvenance: 'RULE_DERIVED' | 'CLINICIAN_CONFIRMED';
    trigger: { eventId: string; eventType: string; sourceId: string; sourceType?: string };
    origin?: GeoPoint;
    originAsOf?: string;
    ambulanceId?: string;
    excludedHospitalIds?: string[];
    /** Hospital snapshot the legacy engine used (AWS passes it so both see identical state). */
    hospitals?: Iterable<HospitalState>;
    evaluatedAt?: string;
    legacyCandidates?: Pick<HospitalCandidate, 'hospitalId' | 'operationalEligibility'>[];
    /** Present for destination-selection: the hospital the legacy engine picked (undefined = none). */
    legacySelection?: { hospitalId?: string };
    /** false = compute only (used by observeDestination): no stored trace, no comparison, no trace event. */
    record?: boolean;
  }): Promise<{ decision: FeasibilityDecision; trace: DecisionTraceRecord } | undefined> {
    const log = this.deps.log || ((m: string) => console.log(m));
    const budget = this.deps.timeoutMs ?? shadowTimeoutMs();
    const cancel = { cancelled: false };
    if (input.record !== false) this.soak.started++;
    const work = this.run(input, cancel);
    if (!budget) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'TIMEOUT'>(resolve => {
      timer = setTimeout(() => resolve('TIMEOUT'), budget);
      (timer as { unref?: () => void }).unref?.();
    });
    const outcome = await Promise.race([work, timedOut]);
    if (timer) clearTimeout(timer);
    if (outcome === 'TIMEOUT') {
      cancel.cancelled = true; // a late completion must not store, compare or publish anything
      if (input.record !== false) this.soak.timeouts++;
      this.recordFailure({ caseId: input.requirement.caseId, context: input.context, kind: 'TIMEOUT', message: `shadow evaluation exceeded ${budget} ms` });
      log(`[FeasibilityShadow] evaluation timed out after ${budget} ms for case ${input.requirement.caseId} (${input.context}); legacy path unaffected.`);
      return undefined;
    }
    return outcome;
  }

  /**
   * SHADOW-ONLY: is the destination the ambulance currently holds still feasible under the current
   * evidence snapshot? Recorded as an observation only. It changes no state, is not a decision
   * trace, emits no trace event and can never trigger a reroute.
   */
  async observeDestination(input: {
    caseId: string;
    hospitalId: string;
    requirement?: CareRequirement;
    trigger: { eventId: string; eventType: string; sourceId: string; sourceType?: string };
    origin?: GeoPoint;
    originAsOf?: string;
    ambulanceId?: string;
    hospitals?: Iterable<HospitalState>;
    evaluatedAt?: string;
  }): Promise<DestinationObservation | undefined> {
    try {
      const requirement = input.requirement || await this.resolveRequirement(input.caseId);
      if (!requirement) return undefined;
      const result = await this.evaluate({
        context: 'current-destination',
        requirement,
        requirementProvenance: 'RULE_DERIVED',
        trigger: input.trigger,
        origin: input.origin,
        originAsOf: input.originAsOf,
        ambulanceId: input.ambulanceId,
        hospitals: input.hospitals,
        evaluatedAt: input.evaluatedAt,
        record: false, // the held destination is NOT excluded: the question is whether it is still feasible
      });
      const c = result?.decision.candidates.find(x => x.hospitalId === input.hospitalId);
      if (!result || !c) return undefined;
      const obs: DestinationObservation = {
        at: result.decision.evaluatedAt,
        caseId: input.caseId,
        hospitalId: input.hospitalId,
        verdict: c.verdict,
        feasible: c.verdict === 'ELIGIBLE',
        blockingReasons: [...c.blockingReasons],
        snapshotHash: result.decision.snapshotHash,
        policyHash: result.decision.policyHash,
      };
      const list = this.destinationObservations.get(input.caseId) || [];
      list.push(obs);
      if (list.length > MAX_TRACES_PER_CASE) list.splice(0, list.length - MAX_TRACES_PER_CASE);
      this.destinationObservations.set(input.caseId, list);
      return obs;
    } catch (err) {
      this.recordFailure({ caseId: input.caseId, context: 'current-destination', kind: 'ERROR', message: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  private async run(
    input: Parameters<FeasibilityShadow['evaluate']>[0],
    cancel: { cancelled: boolean }
  ): Promise<{ decision: FeasibilityDecision; trace: DecisionTraceRecord } | undefined> {
    const log = this.deps.log || ((m: string) => console.log(m));
    const generation = this.generation;
    const newId = this.deps.newId || uuidv4;
    try {
      const hospitals = input.hospitals || (await this.deps.hospitals());
      const hospitalList = [...hospitals];
      const evaluatedAtIso = input.evaluatedAt || (this.deps.clock ? this.deps.clock() : new Date().toISOString());
      const ledger = typeof this.deps.ledger === 'function' ? await this.deps.ledger(input.requirement.caseId, hospitalList.map(h => h.hospitalId), Date.parse(evaluatedAtIso)) : this.deps.ledger;
      const base = assembleSnapshot({
        snapshotId: newId(),
        evaluatedAt: evaluatedAtIso,
        policyVersion: this.policy.version,
        policyHash: hashPolicy(this.policy),
        trigger: input.trigger,
        requirement: input.requirement,
        requirementProvenance: input.requirementProvenance,
        excludedHospitalIds: input.excludedHospitalIds,
        ambulanceId: input.ambulanceId,
        origin: input.origin,
        originAsOf: input.originAsOf,
      }, hospitalList, ledger);

      const survivors = screenCandidates(base, this.policy).map(s => s.hospitalId);
      const snapshot = await enrichTransport(base, survivors, this.deps.mapping);
      const { decision, evaluated } = evaluateFeasibility(snapshot, this.policy, { decisionId: newId(), traceId: newId() });
      const trace = buildDecisionTrace(snapshot, decision, evaluated);
      if (generation !== this.generation || cancel.cancelled) return undefined; // reset or timeout happened mid-evaluation
      if (input.record === false) return { decision, trace };
      this.soak.completed++;
      this.store(trace);
      this.compare(input, decision, log);
      // ---- everything above is the decision; everything below is output-only telemetry ----
      await this.emitTrace(generation, cancel, input.context, snapshot, decision, trace, log);
      return { decision, trace };
    } catch (err) {
      if (!cancel.cancelled) {
        if (input.record !== false) {
          this.soak.errors++;
          if (err instanceof Error && /Policy (hash|version) mismatch/.test(err.message)) this.soak.policyMismatches++;
        }
        this.recordFailure({ caseId: input.requirement.caseId, context: input.context, kind: 'ERROR', message: err instanceof Error ? err.message : String(err) });
      }
      log(`[FeasibilityShadow] evaluation failed for case ${input.requirement.caseId} (${input.context}): ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Publishes the trace event. Runs strictly after the decision is final; failures are counted and
   * logged and never propagate. Nothing here mutates the snapshot, decision or trace.
   */
  private async emitTrace(
    generation: number,
    cancel: { cancelled: boolean },
    context: string,
    snapshot: FeasibilitySnapshot,
    decision: FeasibilityDecision,
    trace: DecisionTraceRecord,
    log: (msg: string) => void
  ): Promise<void> {
    if (!this.deps.publishTrace || !traceEventsEnabled() || generation !== this.generation || cancel.cancelled) return;
    try {
      const payload = buildTraceEventPayload({ context, snapshot, decision, trace, policy: this.policy });
      const event = buildTraceEvent(payload, {
        eventId: (this.deps.newId || uuidv4)(),
        timestamp: this.deps.clock ? this.deps.clock() : new Date().toISOString(),
        causationId: snapshot.trigger.eventId,
      });
      await this.deps.publishTrace(event);
    } catch (err) {
      this.traceEventFailures++;
      log(`[FeasibilityShadow] trace event not published for case ${decision.caseId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private store(trace: DecisionTraceRecord): void {
    const list = this.traces.get(trace.caseId) || [];
    list.push(trace);
    if (list.length > MAX_TRACES_PER_CASE) list.splice(0, list.length - MAX_TRACES_PER_CASE);
    this.traces.set(trace.caseId, list);
    while (this.traces.size > MAX_CASES) this.traces.delete(this.traces.keys().next().value as string);
  }

  private compare(
    input: Parameters<FeasibilityShadow['evaluate']>[0],
    decision: FeasibilityDecision,
    log: (msg: string) => void
  ): void {
    const found: ShadowDisagreement[] = [];
    const at = decision.evaluatedAt;
    const base = { at, caseId: decision.caseId, context: input.context, traceId: decision.traceId };
    for (const legacy of input.legacyCandidates || []) {
      const c = decision.candidates.find(x => x.hospitalId === legacy.hospitalId);
      if (!c) continue;
      const projected = toLegacyEligibility(c.verdict);
      if (projected !== legacy.operationalEligibility) {
        found.push({ ...base, kind: 'VERDICT', hospitalId: c.hospitalId, legacy: legacy.operationalEligibility, engine: c.verdict, engineReasons: c.blockingReasons });
      }
    }
    if (input.legacySelection) {
      const legacyPick = input.legacySelection.hospitalId || 'NONE';
      const enginePick = decision.selectedHospitalId || 'NONE';
      if (legacyPick !== enginePick) {
        found.push({ ...base, kind: 'SELECTION', legacy: legacyPick, engine: enginePick, engineReasons: [decision.outcome] });
      }
    }
    for (const d of found) {
      log(`[FeasibilityShadow] DISAGREE case=${d.caseId} ctx=${d.context} ${d.kind}${d.hospitalId ? ` hospital=${d.hospitalId}` : ''} legacy=${d.legacy} engine=${d.engine} reasons=${d.engineReasons.join(',')} trace=${d.traceId}`);
    }
    this.soak.totalDisagreements += found.length;
    this.disagreements.push(...found);
    if (this.disagreements.length > MAX_DISAGREEMENTS) this.disagreements.splice(0, this.disagreements.length - MAX_DISAGREEMENTS);
  }
}
