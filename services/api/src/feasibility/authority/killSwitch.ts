/**
 * Operational Safety Kill Switch for JIVA Decision Authority.
 *
 * The kill switch can instantly disable CANARY and future AUTHORITATIVE modes,
 * reverting authority cleanly to safe SHADOW (or LEGACY) operation.
 *
 * Invariant: Tripping the kill switch NEVER disables:
 *   - Emergency intake
 *   - Legacy routing & destination selection
 *   - Hospital acceptance & capacity processing
 *   - Ambulance telemetry & dispatch
 *   - Patient tracking
 */

export class DecisionAuthorityKillSwitch {
  private programmaticTrip = false;
  private tripReason: string | undefined = undefined;
  private trippedAt: string | undefined = undefined;

  /** Check if the kill switch is currently active (via env or programmatically). */
  isActive(): boolean {
    if (this.programmaticTrip) return true;
    const envVal = (process.env.DECISION_AUTHORITY_KILL_SWITCH || '').trim().toLowerCase();
    return envVal === 'true' || envVal === '1' || envVal === 'yes' || envVal === 'on';
  }

  /** Retrieve the reason why the kill switch was tripped. */
  getReason(): string | undefined {
    if (this.tripReason) return this.tripReason;
    if (this.isActive()) return 'Environment variable DECISION_AUTHORITY_KILL_SWITCH is enabled';
    return undefined;
  }

  getTrippedAt(): string | undefined {
    return this.trippedAt;
  }

  /** Programmatically trip the kill switch. */
  trip(reason: string): void {
    this.programmaticTrip = true;
    this.tripReason = reason;
    this.trippedAt = new Date().toISOString();
    console.error(`[DecisionAuthorityKillSwitch] TRIPPED: ${reason}. Forcing safe SHADOW mode.`);
  }

  /** Reset / restore the kill switch to normal operation. */
  restore(): void {
    if (this.programmaticTrip) {
      console.log(`[DecisionAuthorityKillSwitch] RESTORED: Programmatic trip cleared.`);
    }
    this.programmaticTrip = false;
    this.tripReason = undefined;
    this.trippedAt = undefined;
  }
}

export const authorityKillSwitch = new DecisionAuthorityKillSwitch();
