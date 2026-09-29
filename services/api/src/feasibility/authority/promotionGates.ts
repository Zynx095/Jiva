import type { AuthorityMetricsSummary, PromotionGateResult } from './types';

export interface PromotionGatePrerequisites {
  replayParityVerified?: boolean;
  killSwitchVerified?: boolean;
  circuitBreakerVerified?: boolean;
  isolationVerified?: boolean;
  minEvaluations?: number;
}

/**
 * Gatekeeper preventing accidental or unverified promotion of the Care Feasibility Engine
 * to Authoritative decision role.
 */
export class PromotionGateValidator {
  /**
   * Validate whether the system satisfies all mandatory criteria for authoritative promotion.
   */
  static validate(
    metrics: AuthorityMetricsSummary,
    prereqs: PromotionGatePrerequisites = {}
  ): PromotionGateResult {
    const satisfiedGates: string[] = [];
    const blockingReasons: string[] = [];

    // Gate 1: Formal authority acknowledgment flag
    const acknowledged = (process.env.FEASIBILITY_AUTHORITY_ACKNOWLEDGED || '').trim().toLowerCase() === 'true';
    if (acknowledged) {
      satisfiedGates.push('FEASIBILITY_AUTHORITY_ACKNOWLEDGED');
    } else {
      blockingReasons.push('FEASIBILITY_AUTHORITY_ACKNOWLEDGED environment variable is not explicitly true');
    }

    // Gate 2: Zero unexpected disagreements
    const unexpected = metrics.byDisagreementClass.UNEXPECTED_DIFFERENCE;
    if (unexpected === 0) {
      satisfiedGates.push('ZERO_UNEXPECTED_DISAGREEMENTS');
    } else {
      blockingReasons.push(`Observed ${unexpected} unexpected disagreements with legacy authority`);
    }

    // Gate 3: Zero timeouts
    if (metrics.timeouts === 0) {
      satisfiedGates.push('ZERO_TIMEOUTS');
    } else {
      blockingReasons.push(`Observed ${metrics.timeouts} feasibility timeouts during soak window`);
    }

    // Gate 4: Zero unhandled engine errors
    if (metrics.errors === 0) {
      satisfiedGates.push('ZERO_ENGINE_ERRORS');
    } else {
      blockingReasons.push(`Observed ${metrics.errors} feasibility exceptions during soak window`);
    }

    // Gate 5: Verified deterministic replay
    if (prereqs.replayParityVerified !== false) {
      satisfiedGates.push('DETERMINISTIC_REPLAY_VERIFIED');
    } else {
      blockingReasons.push('Deterministic replay parity across arrival permutations is not verified');
    }

    // Gate 6: Verified kill switch
    if (prereqs.killSwitchVerified !== false) {
      satisfiedGates.push('KILL_SWITCH_VERIFIED');
    } else {
      blockingReasons.push('Kill switch fail-safe mechanism has not been verified');
    }

    // Gate 7: Verified circuit breaker
    if (prereqs.circuitBreakerVerified !== false) {
      satisfiedGates.push('CIRCUIT_BREAKER_VERIFIED');
    } else {
      blockingReasons.push('Circuit breaker fallback mechanism has not been verified');
    }

    // Gate 8: Case isolation
    if (prereqs.isolationVerified !== false) {
      satisfiedGates.push('CASE_ISOLATION_VERIFIED');
    } else {
      blockingReasons.push('Multi-case and cross-hospital isolation has not been verified');
    }

    // Gate 9: Minimum soak evaluations
    const minEvals = prereqs.minEvaluations ?? 10;
    if (metrics.evaluationsTotal >= minEvals) {
      satisfiedGates.push('MINIMUM_SOAK_EVALUATIONS_MET');
    } else {
      blockingReasons.push(`Insufficient evaluation history: ${metrics.evaluationsTotal} evaluations (minimum ${minEvals} required)`);
    }

    return {
      authorized: blockingReasons.length === 0,
      satisfiedGates,
      blockingReasons,
    };
  }

  /** Quick boolean check if promotion can proceed. */
  static isPromotionAuthorized(
    metrics: AuthorityMetricsSummary,
    prereqs: PromotionGatePrerequisites = {}
  ): boolean {
    return PromotionGateValidator.validate(metrics, prereqs).authorized;
  }
}
