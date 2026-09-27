import type {
  AcceptanceStatus,
  CandidateEvaluationTrace,
  DecisionRuleEvaluation,
  DecisionTraceRecord,
  FeasibilityDecision,
  FeasibilitySnapshot,
} from '@jiva/domain-models';
import { canonicalJson, sha256 } from './canonical';
import { EvaluatedCandidate } from './engine';
import { isUnknownFact } from './factors';

function acceptanceStatusOf(e: EvaluatedCandidate, snapshot: FeasibilitySnapshot): AcceptanceStatus {
  const acc = e.feasibility.hardConstraints.find(c => c.ruleId === 'HC-ACC-04');
  const r = e.input.acceptance.response;
  if (acc?.reasonCode === 'ACCEPTANCE_EXPIRED') return 'EXPIRED';
  if (r && r.caseId === snapshot.case.caseId) {
    if (acc?.outcome === 'PASS') return r.status;
    if (r.status === 'REJECTED' || r.status === 'UNAVAILABLE') return r.status;
  }
  if (e.input.acceptance.requestState === 'OUTSTANDING') return 'PENDING';
  return 'UNKNOWN';
}

function selectionRationale(decision: FeasibilityDecision): string {
  const n = decision.coverage.evaluated;
  if (decision.outcome === 'SELECTED') {
    const c = decision.candidates.find(x => x.hospitalId === decision.selectedHospitalId)!;
    return `Selected ${c.hospitalName} (${c.hospitalId}): first ELIGIBLE candidate by lexicographic order ` +
      `(verdict, ACCEPTED over LIMITED, known ETA ascending, distance, hospitalId) among ${n} evaluated. No aggregate score used.`;
  }
  if (decision.outcome === 'AWAITING_ACCEPTANCE') {
    return `No candidate has a current acceptance for this case; awaiting hospital responses. ${n} evaluated.`;
  }
  return `None of the ${n} evaluated facilities is feasible on current evidence. This is a statement about evaluated facilities only, not all facilities.`;
}

/**
 * Projects a FeasibilityDecision into the existing AG-01 DecisionTraceRecord.
 * The trace references snapshot evidence (EvidenceRefs) rather than live mutable state.
 * auditHash covers the whole record except auditHash and advisoryExplanation (AI text).
 */
export function buildDecisionTrace(
  snapshot: FeasibilitySnapshot,
  decision: FeasibilityDecision,
  evaluated: EvaluatedCandidate[]
): DecisionTraceRecord {
  const candidates: CandidateEvaluationTrace[] = evaluated.map(e => {
    const f = e.feasibility;
    const eta = snapshot.transport.etaByHospital[f.hospitalId];
    const known = eta && !isUnknownFact(eta) ? eta : undefined;
    const accepting = e.input.acceptance.response;
    const acc = f.hardConstraints.find(c => c.ruleId === 'HC-ACC-04');
    const ruleEvaluations: DecisionRuleEvaluation[] = f.hardConstraints.map(c => ({
      ruleId: c.ruleId,
      category: c.category,
      ruleName: c.ruleName,
      isHardConstraint: true,
      passed: c.outcome === 'PASS',
      outcome: c.outcome,
      reasonCode: c.reasonCode,
      rationale: c.rationale,
      evidenceRefs: c.evidenceRefs,
    }));
    return {
      hospitalId: f.hospitalId,
      hospitalName: f.hospitalName,
      rankOrder: f.orderPosition,
      verdict: f.verdict,
      isEligible: f.verdict === 'ELIGIBLE',
      blockingReasons: f.blockingReasons,
      pendingOn: f.pendingOn,
      disqualificationReason: f.verdict === 'INELIGIBLE' || f.verdict === 'INDETERMINATE'
        ? f.hardConstraints.filter(c => f.blockingReasons.includes(c.reasonCode) && c.outcome !== 'PASS').map(c => `${c.ruleId}: ${c.rationale}`).join(' | ')
        : undefined,
      clinical: {
        requiredCapabilitiesMatched: e.clinical.matched,
        missingCapabilities: e.clinical.missing,
        unknownCapabilities: e.clinical.unknown,
        passed: e.clinical.outcome === 'PASS',
      },
      operational: {
        acceptanceStatus: acceptanceStatusOf(e, snapshot),
        confirmedByClinician: acc?.outcome === 'PASS' && accepting?.trustedSource === 'HOSPITAL_CONFIRMED',
        acceptanceValidUntil: acc?.outcome === 'PASS' ? accepting?.validUntil : undefined,
        passed: acc?.outcome === 'PASS',
      },
      transit: {
        distanceMeters: known ? known.distanceMeters : null,
        durationSeconds: known ? known.durationSeconds : null,
        distanceKm: known ? Number((known.distanceMeters / 1000).toFixed(1)) : null,
        etaMinutes: known ? Math.ceil(known.durationSeconds / 60) : null,
        etaStatus: known ? 'KNOWN' : 'UNKNOWN',
        routingProvider: known ? known.provider : 'none',
        trafficAware: known ? known.trafficAware : false,
        synthetic: known ? known.synthetic : undefined,
      },
      contextualFactors: f.contextualFactors,
      ruleEvaluations,
    };
  });

  const record: DecisionTraceRecord = {
    traceId: decision.traceId,
    caseId: decision.caseId,
    timestamp: decision.evaluatedAt,
    trigger: snapshot.trigger,
    candidates,
    selectedHospitalId: decision.selectedHospitalId,
    selectionRationale: selectionRationale(decision),
    snapshotId: decision.snapshotId,
    snapshotHash: decision.snapshotHash,
    policyVersion: decision.policyVersion,
    policyHash: decision.policyHash,
    engineVersion: decision.engineVersion,
    evaluatedAt: decision.evaluatedAt,
    outcome: decision.outcome,
  };
  record.auditHash = computeAuditHash(record);
  return record;
}

export function computeAuditHash(record: DecisionTraceRecord): string {
  const { auditHash: _a, advisoryExplanation: _b, ...rest } = record;
  return sha256(canonicalJson(rest));
}
