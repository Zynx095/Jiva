import type {
  CandidateFeasibility,
  ConstraintResult,
  FeasibilityDecision,
  FeasibilitySnapshot,
  FeasibilityVerdict,
  HospitalInput,
  OrderKey,
  ReasonCode,
} from '@jiva/domain-models';
import { cmp, hashSnapshot } from './canonical';
import { etaFor, factorAcceptanceKind, factorEta, factorFinancial, factorInsurance, isUnknownFact } from './factors';
import { FreshnessPolicy, hashPolicy } from './policy';
import {
  currentAccepting,
  isOperationalGrade,
  ruleCareWindow,
  ruleCurrentAcceptance,
  ruleEmergencyDepartment,
  ruleLimitedCoversRequired,
  ruleLocatable,
  ruleNotHospitalUnavailable,
  ruleNotRejected,
  ruleRequiredCapability,
  ruleRequiredUnits,
  RuleContext,
} from './rules';
import { assessFreshness } from './policy';

export const ENGINE_VERSION = 'care-feasibility-1.0.0';

export interface EvaluatedCandidate {
  feasibility: CandidateFeasibility;
  /** Detail used by the trace builder. */
  clinical: { matched: string[]; missing: string[]; unknown: string[]; outcome: ConstraintResult['outcome'] };
  input: HospitalInput;
}

/**
 * Verdict aggregation — a total function over hard-constraint outcomes.
 *   any FAIL                                   -> INELIGIBLE
 *   any UNKNOWN not resolvable by acceptance   -> INDETERMINATE
 *   HC-ACC-04 (current acceptance) not PASS     -> PENDING_ACCEPTANCE
 *   otherwise                                   -> ELIGIBLE
 */
export function aggregateVerdict(constraints: ConstraintResult[]): { verdict: FeasibilityVerdict; blocking: ReasonCode[] } {
  const fails = constraints.filter(c => c.outcome === 'FAIL');
  if (fails.length) return { verdict: 'INELIGIBLE', blocking: fails.map(c => c.reasonCode) };
  const hardUnknowns = constraints.filter(c => c.outcome === 'UNKNOWN' && !c.resolvableByAcceptance);
  if (hardUnknowns.length) return { verdict: 'INDETERMINATE', blocking: hardUnknowns.map(c => c.reasonCode) };
  const acc = constraints.find(c => c.ruleId === 'HC-ACC-04');
  if (!acc || acc.outcome !== 'PASS') return { verdict: 'PENDING_ACCEPTANCE', blocking: acc ? [acc.reasonCode] : ['NO_REQUEST'] };
  return { verdict: 'ELIGIBLE', blocking: [] };
}

const VERDICT_RANK: Record<FeasibilityVerdict, number> = { ELIGIBLE: 0, PENDING_ACCEPTANCE: 1, INDETERMINATE: 2, INELIGIBLE: 3 };

/** Lexicographic ordering; no weights. Unknown ETA sorts after every known ETA (never as 0). */
export function compareOrderKeys(a: OrderKey, b: OrderKey): number {
  if (a.verdictRank !== b.verdictRank) return a.verdictRank - b.verdictRank;
  if (a.acceptanceKindRank !== b.acceptanceKindRank) return a.acceptanceKindRank - b.acceptanceKindRank;
  if (a.etaKnown !== b.etaKnown) return a.etaKnown ? -1 : 1;
  if (a.etaKnown && b.etaKnown && a.etaSeconds !== b.etaSeconds) return (a.etaSeconds as number) - (b.etaSeconds as number);
  const da = a.distanceMeters ?? Number.POSITIVE_INFINITY;
  const db = b.distanceMeters ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  return cmp(a.hospitalId, b.hospitalId);
}

function evaluateCandidate(snapshot: FeasibilitySnapshot, policy: FreshnessPolicy, h: HospitalInput, index: number): EvaluatedCandidate {
  const ctx: RuleContext = { snapshot, policy, hospitalIndex: index };
  const clinical = ruleRequiredCapability(ctx, h);
  const acceptance = ruleCurrentAcceptance(ctx, h);
  const { matched, missing, unknown, ...clinicalResult } = clinical;
  const { pendingOn, ...acceptanceResult } = acceptance;
  const hardConstraints: ConstraintResult[] = [
    clinicalResult,
    ruleEmergencyDepartment(ctx, h),
    ruleRequiredUnits(ctx, h),
    ruleNotRejected(ctx, h),
    ruleNotHospitalUnavailable(ctx, h),
    ruleLimitedCoversRequired(ctx, h),
    acceptanceResult,
    ruleLocatable(ctx, h),
    ruleCareWindow(),
  ];
  const { verdict, blocking } = aggregateVerdict(hardConstraints);

  const eta = etaFor(ctx, h);
  const accepting = currentAccepting(ctx, h);
  const orderKey: OrderKey = {
    verdictRank: VERDICT_RANK[verdict],
    acceptanceKindRank: !accepting ? 2 : accepting.response.status === 'ACCEPTED' ? 0 : 1,
    etaKnown: !isUnknownFact(eta),
    etaSeconds: isUnknownFact(eta) ? null : eta.durationSeconds,
    distanceMeters: isUnknownFact(eta) ? null : eta.distanceMeters,
    hospitalId: h.hospitalId,
  };
  const excluded = (snapshot.case.excludedHospitalIds || []).includes(h.hospitalId);
  return {
    input: h,
    clinical: { matched, missing, unknown, outcome: clinical.outcome },
    feasibility: {
      hospitalId: h.hospitalId,
      hospitalName: h.displayName,
      verdict,
      hardConstraints,
      contextualFactors: [
        factorAcceptanceKind(ctx, h),
        factorEta(ctx, h),
        factorFinancial(ctx, h),
        factorInsurance(ctx, h),
      ],
      blockingReasons: blocking,
      pendingOn: verdict === 'PENDING_ACCEPTANCE' ? pendingOn : undefined,
      orderKey,
      orderPosition: -1,
      excludedFromSelection: excluded,
    },
  };
}

