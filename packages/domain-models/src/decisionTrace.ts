import { EvidenceRecord } from './evidence';
import { AcceptanceStatus } from './hospital';
import type {
  ConstraintOutcome,
  EvidenceRef,
  FactorResult,
  FeasibilityOutcome,
  FeasibilityVerdict,
  ReasonCode,
} from './feasibility';

export type DecisionFactorCategory =
  | 'CLINICAL_CAPABILITY'
  | 'OPERATIONAL_AVAILABILITY'
  | 'TRANSIT_TIME'
  | 'FINANCIAL_AFFORDABILITY'
  | 'INSURANCE_COVERAGE';

/**
 * Granular evaluation of a single deterministic rule within the decision trace.
 */
export interface DecisionRuleEvaluation {
  ruleId: string;
  category: DecisionFactorCategory;
  ruleName: string;
  isHardConstraint: boolean;
  /** Derived: outcome === 'PASS'. Kept for backward compatibility. */
  passed: boolean;
  rationale: string;
  evidenceSnapshot?: EvidenceRecord<unknown>[];
  /** Tri-state (plus N/A) outcome. A boolean cannot represent UNKNOWN. */
  outcome?: ConstraintOutcome;
  reasonCode?: ReasonCode;
  /** References into the immutable feasibility snapshot. */
  evidenceRefs?: EvidenceRef[];
}

/**
 * Detailed trace of how an individual candidate hospital was evaluated.
 */
export interface CandidateEvaluationTrace {
  hospitalId: string;
  hospitalName: string;
  rankOrder?: number;
  /**
   * @deprecated The Care Feasibility Engine never produces an aggregate hospital score.
   * Retained only for backward compatibility with AG-01 fixtures.
   */
  overallScore?: number;

  /** Feasibility verdict (CLAUDE-01). `isEligible` === (verdict === 'ELIGIBLE'). */
  verdict?: FeasibilityVerdict;
  blockingReasons?: ReasonCode[];
  pendingOn?: 'ACCEPTANCE_REQUEST' | 'ACCEPTANCE_RESPONSE';
  /** Soft factors: displayed and traced, never change the verdict. */
  contextualFactors?: FactorResult[];

  /** Whether the hospital qualified for patient routing. */
  isEligible: boolean;

  /** Primary reason if disqualified or ranked lower. */
  disqualificationReason?: string;

  /** Clinical capability matching details. */
  clinical: {
    requiredCapabilitiesMatched: string[];
    missingCapabilities: string[];
    /** Capabilities with no evidence either way (never collapsed into missing). */
    unknownCapabilities?: string[];
    /** @deprecated Partial-credit percentages are not produced by the feasibility engine. */
    matchPercentage?: number;
    passed: boolean;
  };

  /** Operational intake and acceptance status. */
  operational: {
    acceptanceStatus: AcceptanceStatus;
    confirmedByClinician: boolean;
    acceptanceValidUntil?: string;
    passed: boolean;
  };

  /** Road-network transit metrics. */
  transit: {
    /** null when the route/ETA is unknown. Never 0 as a stand-in for unknown. */
    distanceMeters: number | null;
    durationSeconds: number | null;
    distanceKm: number | null;
    etaMinutes: number | null;
    etaStatus?: 'KNOWN' | 'UNKNOWN';
    routingProvider: string;
    trafficAware: boolean;
    synthetic?: boolean;
  };

  /** Financial feasibility indicators (advisory only, never hard blocking for emergencies). */
  financial?: {
    pricingTier: string;
    depositRequired: boolean;
    estimatedExposureInr?: number;
    financialExposureRisk: 'LOW' | 'MODERATE' | 'HIGH' | 'UNKNOWN';
  };

  /** Insurance and cashless compatibility indicators. */
  insurance?: {
    payerMatched: boolean;
    cashlessFeasible: boolean;
    empanelmentType?: string;
  };

  /** Full ledger of rules applied to this candidate. */
  ruleEvaluations: DecisionRuleEvaluation[];
}

/**
 * Immutable audit trace for emergency routing decisions.
 * Captures all candidate evaluations, deterministic rules, and evidence snapshots.
 * Strictly decoupled from autonomous AI; AI can explain this trace but cannot fabricate it.
 */
export interface DecisionTraceRecord {
  /** Unique decision trace identifier. */
  traceId: string;

  /** Emergency case or patient identifier. */
  caseId: string;

  /** Monotonic ISO 8601 generation timestamp. */
  timestamp: string;

  /** Event that triggered the evaluation (e.g. emergency reported, reroute, acceptance response). */
  trigger: {
    eventId: string;
    eventType: string;
    sourceId: string;
  };

  /** Comprehensive evaluation traces for all evaluated hospital candidates. */
  candidates: CandidateEvaluationTrace[];

  /** Final chosen hospital ID, if determined. */
  selectedHospitalId?: string;

  /** Concise summary of the deterministic selection rationale. */
  selectionRationale: string;

  /**
   * Optional human-readable advisory explanation.
   * Can be generated post-hoc by an advisory AI for human dispatchers.
   */
  advisoryExplanation?: string;

  /** Checksum or signature ensuring audit integrity. Excludes advisoryExplanation. */
  auditHash?: string;

  /** Feasibility engine provenance (CLAUDE-01). */
  snapshotId?: string;
  snapshotHash?: string;
  policyVersion?: string;
  policyHash?: string;
  engineVersion?: string;
  evaluatedAt?: string;
  outcome?: FeasibilityOutcome;
}
