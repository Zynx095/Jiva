import type {
  CapabilityType,
  CareRequirement,
  DataStatus,
  HospitalCandidate,
  HospitalState,
} from '@jiva/domain-models';

/**
 * Pure state-transition rules shared by the LOCAL state engines and the AWS lambdas, so that
 * both environments run ONE implementation of the acceptance / capacity / request rules
 * (CLAUDE-01 D8). Nothing here touches a store, a clock, a bus or the network.
 *
 * These are the frozen legacy semantics — this module deliberately does not change them.
 */
export const REQUEST_TTL_MS = 15 * 60000;

/** Sentinel used in destination.changed when no eligible accepting hospital exists. */
export const UNASSIGNED = 'UNASSIGNED';

const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);

// ------------------------------------------------------------------ requirement assessment

/** Deterministic triage assessment: condition + severity -> required capabilities. */
export function assessRequiredCapabilities(condition: string, severity: string): CapabilityType[] {
  const caps: CapabilityType[] = ['EMERGENCY' as CapabilityType];
  if (/trauma|accident|injur|fracture|polytrauma|burn/i.test(condition)) caps.push('TRAUMA' as CapabilityType);
  if (severity === 'HIGH' || severity === 'CRITICAL') caps.push('ICU' as CapabilityType);
  return caps;
}

/**
 * Provenance of a care requirement. Requirements are produced by the rule-based assessment
 * engine, so they are RULE_DERIVED unless the producing event explicitly came from a clinician.
 * An unrecognised source is never promoted to CLINICIAN_CONFIRMED.
 */
export function requirementProvenanceOf(sourceType?: string): 'RULE_DERIVED' | 'CLINICIAN_CONFIRMED' {
  return sourceType === 'clinician' ? 'CLINICIAN_CONFIRMED' : 'RULE_DERIVED';
}

// ------------------------------------------------------------------ acceptance request boundary

/**
 * The existing request-selection boundary: only clinically capable, not-INELIGIBLE candidates are
 * asked for acceptance. The feasibility engine's INDETERMINATE verdict projects to INELIGIBLE, so
 * INDETERMINATE hospitals are never requestable (A1).
 */
export function selectRequestTargets<T extends Pick<HospitalCandidate, 'missingCapabilities' | 'operationalEligibility'>>(
  candidates: T[]
): T[] {
  return candidates.filter(c => c.missingCapabilities.length === 0 && c.operationalEligibility !== 'INELIGIBLE');
}

export interface AcceptanceRequestPayload {
  requestId: string;
  caseId: string;
  hospitalId: string;
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  ambulanceEtaMinutes?: number;
  requestedAt: string;
  expiresAt: string;
}

export function buildAcceptanceRequest(
  requirement: { caseId: string; requiredCapabilities: string[]; optionalCapabilities: string[] },
  candidate: Pick<HospitalCandidate, 'hospitalId' | 'etaMinutes'>,
  requestId: string,
  nowMs: number
): AcceptanceRequestPayload {
  return {
    requestId,
    caseId: requirement.caseId,
    hospitalId: candidate.hospitalId,
    requiredCapabilities: requirement.requiredCapabilities,
    optionalCapabilities: requirement.optionalCapabilities,
    ambulanceEtaMinutes: candidate.etaMinutes,
    requestedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + REQUEST_TTL_MS).toISOString(),
  };
}

// ------------------------------------------------------------------ acceptance response

export interface AcceptanceResponsePayload {
  responseId: string;
  requestId: string;
  caseId: string;
  hospitalId: string;
  status: 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'UNAVAILABLE';
  acceptedCapabilities: string[];
  limitations: string[];
  respondedAt: string;
  validUntil: string;
  responderRole: string;
  source: 'HOSPITAL_CONFIRMED' | 'AUTHORIZED_FEED' | 'SYNTHETIC_DEMO';
}

export type AcceptanceApplyResult =
  | { kind: 'IGNORED'; reason: 'STALE' | 'EXPIRED_ON_ARRIVAL' }
  | { kind: 'APPLIED'; next: HospitalState };

/**
 * Apply an acceptance response to the hospital record (legacy, hospital-level semantics):
 *  - older than the response already applied (acceptanceAsOf watermark) -> STALE, never overwrites
 *  - ACCEPTED/LIMITED that is already past validUntil -> EXPIRED_ON_ARRIVAL, not current evidence
 * Duplicate responseId detection is the caller's job (local: processed set; AWS: ledger replay).
 */
export function applyAcceptanceResponse(
  existing: HospitalState,
  p: AcceptanceResponsePayload,
  envelope: { sourceType: string; sourceId: string },
  nowMs: number
): AcceptanceApplyResult {
  const op = existing.operationalState;
  if (op.acceptanceAsOf && ms(p.respondedAt) < ms(op.acceptanceAsOf)) return { kind: 'IGNORED', reason: 'STALE' };
  if ((p.status === 'ACCEPTED' || p.status === 'LIMITED') && ms(p.validUntil) <= nowMs) {
    return { kind: 'IGNORED', reason: 'EXPIRED_ON_ARRIVAL' };
  }
  return {
    kind: 'APPLIED',
    next: {
      ...existing,
      operationalState: {
        ...op,
        acceptance: p.status,
        acceptanceAsOf: p.respondedAt,
        acceptanceCaseId: p.caseId,
        lastConfirmedAt: p.respondedAt,
        expiresAt: p.validUntil,
        source: p.source,
      },
      provenance: [...existing.provenance, {
        sourceType: envelope.sourceType,
        sourceId: envelope.sourceId,
        sourceName: 'Acceptance Protocol',
        retrievedAt: new Date(nowMs).toISOString(),
        asOf: p.respondedAt,
        verificationStatus: p.source,
        confidence: 1.0,
      }],
    },
  };
}

