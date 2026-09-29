import type {
  AuthorityMetricsSummary,
  AuthorityMode,
  DecisionAuthorityResult,
  DisagreementClassification,
  FallbackReason,
} from './types';

export class DecisionAuthorityMetrics {
  private evaluationsTotal = 0;
  private byMode: Record<AuthorityMode, number> = {
    LEGACY: 0,
    SHADOW: 0,
    CANARY: 0,
    AUTHORITATIVE: 0,
  };
  private agreedCount = 0;
  private disagreedCount = 0;
  private byDisagreementClass: Record<DisagreementClassification, number> = {
    AGREEMENT: 0,
    EXPECTED_POLICY_DIFFERENCE: 0,
    UNEXPECTED_DIFFERENCE: 0,
    MISSING_EVIDENCE: 0,
    LEGACY_ONLY: 0,
    FEASIBILITY_ONLY: 0,
    TIMEOUT: 0,
    ENGINE_ERROR: 0,
  };
  private timeouts = 0;
  private errors = 0;
  private fallbacksTriggered = 0;
  private byFallbackReason: Record<FallbackReason, number> = {
    NONE: 0,
    CIRCUIT_BREAKER_OPEN: 0,
    FEASIBILITY_TIMEOUT: 0,
    FEASIBILITY_EXCEPTION: 0,
    FEASIBILITY_MALFORMED: 0,
    UNEXPECTED_DISAGREEMENT: 0,
    KILL_SWITCH_ACTIVE: 0,
    PROMOTION_GATE_REJECTED: 0,
  };
  private circuitBreakerTrips = 0;
  private killSwitchTrips = 0;

  recordEvaluation(result: DecisionAuthorityResult): void {
    this.evaluationsTotal++;
    this.byMode[result.effectiveMode]++;

    if (result.agreement) {
      this.agreedCount++;
    } else {
      this.disagreedCount++;
    }

    this.byDisagreementClass[result.disagreementClass]++;

    if (result.disagreementClass === 'TIMEOUT') {
      this.timeouts++;
    } else if (result.disagreementClass === 'ENGINE_ERROR') {
      this.errors++;
    }

    if (result.fallback) {
      this.fallbacksTriggered++;
      this.byFallbackReason[result.fallbackReason]++;
    }

    if (result.killSwitchActive) {
      this.killSwitchTrips++;
    }
  }

  recordCircuitBreakerTrip(): void {
    this.circuitBreakerTrips++;
  }

  getSummary(): AuthorityMetricsSummary {
    return {
      evaluationsTotal: this.evaluationsTotal,
      byMode: { ...this.byMode },
      agreedCount: this.agreedCount,
      disagreedCount: this.disagreedCount,
      byDisagreementClass: { ...this.byDisagreementClass },
      timeouts: this.timeouts,
      errors: this.errors,
      fallbacksTriggered: this.fallbacksTriggered,
      byFallbackReason: { ...this.byFallbackReason },
      canaryEvaluations: this.byMode.CANARY,
      authoritativeEvaluations: this.byMode.AUTHORITATIVE,
      circuitBreakerTrips: this.circuitBreakerTrips,
      killSwitchTrips: this.killSwitchTrips,
    };
  }

  reset(): void {
    this.evaluationsTotal = 0;
    this.byMode = { LEGACY: 0, SHADOW: 0, CANARY: 0, AUTHORITATIVE: 0 };
    this.agreedCount = 0;
    this.disagreedCount = 0;
    this.byDisagreementClass = {
      AGREEMENT: 0,
      EXPECTED_POLICY_DIFFERENCE: 0,
      UNEXPECTED_DIFFERENCE: 0,
      MISSING_EVIDENCE: 0,
      LEGACY_ONLY: 0,
      FEASIBILITY_ONLY: 0,
      TIMEOUT: 0,
      ENGINE_ERROR: 0,
    };
    this.timeouts = 0;
    this.errors = 0;
    this.fallbacksTriggered = 0;
    this.byFallbackReason = {
      NONE: 0,
      CIRCUIT_BREAKER_OPEN: 0,
      FEASIBILITY_TIMEOUT: 0,
      FEASIBILITY_EXCEPTION: 0,
      FEASIBILITY_MALFORMED: 0,
      UNEXPECTED_DISAGREEMENT: 0,
      KILL_SWITCH_ACTIVE: 0,
      PROMOTION_GATE_REJECTED: 0,
    };
    this.circuitBreakerTrips = 0;
    this.killSwitchTrips = 0;
  }
}
