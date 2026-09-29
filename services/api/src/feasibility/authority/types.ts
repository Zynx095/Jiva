import type {
  AmbulanceState,
  CareRequirement,
  FeasibilityDecision,
  FeasibilityVerdict,
  GeoPoint,
  HospitalCandidate,
  HospitalState,
  PatientState,
} from '@jiva/domain-models';
import type { MappingProvider } from '@jiva/mapping';
import type { AcceptanceView } from '../acceptanceLedger';

/**
 * Explicit decision authority modes.
 *
 *  LEGACY:        Legacy decision path is authoritative; feasibility engine is OFF.
 *  SHADOW:        Legacy decision path is authoritative; feasibility runs as contained observation. (Default safe operating mode)
 *  CANARY:        Legacy decision path remains authoritative (controls actual destination);
 *                 feasibility evaluates alongside, differences are classified, and canary metrics are recorded.
 *  AUTHORITATIVE: Feasibility engine is authoritative; if it fails or trips circuit breaker,
 *                 system automatically falls back to legacy decision.
 *                 (PROTECTED: cannot be activated without passing formal promotion gates).
 */
export type AuthorityMode = 'LEGACY' | 'SHADOW' | 'CANARY' | 'AUTHORITATIVE';

/** Structured disagreement categories between legacy and feasibility decisions. */
export type DisagreementClassification =
  | 'AGREEMENT'
  | 'EXPECTED_POLICY_DIFFERENCE'
  | 'UNEXPECTED_DIFFERENCE'
  | 'MISSING_EVIDENCE'
  | 'LEGACY_ONLY'
  | 'FEASIBILITY_ONLY'
  | 'TIMEOUT'
  | 'ENGINE_ERROR';

/** Explicit reasons why an authority evaluation fell back to legacy or safe unassigned state. */
export type FallbackReason =
  | 'NONE'
  | 'CIRCUIT_BREAKER_OPEN'
  | 'FEASIBILITY_TIMEOUT'
  | 'FEASIBILITY_EXCEPTION'
  | 'FEASIBILITY_MALFORMED'
  | 'UNEXPECTED_DISAGREEMENT'
  | 'KILL_SWITCH_ACTIVE'
  | 'PROMOTION_GATE_REJECTED';

/** State of the authority circuit breaker. */
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Structured decision summary for a candidate or destination evaluation. */
export interface LegacyDecisionSummary {
  selectedHospitalId?: string;
  candidatesCount: number;
  eligibleHospitalIds: string[];
}

export interface FeasibilityDecisionSummary {
  selectedHospitalId?: string;
  verdict?: FeasibilityVerdict;
  outcome?: string;
  candidatesCount: number;
  eligibleHospitalIds: string[];
  traceId?: string;
  snapshotHash?: string;
  policyHash?: string;
}

export interface FinalDecisionSummary {
  selectedHospitalId?: string;
  source: 'LEGACY' | 'FEASIBILITY';
}

/**
 * Structured, machine-critical result contract for all decision authority operations.
 * Guaranteed to contain no patient free-text or PII.
 */
export interface DecisionAuthorityResult {
  caseId: string;
  context: 'destination-selection' | 'candidate-generation';
  configuredMode: AuthorityMode;
  effectiveMode: AuthorityMode;
  legacyDecision: LegacyDecisionSummary;
  feasibilityDecision?: FeasibilityDecisionSummary;
  finalDecision: FinalDecisionSummary;
  agreement: boolean;
  disagreementClass: DisagreementClassification;
  disagreementReasons: string[];
  fallback: boolean;
  fallbackReason: FallbackReason;
  killSwitchActive: boolean;
  circuitBreakerState: CircuitBreakerState;
  timestamp: string;
  executionTimeMs: number;
  auditHash: string;
}

/** Inputs required to select a destination through the authority gate. */
export interface DestinationSelectionInput {
  ambulance: AmbulanceState;
  patient: PatientState;
  requirement: CareRequirement;
  hospitals: HospitalState[];
  mapping: MappingProvider;
  acceptanceView: AcceptanceView;
  exclude?: Set<string>;
  reason?: string;
  nowMs?: number;
  timeoutMs?: number;
}

/** Result of checking promotion gate readiness. */
export interface PromotionGateResult {
  authorized: boolean;
  satisfiedGates: string[];
  blockingReasons: string[];
}

/** Snapshot of metrics tracked across authority evaluations. */
export interface AuthorityMetricsSummary {
  evaluationsTotal: number;
  byMode: Record<AuthorityMode, number>;
  agreedCount: number;
  disagreedCount: number;
  byDisagreementClass: Record<DisagreementClassification, number>;
  timeouts: number;
  errors: number;
  fallbacksTriggered: number;
  byFallbackReason: Record<FallbackReason, number>;
  canaryEvaluations: number;
  authoritativeEvaluations: number;
  circuitBreakerTrips: number;
  killSwitchTrips: number;
}

/** The central Decision Authority interface. */
export interface IDecisionAuthority {
  readonly mode: AuthorityMode;
  selectDestination(input: DestinationSelectionInput): Promise<DecisionAuthorityResult>;
  getMetrics(): AuthorityMetricsSummary;
  reset(): void;
}
