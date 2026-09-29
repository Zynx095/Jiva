import type { DisagreementClassification } from './types';

export interface DisagreementContext {
  legacyHospitalId?: string;
  feasibilityHospitalId?: string;
  feasibilityReasons?: string[];
  hasTimeout?: boolean;
  hasError?: boolean;
  missingEvidence?: boolean;
}

const EXPECTED_POLICY_REASON_CODES = new Set([
  'LIMITED_MISSING_CAPABILITY',
  'EVIDENCE_NOT_OPERATIONAL_GRADE',
  'NOT_LISTED',
  'UNRECOGNIZED_CAPABILITY',
  'OPERATIONAL_UNAVAILABLE',
]);

const MISSING_EVIDENCE_CODES = new Set([
  'NO_LIVE_EVIDENCE',
  'EVIDENCE_STALE',
  'EVIDENCE_UNTIMED',
  'NO_REQUEST',
  'NO_RESPONSE_YET',
]);

/**
 * Deterministically classifies disagreements between legacy decision and feasibility decision.
 * Never collapses unexpected differences into generic categories.
 */
export function classifyDisagreement(ctx: DisagreementContext): {
  classification: DisagreementClassification;
  reasons: string[];
} {
  const { legacyHospitalId, feasibilityHospitalId, feasibilityReasons = [], hasTimeout, hasError, missingEvidence } = ctx;

  if (hasError) {
    return { classification: 'ENGINE_ERROR', reasons: ['Feasibility evaluation threw an error'] };
  }

  if (hasTimeout) {
    return { classification: 'TIMEOUT', reasons: ['Feasibility evaluation exceeded time budget'] };
  }

  // Agreement
  if (legacyHospitalId === feasibilityHospitalId) {
    return { classification: 'AGREEMENT', reasons: [] };
  }

  // Check for expected policy divergences
  const hasExpectedPolicy = feasibilityReasons.some(r => EXPECTED_POLICY_REASON_CODES.has(r));
  if (hasExpectedPolicy) {
    const policyReasons = feasibilityReasons.filter(r => EXPECTED_POLICY_REASON_CODES.has(r));
    return { classification: 'EXPECTED_POLICY_DIFFERENCE', reasons: policyReasons };
  }

  // Check for missing evidence
  if (missingEvidence || feasibilityReasons.some(r => MISSING_EVIDENCE_CODES.has(r))) {
    const evidenceReasons = feasibilityReasons.filter(r => MISSING_EVIDENCE_CODES.has(r));
    return { classification: 'MISSING_EVIDENCE', reasons: evidenceReasons.length ? evidenceReasons : ['Evidence unavailable or stale'] };
  }

  // Asymmetric selection: one selected, one none
  if (legacyHospitalId && !feasibilityHospitalId) {
    return { classification: 'LEGACY_ONLY', reasons: feasibilityReasons.length ? feasibilityReasons : ['Legacy selected destination; feasibility found no eligible hospital'] };
  }

  if (!legacyHospitalId && feasibilityHospitalId) {
    return { classification: 'FEASIBILITY_ONLY', reasons: ['Feasibility selected hospital; legacy found no destination'] };
  }

  // Both chose different valid hospitals without an expected policy divergence
  return {
    classification: 'UNEXPECTED_DIFFERENCE',
    reasons: [`Legacy chose ${legacyHospitalId}, but feasibility chose ${feasibilityHospitalId}`],
  };
}
