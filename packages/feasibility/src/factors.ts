import type {
  EtaEvidence,
  EvidenceRecord,
  EvidenceRef,
  FactorResult,
  HospitalInput,
  KnowledgeLevel,
  UnknownFact,
} from '@jiva/domain-models';
import { assessFreshness } from './policy';
import { currentAccepting, RuleContext } from './rules';

/**
 * Soft / contextual factors. None of these can change a verdict. Only factors with
 * affectsOrdering=true participate in the lexicographic ordering key (see order.ts).
 */

export function isUnknownFact(v: unknown): v is UnknownFact {
  return !!v && typeof v === 'object' && (v as UnknownFact).status === 'UNKNOWN';
}

export function etaFor(ctx: RuleContext, h: HospitalInput): EtaEvidence | UnknownFact {
  const eta = ctx.snapshot.transport.etaByHospital[h.hospitalId];
  if (!eta) return { status: 'UNKNOWN', reasonCode: 'ROUTE_FAILED', detail: 'No ETA computed for this candidate.' };
  if (isUnknownFact(eta)) return eta;
  if (!Number.isFinite(eta.durationSeconds) || eta.durationSeconds < 0 || !Number.isFinite(eta.distanceMeters)) {
    return { status: 'UNKNOWN', reasonCode: 'ROUTE_FAILED', detail: 'ETA value invalid.' };
  }
  return eta;
}

export function factorEta(ctx: RuleContext, h: HospitalInput): FactorResult {
  const eta = etaFor(ctx, h);
  if (isUnknownFact(eta)) {
    return {
      factorId: 'SF-ETA', affectsOrdering: true, level: 'UNKNOWN', reasonCode: eta.reasonCode,
      summary: `ETA unknown (${eta.detail}). Ordered after candidates with a known ETA; never treated as 0.`,
      evidenceRefs: [],
    };
  }
  const fresh = assessFreshness('ROUTE_ETA', { observedAt: eta.calculatedAt }, ctx.snapshot.evaluatedAt, ctx.policy);
  const origin = ctx.snapshot.transport.origin;
  const originFresh = origin ? assessFreshness('AMBULANCE_POSITION', origin, ctx.snapshot.evaluatedAt, ctx.policy) : undefined;
  const quality: string[] = [];
  if (eta.synthetic) quality.push('synthetic ETA');
  if (!eta.trafficAware) quality.push('not traffic-aware');
  if (fresh.freshness === 'STALE') quality.push('route calculation stale');
  if (originFresh && originFresh.freshness !== 'FRESH') quality.push(`ambulance position ${originFresh.freshness === 'STALE' ? 'stale' : 'time unknown'}`);
  const refs: EvidenceRef[] = [{
    snapshotId: ctx.snapshot.snapshotId,
    path: `transport.etaByHospital.${h.hospitalId}`,
    evidenceClass: 'ROUTE_ETA',
    source: eta.provider,
    dataStatus: eta.synthetic ? 'SYNTHETIC_DEMO' : 'CURRENT',
    observedAt: eta.calculatedAt,
    ageSeconds: fresh.ageSeconds,
    freshness: fresh.freshness,
  }];
  return {
    factorId: 'SF-ETA', affectsOrdering: true, level: 'ESTIMATED',
    summary: `ETA ${Math.ceil(eta.durationSeconds / 60)} min, ${(eta.distanceMeters / 1000).toFixed(1)} km via ${eta.provider}${quality.length ? ` (${quality.join(', ')})` : ''}.`,
    value: {
      durationSeconds: eta.durationSeconds,
      distanceMeters: eta.distanceMeters,
      provider: eta.provider,
      synthetic: eta.synthetic,
      trafficAware: eta.trafficAware,
    },
    evidenceRefs: refs,
  };
}

