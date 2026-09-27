import { eventBus } from '../eventBus';
import { hospitalsStore } from '../stateStore';
import { mappingProvider } from '../mapping';
import { acceptanceLedger } from './acceptanceLedger';
import { FeasibilityShadow } from './shadow';

export { acceptanceLedger } from './acceptanceLedger';
export { feasibilityMode, toLegacyEligibility } from './shadow';

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
