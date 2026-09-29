import { eventBus } from '../eventBus';
import { hospitalsStore } from '../stateStore';
import { mappingProvider } from '../mapping';
import { acceptanceLedger } from './acceptanceLedger';
import { FeasibilityShadow } from './shadow';
import {
  DecisionAuthority,
  authorityKillSwitch,
  AuthorityCircuitBreaker,
  DecisionAuthorityMetrics,
} from './authority';

export { acceptanceLedger } from './acceptanceLedger';
export { feasibilityMode, toLegacyEligibility } from './shadow';
export * from './authority';

/**
 * Process-wide shadow runner (local mode). Never controls routing decisions. The trace event is
 * published to the local bus purely as audit telemetry: no engine subscribes to it.
 */
export const feasibilityShadow = new FeasibilityShadow({
  hospitals: () => hospitalsStore.values(),
  ledger: acceptanceLedger,
  mapping: mappingProvider,
  publishTrace: event => eventBus.publish(event),
});

/**
 * Process-wide Decision Authority gate (local mode).
 * Configured authority mode defaults strictly to safe SHADOW mode.
 * Legacy path remains authoritative.
 */
export const decisionAuthority = new DecisionAuthority({
  shadow: feasibilityShadow,
  killSwitch: authorityKillSwitch,
  circuitBreaker: new AuthorityCircuitBreaker(),
  metrics: new DecisionAuthorityMetrics(),
});