export function factorAcceptanceKind(ctx: RuleContext, h: HospitalInput): FactorResult {
  const a = currentAccepting(ctx, h);
  if (!a) {
    return { factorId: 'SF-ACC-KIND', affectsOrdering: true, level: 'UNKNOWN', summary: 'No current acceptance.', evidenceRefs: [] };
  }
  const r = a.response;
  const now = Date.parse(ctx.snapshot.evaluatedAt);
  const marginSeconds = Math.max(0, Math.floor((Date.parse(r.validUntil) - now) / 1000));
  // No hospital-supplied free text (limitations content) leaves the engine: only a count.
  return {
    factorId: 'SF-ACC-KIND', affectsOrdering: true, level: 'KNOWN',
    summary: `${r.status}${r.limitations.length ? ` with ${r.limitations.length} limitation(s) stated` : ''}; expires in ${Math.floor(marginSeconds / 60)} min.`,
    value: { status: r.status, limitationsCount: r.limitations.length, validityMarginSeconds: marginSeconds, source: r.trustedSource ?? 'UNVERIFIED' },
    evidenceRefs: [a.ref],
  };
}

// ------------------------------------------------------------------ financial (advisory only)

function levelFor(ev: EvidenceRecord<unknown>, ctx: RuleContext, estimate: boolean): KnowledgeLevel {
  if (ev.dataStatus === 'NOT_DISCLOSED') return 'NOT_DISCLOSED';
  if (ev.dataStatus === 'UNKNOWN') return 'UNKNOWN';
  const fresh = assessFreshness('FINANCIAL', ev, ctx.snapshot.evaluatedAt, ctx.policy);
  if (fresh.freshness !== 'FRESH') return 'UNKNOWN';
  return estimate ? 'ESTIMATED' : 'KNOWN';
}

export function factorFinancial(ctx: RuleContext, h: HospitalInput): FactorResult {
  const fp = h.financialProfile;
  if (!fp) {
    return {
      factorId: 'SF-FIN-EXPOSURE', affectsOrdering: false, level: 'UNKNOWN', reasonCode: 'NO_FINANCIAL_EVIDENCE',
      summary: 'No financial evidence for this facility. Patient cost is unknown.', evidenceRefs: [],
    };
  }
  const value: FactorResult['value'] = {};
  const parts: string[] = [];
  const pricingLevel = levelFor(fp.pricingCategory, ctx, false);
  value.pricingCategory = pricingLevel === 'KNOWN' ? fp.pricingCategory.value : 'UNKNOWN';
  parts.push(`pricing category ${value.pricingCategory}`);

  const depLevel = levelFor(fp.depositPolicy.depositRequired, ctx, false);
  value.depositRequired = depLevel === 'KNOWN' ? fp.depositPolicy.depositRequired.value : null;
  parts.push(`deposit ${depLevel === 'KNOWN' ? (fp.depositPolicy.depositRequired.value ? 'required' : 'not required') : 'unknown'}`);
  if (levelFor(fp.depositPolicy.statutoryWaiverApplies, ctx, false) === 'KNOWN' && fp.depositPolicy.statutoryWaiverApplies.value) {
    parts.push('statutory emergency stabilization waiver applies');
    value.statutoryWaiverApplies = true;
  }

  let level: KnowledgeLevel = 'UNKNOWN';
  const code = ctx.snapshot.case.procedureCode;
  const proc = code ? fp.standardEmergencyProcedures.find(p => p.procedureCode === code) : undefined;
  if (proc) {
    level = levelFor(proc.estimatedCost, ctx, true);
    if (level === 'ESTIMATED') {
      // Range only. The median is never presented as what the patient will pay.
      value.estimatedMinInr = proc.estimatedCost.value.minInr;
      value.estimatedMaxInr = proc.estimatedCost.value.maxInr;
      parts.push(`estimated liability ₹${proc.estimatedCost.value.minInr}–₹${proc.estimatedCost.value.maxInr} (confidence ${proc.estimatedCost.confidence})`);
    }
  } else {
    parts.push(code ? `no estimate for procedure ${code}` : 'no procedure code supplied; cost not estimated');
  }
  if (fp.priceTransparencyStatus.value === 'NOT_DISCLOSED' && level === 'UNKNOWN') level = 'NOT_DISCLOSED';

  // Exposure risk only when both a patient budget and an estimated range exist.
  const budget = ctx.snapshot.case.financialContext?.selfReportedBudgetConstraintInr;
  if (budget !== undefined && value.estimatedMinInr !== undefined && value.estimatedMaxInr !== undefined) {
    const min = value.estimatedMinInr as number;
    const max = value.estimatedMaxInr as number;
    value.exposureRisk = max <= budget ? 'LOW' : min <= budget ? 'MODERATE' : 'HIGH';
  } else {
    value.exposureRisk = 'UNKNOWN';
  }
  return {
    factorId: 'SF-FIN-EXPOSURE', affectsOrdering: false, level,
    summary: parts.join('; ') + '. Advisory only; never blocks emergency care.', value, evidenceRefs: [],
  };
}

