import type { EvidenceRecord } from './evidence';
import type { Capabilities, CapabilityStatus, DataStatus, LocationData } from './hospital';
import type { CareRequirement, HospitalAvailabilityResponse } from './protocol';
import type { GeoPoint } from './patient';
import type { HospitalFinancialProfile, PatientFinancialContext } from './financial';
import type { HospitalInsuranceProfile, PatientInsuranceProfile } from './insurance';
import type { DecisionFactorCategory } from './decisionTrace';

/**
 * Care Feasibility Engine contracts (CLAUDE-01).
 * See docs/claude-01-care-feasibility-design.md.
 *
 * INVARIANT: there is no aggregate score anywhere in these types. Feasibility is a verdict
 * derived from hard constraints; ordering is a lexicographic key, never a weighted sum.
 */

export type FeasibilityVerdict = 'ELIGIBLE' | 'PENDING_ACCEPTANCE' | 'INDETERMINATE' | 'INELIGIBLE';

export type ConstraintOutcome = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE';

/** FRESH: within validUntil / policy maxAge. STALE: past it. UNTIMED: no usable observation time. */
export type FreshnessState = 'FRESH' | 'STALE' | 'UNTIMED';

export type EvidenceClass =
  | 'FACILITY_LOCATION'
  | 'LISTED_CAPABILITY'
  | 'OPERATIONAL_CAPACITY'
  | 'ACCEPTANCE_RESPONSE'
  | 'AMBULANCE_POSITION'
  | 'ROUTE_ETA'
  | 'FINANCIAL'
  | 'INSURANCE';

export type ReasonCode =
  // pass
  | 'CAPABILITY_LISTED'
  | 'CAPABILITY_CONFIRMED_BY_RESPONSE'
  | 'OPERATIONAL_STATUS_CURRENT'
  | 'NOT_REJECTED'
  | 'NOT_HOSPITAL_UNAVAILABLE'
  | 'LIMITED_COVERS_REQUIRED'
  | 'ACCEPTED'
  | 'ACCEPTED_LIMITED'
  | 'LOCATED'
  // fail
  | 'CAPABILITY_NOT_PROVIDED'
  | 'OPERATIONAL_UNAVAILABLE'
  | 'REJECTED'
  | 'HOSPITAL_UNAVAILABLE'
  | 'LIMITED_MISSING_CAPABILITY'
  // unknown
  | 'NOT_LISTED'
  | 'UNRECOGNIZED_CAPABILITY'
  | 'NO_LIVE_EVIDENCE'
  | 'EVIDENCE_STALE'
  | 'EVIDENCE_UNTIMED'
  | 'EVIDENCE_NOT_OPERATIONAL_GRADE'
  | 'NOT_DISCLOSED'
  | 'NO_REQUEST'
  | 'NO_RESPONSE_YET'
  | 'REQUEST_EXPIRED_NO_RESPONSE'
  | 'ACCEPTANCE_EXPIRED'
  | 'RESPONSE_NOT_ACCEPTING'
  | 'RESPONSE_NO_VALID_REQUEST'
  | 'RESPONSE_REQUEST_SUPERSEDED'
  | 'RESPONSE_REQUEST_CANCELLED'
  | 'RESPONSE_OUTSIDE_REQUEST_WINDOW'
  | 'RESPONSE_EVIDENCE_NOT_TRUSTED'
  | 'REQUEST_CANCELLED_NO_RESPONSE'
  | 'UNAVAILABLE_EXPIRED'
  | 'LIMITED_EXPIRED'
  | 'NO_LOCATION'
  | 'NO_ORIGIN'
  | 'ROUTE_FAILED'
  | 'NO_FINANCIAL_EVIDENCE'
  | 'NO_INSURANCE_EVIDENCE'
  | 'NO_PATIENT_INSURANCE'
  // not applicable
  | 'NO_CARE_WINDOW_DEFINED'
  | 'NO_LIMITED_RESPONSE'
  | 'NO_LIVE_STATUS_FOR_REQUIRED';

/** First-class unknown value. Never replaced by a default. */
export interface UnknownFact {
  status: 'UNKNOWN';
  reasonCode: ReasonCode;
  detail: string;
}

/** Pointer into the immutable snapshot for a piece of evidence used by a rule. */
export interface EvidenceRef {
  snapshotId: string;
  path: string;
  evidenceClass: EvidenceClass;
  source: string;
  dataStatus: DataStatus | string;
  observedAt?: string;
  validUntil?: string;
  ageSeconds?: number;
  freshness: FreshnessState;
  confidence?: number;
}

// ------------------------------------------------------------------ inputs

export interface CaseInput {
  caseId: string;
  requirement: CareRequirement;
  /** How the requirement was produced. The assessment engine's regex is RULE_DERIVED. */
  requirementProvenance: 'RULE_DERIVED' | 'CLINICIAN_CONFIRMED';
  /** Explicit procedure code, only if supplied. Never inferred from capabilities. */
  procedureCode?: string;
  financialContext?: PatientFinancialContext;
  insuranceProfile?: PatientInsuranceProfile;
  /** Hospitals evaluated but not selectable (e.g. the destination being rerouted away from). */
  excludedHospitalIds?: string[];
}

