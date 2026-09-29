import type { CircuitBreakerState, FallbackReason } from './types';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

/**
 * Circuit breaker protecting the decision path against cascading feasibility failures.
 *
 * States:
 *   - CLOSED: Normal operation; feasibility evaluation attempts allowed.
 *   - OPEN: Tripped due to consecutive errors/timeouts; calls immediately fall back to legacy.
 *   - HALF_OPEN: Probing recovery with a single evaluation after the cool-down window.
 */
export class AuthorityCircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private tripCount = 0;
  private lastFailureTime = 0;
  private lastTripReason: FallbackReason = 'NONE';
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
  }

  getState(): CircuitBreakerState {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
      }
    }
    return this.state;
  }

  canAttempt(): boolean {
    const current = this.getState();
    return current === 'CLOSED' || current === 'HALF_OPEN';
  }

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      console.log('[AuthorityCircuitBreaker] Probe succeeded; transitioning HALF_OPEN -> CLOSED.');
    }
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
  }

  recordFailure(reason: FallbackReason): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.trip(reason);
    }
  }

  trip(reason: FallbackReason): void {
    this.state = 'OPEN';
    this.tripCount++;
    this.lastFailureTime = Date.now();
    this.lastTripReason = reason;
    console.error(`[AuthorityCircuitBreaker] TRIPPED to OPEN state (${reason}). Consecutive failures: ${this.consecutiveFailures}.`);
  }

  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.lastTripReason = 'NONE';
  }

  getTripCount(): number {
    return this.tripCount;
  }

  getLastTripReason(): FallbackReason {
    return this.lastTripReason;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }
}
