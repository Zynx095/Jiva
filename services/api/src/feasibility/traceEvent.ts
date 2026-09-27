import type {
  DataStatus,
  DecisionTraceRecord,
  EvidenceRef,
  FeasibilityDecision,
  FeasibilitySnapshot,
} from '@jiva/domain-models';
import type { FeasibilityTraceRecorded } from '@jiva/event-schema';
import { FEASIBILITY_TRACE_EVENT } from '@jiva/event-schema';
import { hashPolicy, isCapabilityType } from '@jiva/feasibility';
import type { FreshnessPolicy } from '@jiva/feasibility';
import { createHash } from 'crypto';

/**
 * Feasibility trace event — OBSERVABILITY / AUDIT ONLY.
 *
 * This module is a pure projection of an already-computed decision. It is called after the
 * decision exists and its output is only ever handed to the event bus; nothing in the feasibility
 * pipeline reads it back (the ledger replay and the snapshot assembler ignore this event type).
 *
 * Privacy: identifiers, enumerated codes, timestamps and hashes only. Deliberately excluded:
 * patient condition/severity/location, financial or insurance context, hospital names, and every
 * free-text field (rationales, limitations) — hospital-supplied text must never travel through
 * telemetry that other components (or an AI sidecar) might read.
 */
export type TracePayload = FeasibilityTraceRecorded['payload'];

/** EventBridge entries are capped at 256 KB; degrade before we would exceed a safe margin. */
export const MAX_TRACE_PAYLOAD_BYTES = 200_000;

