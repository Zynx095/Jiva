import { createHash } from 'crypto';
import type { AmbulanceState, CareRequirement, GeoPoint, HospitalCandidate, HospitalState, PatientState } from '@jiva/domain-models';
import { evaluateHospitals } from '../../eligibilityEngine';
import { pickLegacyDestination } from '../../stateTransitions';
import { caseAcceptanceStatus } from '../acceptanceLedger';
import { observe } from '../containment';
import type { FeasibilityShadow } from '../shadow';
import { authorityKillSwitch, DecisionAuthorityKillSwitch } from './killSwitch';
import { AuthorityCircuitBreaker } from './circuitBreaker';
import { DecisionAuthorityMetrics } from './metrics';
import { PromotionGateValidator } from './promotionGates';
import { classifyDisagreement } from './disagreement';
import { configuredAuthorityMode } from './config';
import type {
  AuthorityMetricsSummary,
  AuthorityMode,
  DecisionAuthorityResult,
  DestinationSelectionInput,
  FallbackReason,
  FeasibilityDecisionSummary,
  FinalDecisionSummary,
  IDecisionAuthority,
  LegacyDecisionSummary,
} from './types';

export class DecisionAuthority implements IDecisionAuthority {
  readonly killSwitch: DecisionAuthorityKillSwitch;
  readonly circuitBreaker: AuthorityCircuitBreaker;
  readonly metrics: DecisionAuthorityMetrics;
  private readonly shadow: FeasibilityShadow;
  private readonly now: () => number;

  constructor(deps: {
    shadow: FeasibilityShadow;
    killSwitch?: DecisionAuthorityKillSwitch;
    circuitBreaker?: AuthorityCircuitBreaker;
    metrics?: DecisionAuthorityMetrics;
    now?: () => number;
  }) {
    this.shadow = deps.shadow;
    this.killSwitch = deps.killSwitch || authorityKillSwitch;
    this.circuitBreaker = deps.circuitBreaker || new AuthorityCircuitBreaker();
    this.metrics = deps.metrics || new DecisionAuthorityMetrics();
    this.now = deps.now || Date.now;
  }

  get mode(): AuthorityMode {
    return configuredAuthorityMode();
  }

  getMetrics(): AuthorityMetricsSummary {
    return this.metrics.getSummary();
  }

  reset(): void {
    this.killSwitch.restore();
    this.circuitBreaker.reset();
    this.metrics.reset();
  }

