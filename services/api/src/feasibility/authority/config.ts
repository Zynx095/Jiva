import type { AuthorityMode } from './types';

const ALLOWED_MODES = new Set<AuthorityMode>(['LEGACY', 'SHADOW', 'CANARY', 'AUTHORITATIVE']);
const caseOverrides = new Map<string, AuthorityMode>();

/**
 * Resolve the configured Decision Authority Mode.
 *
 * Defaults strictly to 'SHADOW'.
 * Invalid or garbage values always fail safe to 'SHADOW'.
 * Never promotes based on ambiguous environment variables.
 */
export function configuredAuthorityMode(caseId?: string): AuthorityMode {
  if (caseId && caseOverrides.has(caseId)) {
    return caseOverrides.get(caseId)!;
  }

  // Primary configuration: DECISION_AUTHORITY_MODE
  const explicit = (process.env.DECISION_AUTHORITY_MODE || '').trim().toUpperCase();
  if (explicit && ALLOWED_MODES.has(explicit as AuthorityMode)) {
    return explicit as AuthorityMode;
  }
  if (explicit) {
    console.warn(`[DecisionAuthorityConfig] Unknown DECISION_AUTHORITY_MODE="${explicit}"; falling back to safe SHADOW mode.`);
    return 'SHADOW';
  }

  // Fallback to legacy FEASIBILITY_ENGINE variable if present
  const legacyEngine = (process.env.FEASIBILITY_ENGINE || '').trim().toLowerCase();
  if (legacyEngine === 'off') {
    return 'LEGACY';
  }

  return 'SHADOW';
}

/** Set a case-specific authority mode override (for controlled canary tests). */
export function setCaseAuthorityMode(caseId: string, mode: AuthorityMode): void {
  caseOverrides.set(caseId, mode);
}

/** Get the case-specific authority mode override if any. */
export function getCaseAuthorityMode(caseId: string): AuthorityMode | undefined {
  return caseOverrides.get(caseId);
}

/** Clear a case-specific authority mode override. */
export function clearCaseAuthorityMode(caseId: string): void {
  caseOverrides.delete(caseId);
}

/** Clear all case-specific authority overrides. */
export function resetCaseAuthorityOverrides(): void {
  caseOverrides.clear();
}
