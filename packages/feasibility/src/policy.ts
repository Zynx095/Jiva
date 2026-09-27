import type { EvidenceClass, FreshnessState } from '@jiva/domain-models';
import { canonicalJson, sha256 } from './canonical';

/**
 * Evidence environment. DEMO: SYNTHETIC_DEMO evidence may support simulation. PRODUCTION: it can
 * never satisfy an operational rule. Resolved by the service layer (never by the pure package, and
 * never from client input) and carried inside the policy so it is bound into every hash.
 */
export type EvidenceEnvironment = 'DEMO' | 'PRODUCTION';

/**
 * Per-evidence-class freshness rule.
 * `maxAgeSeconds` applies ONLY when the evidence carries no explicit `validUntil`.
 * An explicit `validUntil` always takes precedence over the class default.
 */
export interface FreshnessRule {
  /** null = no age limit (still subject to an explicit validUntil). */
  maxAgeSeconds: number | null;
  /**
   * What staleness means for rules that read this class:
   *  - 'UNKNOWN': stale evidence loses the ability to assert anything (PASS or FAIL) -> UNKNOWN.
   *  - 'WARN': evidence remains usable but is flagged (static facts such as listed capability).
   */
  onStale: 'UNKNOWN' | 'WARN';
  note: string;
}

export interface FreshnessPolicy {
  version: string;
  label: string;
  evidenceEnvironment: EvidenceEnvironment;
  rules: Record<EvidenceClass, FreshnessRule>;
}

const MIN = 60;
const DAY = 24 * 60 * MIN;

/**
 * CONFIGURABLE PROTOTYPE DEFAULTS.
 * These durations are engineering placeholders chosen for the demo. They are NOT clinical or
 * operational guarantees and have not been validated by clinical operations. Override them
 * with createFreshnessPolicy() (the API reads FEASIBILITY_POLICY_OVERRIDES).
 */
export const PROTOTYPE_FRESHNESS_POLICY: FreshnessPolicy = {
  version: 'prototype-defaults-2026-09-27',
  label: 'Configurable prototype defaults — not clinical guarantees',
  evidenceEnvironment: 'DEMO',
  rules: {
    FACILITY_LOCATION: { maxAgeSeconds: null, onStale: 'WARN', note: 'Static fact.' },
    LISTED_CAPABILITY: {
      maxAgeSeconds: 365 * DAY,
      onStale: 'WARN',
      note: 'Public listing says the facility offers a service; never a claim about current readiness.',
    },
    OPERATIONAL_CAPACITY: {
      maxAgeSeconds: 30 * MIN,
      onStale: 'UNKNOWN',
      note: 'Prototype default. Expired capacity status becomes UNKNOWN (never the opposite state).',
    },
    ACCEPTANCE_RESPONSE: {
      maxAgeSeconds: 60 * MIN,
      onStale: 'UNKNOWN',
      note: 'Prototype default, used only if a response lacks validUntil (the protocol requires it).',
    },
    AMBULANCE_POSITION: { maxAgeSeconds: 2 * MIN, onStale: 'WARN', note: 'Stale origin flags ETA quality.' },
    ROUTE_ETA: { maxAgeSeconds: 5 * MIN, onStale: 'WARN', note: 'ETA quality flag only.' },
    FINANCIAL: { maxAgeSeconds: 180 * DAY, onStale: 'UNKNOWN', note: 'Prototype default.' },
    INSURANCE: { maxAgeSeconds: 90 * DAY, onStale: 'UNKNOWN', note: 'Prototype default.' },
  },
};

export function createFreshnessPolicy(
  overrides: Partial<Record<EvidenceClass, Partial<FreshnessRule>>> = {},
  version?: string,
  options: { environment?: EvidenceEnvironment } = {}
): FreshnessPolicy {
  const rules = { ...PROTOTYPE_FRESHNESS_POLICY.rules };
  let changed = false;
  for (const [cls, o] of Object.entries(overrides) as [EvidenceClass, Partial<FreshnessRule>][]) {
    if (!rules[cls] || !o) continue;
    rules[cls] = { ...rules[cls], ...o };
    changed = true;
  }
  return {
    version: version || (changed ? `${PROTOTYPE_FRESHNESS_POLICY.version}+overrides` : PROTOTYPE_FRESHNESS_POLICY.version),
    label: PROTOTYPE_FRESHNESS_POLICY.label,
    evidenceEnvironment: options.environment ?? PROTOTYPE_FRESHNESS_POLICY.evidenceEnvironment,
    rules,
  };
}

/**
 * Cryptographic identity of the EFFECTIVE policy: canonical JSON of the version, evidence
 * environment and every rule. Two policies that differ in any rule or in the environment can never
 * share a hash, whatever their `version` string says. Bound into the snapshot hash and audit hash.
 */
export function hashPolicy(policy: FreshnessPolicy): string {
  const rules = Object.fromEntries(
    Object.keys(policy.rules).sort().map(k => {
      const r = policy.rules[k as EvidenceClass];
      return [k, { maxAgeSeconds: r.maxAgeSeconds, onStale: r.onStale }];
    })
  );
  return sha256(canonicalJson({ version: policy.version, evidenceEnvironment: policy.evidenceEnvironment, rules }));
}

export interface FreshnessAssessment {
  freshness: FreshnessState;
  ageSeconds?: number;
  /** The expiry actually applied (validUntil if present, else observedAt + maxAge). */
  effectiveExpiry?: string;
  expirySource: 'VALID_UNTIL' | 'POLICY_MAX_AGE' | 'NONE';
}

const parse = (iso?: string): number => (iso ? Date.parse(iso) : NaN);

/**
 * Pure freshness assessment against the snapshot clock. Boundary: evidence is STALE when
 * evaluatedAt >= expiry (a response valid "until" T is no longer valid at T).
 */
export function assessFreshness(
  cls: EvidenceClass,
  evidence: { observedAt?: string; validUntil?: string },
  evaluatedAt: string,
  policy: FreshnessPolicy
): FreshnessAssessment {
  const now = parse(evaluatedAt);
  const observed = parse(evidence.observedAt);
  const validUntil = parse(evidence.validUntil);
  const ageSeconds = Number.isFinite(observed) ? Math.max(0, Math.floor((now - observed) / 1000)) : undefined;

  if (Number.isFinite(validUntil)) {
    if (Number.isFinite(observed) && observed > now) {
      // Observed in the future relative to the snapshot: cannot be current evidence yet.
      return { freshness: 'UNTIMED', ageSeconds, effectiveExpiry: evidence.validUntil, expirySource: 'VALID_UNTIL' };
    }
    return {
      freshness: now >= validUntil ? 'STALE' : 'FRESH',
      ageSeconds,
      effectiveExpiry: new Date(validUntil).toISOString(),
      expirySource: 'VALID_UNTIL',
    };
  }
  if (!Number.isFinite(observed) || observed > now) {
    return { freshness: 'UNTIMED', ageSeconds, expirySource: 'NONE' };
  }
  const maxAge = policy.rules[cls].maxAgeSeconds;
  if (maxAge === null) return { freshness: 'FRESH', ageSeconds, expirySource: 'NONE' };
  const expiry = observed + maxAge * 1000;
  return {
    freshness: now >= expiry ? 'STALE' : 'FRESH',
    ageSeconds,
    effectiveExpiry: new Date(expiry).toISOString(),
    expirySource: 'POLICY_MAX_AGE',
  };
}
