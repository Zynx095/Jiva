import { DataStatus } from './hospital';

/**
 * Canonical evidence wrapper for any evidence-bearing datum in JIVA.
 * Ensures data values are never decoupled from provenance, confidence,
 * observation time, or verification status.
 *
 * Applicable to:
 * - Hospital facility profiles & static capabilities
 * - Historical and operational bed capacities
 * - Insurance empanelment and cashless support
 * - Financial pricing tiers and deposit requirements
 * - Telemetry, clinical observations, and coordinator actions
 */
export interface EvidenceRecord<T = unknown> {
  /** The reported value or payload. */
  value: T;

  /**
   * Specific identifier of the source:
   * e.g., 'bbmp-covid-audit-2021', 'nhp-hfr-registry', 'star-health-tpa-portal', 'clinician-dr-sharma'
   */
  source: string;

  /**
   * Categorical classification of the source:
   * e.g., 'GOVERNMENT_REGISTRY', 'HOSPITAL_WEBSITE', 'CLINICIAN_ENTRY',
   * 'TPA_PORTAL', 'AUTHORIZED_EHR_FEED', 'TELEMETRY_STREAM', 'SYNTHETIC_GENERATOR'
   */
  sourceType: string;

  /** ISO 8601 timestamp of when the datum was observed in the real world. */
  observedAt: string;

  /** ISO 8601 timestamp after which the datum is considered expired or invalid. */
  validUntil?: string;

  /** Confidence score between 0.0 (unverified / untrusted) and 1.0 (authoritative). */
  confidence: number;

  /**
   * Data verification status conforming to the JIVA canonical taxonomy.
   * Permitted values:
   * - 'CURRENT': Verified real-time operational state
   * - 'HISTORICAL': Past baseline or audit record (NOT current capacity)
   * - 'PUBLIC_LISTED': Sourced from public registry or website
   * - 'HOSPITAL_CONFIRMED': Attested by an on-duty hospital clinician/operator
   * - 'AUTHORIZED_FEED': Direct digital API integration from hospital system
   * - 'SYNTHETIC_DEMO': Generated for simulation / demo scenario
   * - 'UNKNOWN': Explicitly unconfirmed or unobserved
   * - 'NOT_DISCLOSED': Withheld by the institution
   * - 'UNVERIFIED': Present in secondary source without primary verification
   */
  dataStatus: DataStatus;

  /** Optional direct URI to the original public or regulatory publication. */
  sourceUrl?: string;

  /** Optional explanatory caveats or audit notes. */
  notes?: string;
}

/**
 * Historical collection of evidence records over time for auditability.
 */
export interface EvidenceChain<T = unknown> {
  attributeName: string;
  current?: EvidenceRecord<T>;
  history: EvidenceRecord<T>[];
}

// ---------------------------------------------------------------------------
// ARCHITECTURAL INVARIANT ENFORCEMENT
// ---------------------------------------------------------------------------

/**
 * Core Invariant: Historical or public facility information must NEVER
 * automatically become current operational availability.
 *
 * Returns true ONLY if the evidence is backed by positive live confirmation
 * ('HOSPITAL_CONFIRMED', 'AUTHORIZED_FEED', or active 'CURRENT').
 */
export function isValidOperationalEvidence(evidence: EvidenceRecord<unknown>): boolean {
  if (!evidence) return false;
  if (
    evidence.dataStatus === 'HISTORICAL' ||
    evidence.dataStatus === 'PUBLIC_LISTED' ||
    evidence.dataStatus === 'UNVERIFIED' ||
    evidence.dataStatus === 'NOT_DISCLOSED' ||
    evidence.dataStatus === 'UNKNOWN'
  ) {
    return false;
  }
  return (
    evidence.dataStatus === 'HOSPITAL_CONFIRMED' ||
    evidence.dataStatus === 'AUTHORIZED_FEED' ||
    evidence.dataStatus === 'CURRENT'
  );
}

/**
 * Asserts that historical or public listings cannot be promoted to current operational availability.
 * Throws an Error if an illegal promotion is attempted.
 */
export function assertNoHistoricalPromotion(
  evidence: EvidenceRecord<unknown>,
  targetContext = 'operational availability'
): void {
  if (evidence.dataStatus === 'HISTORICAL' || evidence.dataStatus === 'PUBLIC_LISTED') {
    throw new Error(
      `Architectural Invariant Violation: Cannot promote ${evidence.dataStatus} evidence from '${evidence.source}' into ${targetContext}. Operational availability requires HOSPITAL_CONFIRMED or AUTHORIZED_FEED.`
    );
  }
}