  /**
   * Primary decision authority gate for ambulance destination selection.
   *
   * Invariant:
   *   - In LEGACY, SHADOW, and CANARY modes, the legacy decision path strictly
   *     controls the actual destination returned (`finalDecision.source = 'LEGACY'`).
   *   - In AUTHORITATIVE mode, feasibility controls destination unless a circuit-breaker
   *     trip, timeout, or exception triggers the explicit fail-safe fallback to legacy.
   */
  async selectDestination(input: DestinationSelectionInput): Promise<DecisionAuthorityResult> {
    const startMs = this.now();
    const caseId = input.patient.patientId;
    const configuredMode = configuredAuthorityMode(caseId);
    let effectiveMode: AuthorityMode = configuredMode;
    let fallback = false;
    let fallbackReason: FallbackReason = 'NONE';

    // 1. Operational Kill Switch check
    const killSwitchActive = this.killSwitch.isActive();
    if (killSwitchActive && (configuredMode === 'CANARY' || configuredMode === 'AUTHORITATIVE')) {
      effectiveMode = 'SHADOW';
      fallback = true;
      fallbackReason = 'KILL_SWITCH_ACTIVE';
      console.warn(`[DecisionAuthority] Kill switch active (${this.killSwitch.getReason()}); forcing mode ${configuredMode} -> SHADOW`);
    }

    // 2. Authoritative Promotion Gate check
    if (effectiveMode === 'AUTHORITATIVE') {
      const gateResult = PromotionGateValidator.validate(this.metrics.getSummary());
      if (!gateResult.authorized) {
        effectiveMode = 'SHADOW';
        fallback = true;
        fallbackReason = 'PROMOTION_GATE_REJECTED';
        console.warn(`[DecisionAuthority] AUTHORITATIVE mode rejected by promotion gates (${gateResult.blockingReasons.join('; ')}); safely demoting to SHADOW mode.`);
      }
    }

    // 3. Circuit Breaker check (for Authoritative mode)
    if (effectiveMode === 'AUTHORITATIVE' && !this.circuitBreaker.canAttempt()) {
      effectiveMode = 'SHADOW';
      fallback = true;
      fallbackReason = 'CIRCUIT_BREAKER_OPEN';
      console.warn(`[DecisionAuthority] Circuit breaker is OPEN; falling back to legacy decision.`);
    }

    // 4. Compute Legacy Decision
    const origin: GeoPoint = input.ambulance.currentLocation || { latitude: 12.9716, longitude: 77.5946 };
    const nowForAcceptance = input.nowMs ?? this.now();
    const nowIso = new Date(nowForAcceptance).toISOString();
    const exclude = input.exclude ?? new Set<string>();
    const candidates = await evaluateHospitals(input.requirement, origin, {
      hospitals: input.hospitals,
      mapping: input.mapping,
      nowMs: nowForAcceptance,
      acceptanceOverride: hospitalId =>
        caseAcceptanceStatus(input.acceptanceView.view(caseId, hospitalId, nowForAcceptance), nowForAcceptance),
    });

    const hospitalsMap = new Map(input.hospitals.map(h => [h.hospitalId, h]));
    const legacySelectedId = pickLegacyDestination(candidates, exclude, caseId, id => hospitalsMap.get(id));

    const legacyEligibleIds = candidates
      .filter(c => c.operationalEligibility === 'ELIGIBLE')
      .map(c => c.hospitalId);

    const legacyDecision: LegacyDecisionSummary = {
      selectedHospitalId: legacySelectedId,
      candidatesCount: candidates.length,
      eligibleHospitalIds: legacyEligibleIds,
    };

    let feasibilityDecision: FeasibilityDecisionSummary | undefined = undefined;
    let finalDecision: FinalDecisionSummary = {
      selectedHospitalId: legacySelectedId,
      source: 'LEGACY',
    };
    let agreement = true;
    let disagreementClass: DecisionAuthorityResult['disagreementClass'] = 'AGREEMENT';
    let disagreementReasons: string[] = [];

    // 5. Execution path based on effective mode
    if (effectiveMode === 'LEGACY') {
      // Legacy only; feasibility is off
      finalDecision = { selectedHospitalId: legacySelectedId, source: 'LEGACY' };
      agreement = true;
      disagreementClass = 'AGREEMENT';
    } else if (effectiveMode === 'SHADOW') {
      // Legacy is authoritative; feasibility runs in contained background observation
      finalDecision = { selectedHospitalId: legacySelectedId, source: 'LEGACY' };

      observe('shadow.destination-selection', async () => {
        const shadowReq = await this.shadow.bounded(() => this.shadow.resolveRequirement(caseId));
        return this.shadow.evaluate({
          context: 'destination-selection',
          requirement: shadowReq || input.requirement,
          requirementProvenance: 'RULE_DERIVED',
          trigger: { eventId: 'n/a', eventType: 'destination.selection', sourceId: `routing-engine:${input.reason || 'destination selection'}`, sourceType: 'system' },
          origin,
          originAsOf: input.ambulance.locationAsOf,
          ambulanceId: input.ambulance.ambulanceId,
          excludedHospitalIds: [...exclude],
          hospitals: input.hospitals,
          legacyCandidates: candidates,
          legacySelection: { hospitalId: legacySelectedId },
          evaluatedAt: nowIso,
        });
      });
    } else if (effectiveMode === 'CANARY') {
      // Canary: Evaluate feasibility alongside legacy, compare decisions, but KEEP LEGACY AS THE ACTUAL DESTINATION
      let feasResult: Awaited<ReturnType<FeasibilityShadow['evaluate']>> | undefined;
      let hasTimeout = false;
      let hasError = false;

      try {
        const shadowReq = await this.shadow.bounded(() => this.shadow.resolveRequirement(caseId));
        feasResult = await this.shadow.evaluate({
          context: 'destination-selection',
          requirement: shadowReq || input.requirement,
          requirementProvenance: 'RULE_DERIVED',
          trigger: { eventId: 'n/a', eventType: 'destination.selection', sourceId: `routing-engine:${input.reason || 'canary-comparison'}`, sourceType: 'system' },
          origin,
          originAsOf: input.ambulance.locationAsOf,
          ambulanceId: input.ambulance.ambulanceId,
          excludedHospitalIds: [...exclude],
          hospitals: input.hospitals,
          legacyCandidates: candidates,
          legacySelection: { hospitalId: legacySelectedId },
          evaluatedAt: nowIso,
        });
        if (!feasResult) {
          hasTimeout = true;
        }
      } catch (err) {
        hasError = true;
      }

      if (feasResult && feasResult.decision && Array.isArray(feasResult.decision.candidates)) {
        const d = feasResult.decision;
        const eligible = d.candidates.filter(c => c.verdict === 'ELIGIBLE').map(c => c.hospitalId);
        feasibilityDecision = {
          selectedHospitalId: d.selectedHospitalId,
          verdict: d.candidates.find(c => c.hospitalId === d.selectedHospitalId)?.verdict,
          outcome: d.outcome,
          candidatesCount: d.candidates.length,
          eligibleHospitalIds: eligible,
          traceId: d.traceId,
          snapshotHash: d.snapshotHash,
          policyHash: d.policyHash,
        };
      }

      const feasSelectedId = feasibilityDecision?.selectedHospitalId;
      const feasReasons = feasResult && feasResult.decision && Array.isArray(feasResult.decision.candidates)
        ? (feasResult.decision.candidates.find(c => c.hospitalId === legacySelectedId)?.blockingReasons || [feasResult.decision.outcome])
        : [];

      const classified = classifyDisagreement({
        legacyHospitalId: legacySelectedId,
        feasibilityHospitalId: feasSelectedId,
        feasibilityReasons: feasReasons,
        hasTimeout,
        hasError,
      });

      disagreementClass = classified.classification;
      disagreementReasons = classified.reasons;
      agreement = classified.classification === 'AGREEMENT';

      // CRITICAL CANARY INVARIANT: Destination is always the legacy pick!
      finalDecision = {
        selectedHospitalId: legacySelectedId,
        source: 'LEGACY',
      };
    } else if (effectiveMode === 'AUTHORITATIVE') {
      // Future Authoritative Mode with Circuit Breaker Fallback
      let feasResult: Awaited<ReturnType<FeasibilityShadow['evaluate']>> | undefined;
      let hasTimeout = false;
      let hasError = false;

      try {
        const shadowReq = await this.shadow.bounded(() => this.shadow.resolveRequirement(caseId));
        feasResult = await this.shadow.evaluate({
          context: 'destination-selection',
          requirement: shadowReq || input.requirement,
          requirementProvenance: 'RULE_DERIVED',
          trigger: { eventId: 'n/a', eventType: 'destination.selection', sourceId: `routing-engine:${input.reason || 'authoritative-decision'}`, sourceType: 'system' },
          origin,
          originAsOf: input.ambulance.locationAsOf,
          ambulanceId: input.ambulance.ambulanceId,
          excludedHospitalIds: [...exclude],
          hospitals: input.hospitals,
          legacyCandidates: candidates,
          legacySelection: { hospitalId: legacySelectedId },
          evaluatedAt: nowIso,
        });
        if (!feasResult) hasTimeout = true;
      } catch (err) {
        hasError = true;
      }

      if (feasResult && feasResult.decision && Array.isArray(feasResult.decision.candidates)) {
        const d = feasResult.decision;
        const eligible = d.candidates.filter(c => c.verdict === 'ELIGIBLE').map(c => c.hospitalId);
        feasibilityDecision = {
          selectedHospitalId: d.selectedHospitalId,
          verdict: d.candidates.find(c => c.hospitalId === d.selectedHospitalId)?.verdict,
          outcome: d.outcome,
          candidatesCount: d.candidates.length,
          eligibleHospitalIds: eligible,
          traceId: d.traceId,
          snapshotHash: d.snapshotHash,
          policyHash: d.policyHash,
        };
      }

      const feasSelectedId = feasibilityDecision?.selectedHospitalId;
      const feasReasons = feasResult && feasResult.decision && Array.isArray(feasResult.decision.candidates)
        ? (feasResult.decision.candidates.find(c => c.hospitalId === legacySelectedId)?.blockingReasons || [feasResult.decision.outcome])
        : [];

      const classified = classifyDisagreement({
        legacyHospitalId: legacySelectedId,
        feasibilityHospitalId: feasSelectedId,
        feasibilityReasons: feasReasons,
        hasTimeout,
        hasError,
      });

      disagreementClass = classified.classification;
      disagreementReasons = classified.reasons;
      agreement = classified.classification === 'AGREEMENT';

      // Circuit Breaker & Fallback Evaluation
      if (hasError) {
        fallback = true;
        fallbackReason = 'FEASIBILITY_EXCEPTION';
        this.circuitBreaker.recordFailure(fallbackReason);
        finalDecision = { selectedHospitalId: legacySelectedId, source: 'LEGACY' };
      } else if (hasTimeout) {
        fallback = true;
        fallbackReason = 'FEASIBILITY_TIMEOUT';
        this.circuitBreaker.recordFailure(fallbackReason);
        finalDecision = { selectedHospitalId: legacySelectedId, source: 'LEGACY' };
      } else if (disagreementClass === 'UNEXPECTED_DIFFERENCE') {
        // Unexpected difference in authoritative mode triggers safety fallback
        fallback = true;
        fallbackReason = 'UNEXPECTED_DISAGREEMENT';
        this.circuitBreaker.recordFailure(fallbackReason);
        finalDecision = { selectedHospitalId: legacySelectedId, source: 'LEGACY' };
      } else if (feasResult && feasibilityDecision) {
        this.circuitBreaker.recordSuccess();
        finalDecision = {
          selectedHospitalId: feasSelectedId,
          source: 'FEASIBILITY',
        };
      } else {
        fallback = true;
        fallbackReason = 'FEASIBILITY_MALFORMED';
        this.circuitBreaker.recordFailure(fallbackReason);
        finalDecision = { selectedHospitalId: legacySelectedId, source: 'LEGACY' };
      }
    }

    const endMs = this.now();
    const executionTimeMs = endMs - startMs;
    const timestamp = new Date(nowForAcceptance).toISOString();

    // Deterministic Audit Hash (strictly no random IDs or fluctuating system timers)
    const hashMaterial = JSON.stringify({
      caseId,
      configuredMode,
      effectiveMode,
      legacySelectedId: legacyDecision.selectedHospitalId,
      feasibilitySelectedId: feasibilityDecision?.selectedHospitalId,
      finalSelectedId: finalDecision.selectedHospitalId,
      finalSource: finalDecision.source,
      agreement,
      disagreementClass,
      fallback,
      fallbackReason,
      snapshotHash: feasibilityDecision?.snapshotHash,
      policyHash: feasibilityDecision?.policyHash,
    });
    const auditHash = createHash('sha256').update(hashMaterial).digest('hex');

    const result: DecisionAuthorityResult = {
      caseId,
      context: 'destination-selection',
      configuredMode,
      effectiveMode,
      legacyDecision,
      feasibilityDecision,
      finalDecision,
      agreement,
      disagreementClass,
      disagreementReasons,
      fallback,
      fallbackReason,
      killSwitchActive,
      circuitBreakerState: this.circuitBreaker.getState(),
      timestamp,
      executionTimeMs,
      auditHash,
    };

    this.metrics.recordEvaluation(result);
    return result;
  }
}