function canonicalCandidates(snapshot: FeasibilitySnapshot): HospitalInput[] {
  return [...snapshot.candidates].sort((a, b) => cmp(a.hospitalId, b.hospitalId));
}

/**
 * Stage A screen: hard constraints only (no transport). Returns the hospitals worth routing to,
 * i.e. everything not INELIGIBLE. The shell calls mapping ONLY for these.
 */
export function screenCandidates(snapshot: FeasibilitySnapshot, policy: FreshnessPolicy): { hospitalId: string; verdict: FeasibilityVerdict }[] {
  return canonicalCandidates(snapshot)
    .map((h, i) => evaluateCandidate(snapshot, policy, h, i).feasibility)
    .filter(c => c.verdict !== 'INELIGIBLE')
    .map(c => ({ hospitalId: c.hospitalId, verdict: c.verdict }));
}

export interface DecisionIds { decisionId: string; traceId: string }

/**
 * Full deterministic evaluation of a complete snapshot. Pure: same snapshot + policy + ids
 * always yields a byte-identical decision. Reads no clock other than snapshot.evaluatedAt.
 */
export function evaluateFeasibility(
  snapshot: FeasibilitySnapshot,
  policy: FreshnessPolicy,
  ids: DecisionIds
): { decision: FeasibilityDecision; evaluated: EvaluatedCandidate[] } {
  if (policy.version !== snapshot.policyVersion) {
    throw new Error(`Policy version mismatch: snapshot=${snapshot.policyVersion} policy=${policy.version}`);
  }
  if (snapshot.policyHash !== hashPolicy(policy)) {
    throw new Error('Policy hash mismatch: the snapshot was assembled under a different effective policy');
  }
  if (!Number.isFinite(Date.parse(snapshot.evaluatedAt))) throw new Error('snapshot.evaluatedAt is not a valid timestamp');

  const evaluated = canonicalCandidates(snapshot).map((h, i) => evaluateCandidate(snapshot, policy, h, i));
  evaluated.sort((a, b) => compareOrderKeys(a.feasibility.orderKey, b.feasibility.orderKey));
  evaluated.forEach((e, i) => { e.feasibility.orderPosition = i + 1; });

  const candidates = evaluated.map(e => e.feasibility);
  const selected = candidates.find(c => c.verdict === 'ELIGIBLE' && !c.excludedFromSelection);
  const awaiting = candidates.some(c => c.verdict === 'PENDING_ACCEPTANCE' && !c.excludedFromSelection);

  const opFresh = (h: HospitalInput) =>
    isOperationalGrade(h.operational.dataStatus, policy) &&
    assessFreshness('OPERATIONAL_CAPACITY', h.operational, snapshot.evaluatedAt, policy).freshness === 'FRESH';

  const decision: FeasibilityDecision = {
    decisionId: ids.decisionId,
    traceId: ids.traceId,
    snapshotId: snapshot.snapshotId,
    snapshotHash: hashSnapshot(snapshot),
    evaluatedAt: snapshot.evaluatedAt,
    policyVersion: policy.version,
    policyHash: snapshot.policyHash,
    engineVersion: ENGINE_VERSION,
    caseId: snapshot.case.caseId,
    outcome: selected ? 'SELECTED' : awaiting ? 'AWAITING_ACCEPTANCE' : 'NO_FEASIBLE_CANDIDATE',
    selectedHospitalId: selected?.hospitalId,
    candidates,
    coverage: {
      evaluated: snapshot.candidates.length,
      withUsableOperationalEvidence: snapshot.candidates.filter(opFresh).length,
      withSyntheticEvidence: snapshot.candidates.filter(h =>
        h.operational.dataStatus === 'SYNTHETIC_DEMO' || h.capabilities.dataStatus === 'SYNTHETIC_DEMO' ||
        h.acceptance.response?.trustedSource === 'SYNTHETIC_DEMO').length,
      withFinancialEvidence: snapshot.candidates.filter(h => !!h.financialProfile).length,
      withInsuranceEvidence: snapshot.candidates.filter(h => !!h.insuranceProfile).length,
    },
  };
  return { decision, evaluated };
}