export interface OperationalEvidence {
  statuses: {
    emergency: CapabilityStatus;
    icu: CapabilityStatus;
    trauma: CapabilityStatus;
    nicu: CapabilityStatus;
    picu: CapabilityStatus;
    ventilator: CapabilityStatus;
  };
  source: string;
  dataStatus: DataStatus;
  observedAt?: string;
  validUntil?: string;
  confidence?: number;
}

export interface CaseAcceptanceView {
  requestState: 'NOT_REQUESTED' | 'OUTSTANDING' | 'REQUEST_EXPIRED' | 'REQUEST_CANCELLED';
  /** The current (latest, non-superseded) request for this case and hospital. */
  request?: { requestId: string; requestedAt: string; expiresAt: string; cancelledAt?: string };
  /** Latest applied response for THIS case and hospital. */
  response?: HospitalAvailabilityResponse;
  /** Latest hospital-wide UNAVAILABLE (from any case) not superseded by a newer accepting response. */
  hospitalWideUnavailable?: HospitalAvailabilityResponse;
  /** Response requestId did not match the ledger's request (warning only in this phase). */
  requestIdMismatch?: boolean;
}

export interface HospitalInput {
  hospitalId: string;
  displayName: string;
  location?: EvidenceRecord<LocationData>;
  capabilities: EvidenceRecord<Capabilities>;
  operational: OperationalEvidence;
  acceptance: CaseAcceptanceView;
  financialProfile?: HospitalFinancialProfile;
  insuranceProfile?: HospitalInsuranceProfile;
}

export interface EtaEvidence {
  durationSeconds: number;
  distanceMeters: number;
  provider: string;
  synthetic: boolean;
  trafficAware: boolean;
  calculatedAt: string;
}

export interface TransportInput {
  ambulanceId?: string;
  origin?: EvidenceRecord<GeoPoint>;
  etaByHospital: Record<string, EtaEvidence | UnknownFact>;
}

export interface FeasibilitySnapshot {
  snapshotId: string;
  /** sha256 of the canonical snapshot content (see hashSnapshot). */
  contentHash?: string;
  /** The ONLY clock the engine sees. */
  evaluatedAt: string;
  policyVersion: string;
  /** sha256 of the canonicalized EFFECTIVE policy (rules + evidence environment). Part of the snapshot hash. */
  policyHash: string;
  trigger: { eventId: string; eventType: string; sourceId: string; sourceType?: string };
  case: CaseInput;
  candidates: HospitalInput[];
  transport: TransportInput;
}

// ------------------------------------------------------------------ outputs

export interface ConstraintResult {
  ruleId: string;
  ruleName: string;
  category: DecisionFactorCategory;
  outcome: ConstraintOutcome;
  /** UNKNOWN on this rule can be resolved by the acceptance protocol (does not cause INDETERMINATE). */
  resolvableByAcceptance: boolean;
  reasonCode: ReasonCode;
  rationale: string;
  evidenceRefs: EvidenceRef[];
}

export type KnowledgeLevel = 'KNOWN' | 'ESTIMATED' | 'UNKNOWN' | 'NOT_DISCLOSED';

export interface FactorResult {
  factorId: string;
  /** True only for factors that participate in the ordering key. */
  affectsOrdering: boolean;
  level: KnowledgeLevel;
  summary: string;
  reasonCode?: ReasonCode;
  value?: Record<string, string | number | boolean | null | string[]>;
  evidenceRefs: EvidenceRef[];
}

export interface OrderKey {
  verdictRank: number;
  acceptanceKindRank: number;
  etaKnown: boolean;
  etaSeconds: number | null;
  distanceMeters: number | null;
  hospitalId: string;
}

export interface CandidateFeasibility {
  hospitalId: string;
  hospitalName: string;
  verdict: FeasibilityVerdict;
  hardConstraints: ConstraintResult[];
  contextualFactors: FactorResult[];
  blockingReasons: ReasonCode[];
  pendingOn?: 'ACCEPTANCE_REQUEST' | 'ACCEPTANCE_RESPONSE';
  orderKey: OrderKey;
  orderPosition: number;
  excludedFromSelection: boolean;
}

export type FeasibilityOutcome = 'SELECTED' | 'AWAITING_ACCEPTANCE' | 'NO_FEASIBLE_CANDIDATE';

export interface FeasibilityDecision {
  decisionId: string;
  traceId: string;
  snapshotId: string;
  snapshotHash: string;
  evaluatedAt: string;
  policyVersion: string;
  policyHash: string;
  engineVersion: string;
  caseId: string;
  outcome: FeasibilityOutcome;
  selectedHospitalId?: string;
  /** All evaluated candidates, including INELIGIBLE, in deterministic order. */
  candidates: CandidateFeasibility[];
  coverage: {
    evaluated: number;
    withUsableOperationalEvidence: number;
    withSyntheticEvidence: number;
    withFinancialEvidence: number;
    withInsuranceEvidence: number;
  };
}