// ------------------------------------------------------------------ insurance (advisory only)

export function factorInsurance(ctx: RuleContext, h: HospitalInput): FactorResult {
  const ip = h.insuranceProfile;
  const patient = ctx.snapshot.case.insuranceProfile;
  const base = { factorId: 'SF-INS-COMPAT', affectsOrdering: false, evidenceRefs: [] as EvidenceRef[] };
  if (!ip) {
    return { ...base, level: 'UNKNOWN', reasonCode: 'NO_INSURANCE_EVIDENCE',
      summary: 'INSURANCE_COMPATIBILITY = UNKNOWN: no insurance evidence for this facility.', value: { compatibility: 'UNKNOWN' } };
  }
  if (!patient || patient.payerType === 'UNKNOWN') {
    return { ...base, level: 'UNKNOWN', reasonCode: 'NO_PATIENT_INSURANCE',
      summary: 'INSURANCE_COMPATIBILITY = UNKNOWN: patient policy not known.', value: { compatibility: 'UNKNOWN' } };
  }
  const known = (ev: EvidenceRecord<boolean>) =>
    ev.dataStatus !== 'UNKNOWN' && ev.dataStatus !== 'NOT_DISCLOSED' &&
    assessFreshness('INSURANCE', ev, ctx.snapshot.evaluatedAt, ctx.policy).freshness === 'FRESH';

  let empanelled: boolean | null = null;
  let excluded: boolean | null = null;
  let deskNow: boolean | null = known(ip.emergencyCashlessDeskAvailable) ? ip.emergencyCashlessDeskAvailable.value : null;
  if (patient.payerType === 'GOVERNMENT_SCHEME' && patient.schemeId) {
    const s = ip.governmentSchemes.find(g => g.schemeId === patient.schemeId);
    empanelled = s ? (known(s.isEmpanelled) ? s.isEmpanelled.value : null) : null;
    excluded = null; // scheme specialty coverage needs a specialty<->capability map that does not exist yet
  } else if (patient.tpaId) {
    const t = ip.tpaNetworks.find(n => n.tpaId === patient.tpaId);
    empanelled = t ? (known(t.isCashlessSupported) ? t.isCashlessSupported.value : null) : null;
    if (t && known(t.deskOperational24x7)) deskNow = deskNow ?? t.deskOperational24x7.value;
    const code = ctx.snapshot.case.procedureCode;
    const ex = t?.excludedProcedures;
    excluded = code && ex && ex.dataStatus !== 'UNKNOWN' && ex.dataStatus !== 'NOT_DISCLOSED' ? ex.value.includes(code) : null;
  }
  let compatibility: 'COMPATIBLE_EVIDENCED' | 'INCOMPATIBLE_EVIDENCED' | 'UNKNOWN' = 'UNKNOWN';
  if (empanelled === false) compatibility = 'INCOMPATIBLE_EVIDENCED';
  else if (empanelled === true && deskNow === true && excluded === false) compatibility = 'COMPATIBLE_EVIDENCED';
  return {
    ...base,
    level: compatibility === 'UNKNOWN' ? 'UNKNOWN' : 'KNOWN',
    summary: `INSURANCE_COMPATIBILITY = ${compatibility} (network: ${empanelled ?? 'unknown'}, cashless desk now: ${deskNow ?? 'unknown'}, exclusions: ${excluded ?? 'unknown'}). Empanelment is not coverage. Advisory only.`,
    value: { compatibility, empanelled, cashlessDeskAvailable: deskNow, procedureExcluded: excluded },
  };
}