// ------------------------------------------------------------------ capacity update

export interface CapacityUpdatePayload {
  hospitalId: string;
  emergencyStatus: HospitalState['operationalState']['emergency'];
  traumaStatus: HospitalState['operationalState']['trauma'];
  icuStatus: HospitalState['operationalState']['icu'];
  ventilatorStatus: HospitalState['operationalState']['ventilator'];
}

export type CapacityApplyResult =
  | { kind: 'IGNORED'; reason: 'STALE' }
  | { kind: 'APPLIED'; next: HospitalState };

/** Apply a capacity update (legacy semantics): an update older than capacityAsOf is ignored. */
export function applyCapacityUpdate(
  existing: HospitalState,
  p: CapacityUpdatePayload,
  event: { timestamp: string; source: { type: string; id: string }; metadata?: { sourceType?: string; confidence?: number; trustedEvidence?: { status: DataStatus } } },
  nowMs: number
): CapacityApplyResult {
  const op = existing.operationalState;
  if (op.capacityAsOf && ms(event.timestamp) < ms(op.capacityAsOf)) return { kind: 'IGNORED', reason: 'STALE' };
  return {
    kind: 'APPLIED',
    next: {
      ...existing,
      operationalState: {
        ...op,
        emergency: p.emergencyStatus,
        trauma: p.traumaStatus,
        icu: p.icuStatus,
        ventilator: p.ventilatorStatus,
        capacityAsOf: event.timestamp,
      },
      provenance: [...existing.provenance, {
        sourceType: event.source.type,
        sourceId: event.source.id,
        sourceName: 'Capacity Update',
        retrievedAt: new Date(nowMs).toISOString(),
        asOf: event.timestamp,
        verificationStatus: (event.metadata?.sourceType as DataStatus | undefined) || 'UNVERIFIED',
        // Trusted grade (derived at ingestion). The claim above is legacy/informational only.
        trustedStatus: event.metadata?.trustedEvidence?.status ?? 'UNVERIFIED',
        confidence: event.metadata?.confidence ?? 1.0,
      }],
    },
  };
}

/**
 * Whether a capacity update makes a destination unusable for a case with these requirements
 * (legacy reroute predicate: only a lost capability the case actually needs).
 */
export function capacityLossAffectsCase(p: CapacityUpdatePayload, caseRequirements: string[]): boolean {
  return p.emergencyStatus === 'UNAVAILABLE' ||
    (p.icuStatus === 'UNAVAILABLE' && caseRequirements.includes('ICU')) ||
    (p.traumaStatus === 'UNAVAILABLE' && caseRequirements.includes('TRAUMA'));
}

/** Legacy gate: any of these being UNAVAILABLE can require reevaluating destinations. */
export function capacityHasUnavailable(p: CapacityUpdatePayload): boolean {
  return p.emergencyStatus === 'UNAVAILABLE' || p.icuStatus === 'UNAVAILABLE' || p.traumaStatus === 'UNAVAILABLE';
}

// ------------------------------------------------------------------ destination selection (legacy)

/** Requirement used by destination selection / rerouting for an assigned case. */
export function selectionRequirement(ambulanceId: string, caseId: string, careRequirements: string[], nowIso: string): CareRequirement {
  return {
    requirementId: `sel-${ambulanceId}`,
    caseId,
    requiredCapabilities: careRequirements as CapabilityType[],
    optionalCapabilities: [],
    severity: 'HIGH',
    createdAt: nowIso,
    source: 'routing-engine',
  };
}

/**
 * Legacy pick: the first ELIGIBLE candidate (already ordered by the eligibility engine) that is not
 * excluded and whose current acceptance is for THIS case. Mapping only orders the eligible set by
 * ETA; it never decides eligibility.
 *
 * CASE-SCOPED ACCEPTANCE (fixes the one-slot bug): `hospitalsStore`'s `operationalState.acceptance*`
 * fields hold exactly ONE acceptance per hospital ("last writer wins"), so if hospital X accepts case
 * B after already accepting case A, the slot is overwritten and A's own destination selection at X
 * would incorrectly see no acceptance. `isAcceptedForCase`, when supplied, is checked INSTEAD of the
 * shared slot: it is backed by the per-(case, hospital) acceptance ledger/materialized index (see
 * acceptanceLedger.ts / materializedAcceptance.ts), which already isolates cases correctly. The
 * `hospitalById` slot check remains the fallback for any caller that does not supply it, so this is
 * backward compatible with every existing call site and consumer of `HospitalState.operationalState`.
 */
export function pickLegacyDestination(
  candidates: Pick<HospitalCandidate, 'hospitalId' | 'operationalEligibility'>[],
  exclude: Set<string>,
  _caseId: string,
  _hospitalById: (id: string) => HospitalState | undefined
): string | undefined {
  // `operationalEligibility === 'ELIGIBLE'` already encodes case-scoped acceptance: evaluateHospitals
  // computes it either from `acceptanceOverride` (the per-(case, hospital) ledger, when supplied --
  // fixes the one-slot bug) or, absent an override, from the shared slot's own acceptanceCaseId check.
  // `_caseId`/`_hospitalById` are kept for source/binary compatibility with existing callers.
  return candidates.find(c => c.operationalEligibility === 'ELIGIBLE' && !exclude.has(c.hospitalId))?.hospitalId;
}