/**
 * Everything that reaches the event is either produced by this code (enums, codes, hashes) or
 * passed through an ALLOW-LIST transform that cannot carry text:
 *  - opaque ids  -> kept only if they have the shape of an id, otherwise replaced by a one-way hash
 *  - dataStatus  -> must be one of the canonical statuses, otherwise UNVERIFIED
 *  - timestamps  -> must parse as an instant, otherwise dropped
 *  - capabilities-> must be canonical capability codes, otherwise counted, never echoed
 * There is no blacklist of "bad" strings anywhere.
 */
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const opaqueId = (v: string): string => (OPAQUE_ID.test(v) ? v : `h:${createHash('sha256').update(v).digest('hex').slice(0, 24)}`);
const STATUSES: ReadonlySet<string> = new Set(['CURRENT', 'HISTORICAL', 'PUBLIC_LISTED', 'HOSPITAL_CONFIRMED', 'AUTHORIZED_FEED', 'SYNTHETIC_DEMO', 'UNKNOWN', 'NOT_DISCLOSED', 'UNVERIFIED']);
const SOURCE_TYPES: ReadonlySet<string> = new Set(['hospital', 'ambulance', 'patient', 'system', 'clinician', 'laboratory']);
const instant = (v?: string): string | undefined => {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

function compactRef(r: EvidenceRef) {
  return {
    path: r.path,
    evidenceClass: r.evidenceClass,
    dataStatus: (STATUSES.has(String(r.dataStatus)) ? String(r.dataStatus) : 'UNVERIFIED') as DataStatus,
    freshness: r.freshness,
    observedAt: instant(r.observedAt),
    validUntil: instant(r.validUntil),
    ageSeconds: r.ageSeconds,
    confidence: typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : undefined,
  };
}

export function buildTraceEventPayload(input: {
  context: string;
  snapshot: FeasibilitySnapshot;
  decision: FeasibilityDecision;
  trace: DecisionTraceRecord;
  policy: FreshnessPolicy;
}): TracePayload {
  const { context, snapshot, decision, trace, policy } = input;
  const build = (detail: 'FULL' | 'SUMMARY'): TracePayload => ({
    traceId: decision.traceId,
    decisionId: decision.decisionId,
    caseId: opaqueId(decision.caseId),
    mode: 'SHADOW',
    authority: 'NONE',
    context,
    evaluatedAt: decision.evaluatedAt,
    engineVersion: decision.engineVersion,
    snapshot: { snapshotId: decision.snapshotId, snapshotHash: decision.snapshotHash },
    auditHash: trace.auditHash as string,
    policy: {
      version: policy.version,
      hash: hashPolicy(policy),
      evidenceEnvironment: policy.evidenceEnvironment,
      label: policy.label,
      rules: Object.fromEntries(
        Object.entries(policy.rules).map(([k, r]) => [k, { maxAgeSeconds: r.maxAgeSeconds, onStale: r.onStale }])
      ),
    },
    requirement: {
      requirementId: opaqueId(snapshot.case.requirement.requirementId),
      requiredCapabilities: (snapshot.case.requirement.requiredCapabilities as string[]).filter(c => isCapabilityType(c)),
      unrecognizedCapabilityCount: (snapshot.case.requirement.requiredCapabilities as string[]).filter(c => !isCapabilityType(c)).length,
      provenance: snapshot.case.requirementProvenance,
    },
    trigger: {
      eventId: snapshot.trigger.eventId,
      eventType: snapshot.trigger.eventType,
      sourceType: (SOURCE_TYPES.has(snapshot.trigger.sourceType || '') ? snapshot.trigger.sourceType : 'unknown') as TracePayload['trigger']['sourceType'],
    },
    outcome: decision.outcome,
    selectedHospitalId: decision.selectedHospitalId ? opaqueId(decision.selectedHospitalId) : undefined,
    coverage: { ...decision.coverage },
    detailLevel: detail,
    candidates: decision.candidates.map(c => ({
      hospitalId: opaqueId(c.hospitalId),
      verdict: c.verdict,
      orderPosition: c.orderPosition,
      orderKey: { ...c.orderKey, hospitalId: opaqueId(c.orderKey.hospitalId) },
      blockingReasons: [...c.blockingReasons],
      pendingOn: c.pendingOn,
      excludedFromSelection: c.excludedFromSelection,
      constraints: c.hardConstraints.map(h => ({
        ruleId: h.ruleId,
        outcome: h.outcome,
        reasonCode: h.reasonCode,
        resolvableByAcceptance: h.resolvableByAcceptance,
        ...(detail === 'FULL' ? { evidenceRefs: h.evidenceRefs.map(compactRef) } : {}),
      })),
      factors: c.contextualFactors.map(f => ({
        factorId: f.factorId,
        level: f.level,
        affectsOrdering: f.affectsOrdering,
        reasonCode: f.reasonCode,
      })),
    })),
  });

  const size = (p: TracePayload) => Buffer.byteLength(JSON.stringify(p), 'utf8');
  const full = build('FULL');
  if (size(full) <= MAX_TRACE_PAYLOAD_BYTES) return full;
  const summary = build('SUMMARY');
  if (size(summary) <= MAX_TRACE_PAYLOAD_BYTES) return summary;
  // Still too large (very many candidates): keep the best-ranked candidates that fit. The decision
  // itself is unaffected; the full record remains in the stored trace and coverage.evaluated is exact.
  const total = summary.candidates.length;
  let keep = Math.max(1, Math.floor(total * (MAX_TRACE_PAYLOAD_BYTES / size(summary)) * 0.95));
  let trimmed: TracePayload = { ...summary, candidates: summary.candidates.slice(0, keep), candidatesOmitted: total - keep };
  while (keep > 1 && size(trimmed) > MAX_TRACE_PAYLOAD_BYTES) {
    keep = Math.max(1, Math.floor(keep * 0.9));
    trimmed = { ...summary, candidates: summary.candidates.slice(0, keep), candidatesOmitted: total - keep };
  }
  return trimmed;
}

/** Envelope. No patientId (would route it to patients) and no correlationId (not a uuid). */
export function buildTraceEvent(
  payload: TracePayload,
  meta: { eventId: string; timestamp: string; causationId?: string }
): FeasibilityTraceRecorded {
  const isUuid = (v?: string) => !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  return {
    eventId: meta.eventId,
    eventType: FEASIBILITY_TRACE_EVENT,
    timestamp: meta.timestamp,
    version: '1.0',
    source: { type: 'system', id: 'feasibility-shadow' },
    ...(isUuid(meta.causationId) ? { causationId: meta.causationId } : {}),
    payload,
  };
}
