import { DynamoStateStore } from '../../infrastructure/stateStore/DynamoStateStore';
import { AwsEventBridgeBus } from '../../infrastructure/eventBus/AwsEventBridgeBus';
import { createMappingProvider } from '@jiva/mapping';
import { feasibilityMode } from '../../feasibility/shadow';
import { createStoreBackedShadow, LambdaDeps } from './deps';

const TABLE_NAME = process.env.DYNAMO_TABLE_NAME || 'jiva-operational-mesh';
const BUS_NAME = process.env.EVENT_BUS_NAME || 'jiva-healthcare-mesh';
const REGION = process.env.AWS_REGION || 'ap-south-1';

export const awsStore = () => new DynamoStateStore({ tableName: TABLE_NAME, region: REGION });

/**
 * Production wiring for the lambda cores. The Care Feasibility Engine runs in SHADOW only
 * (FEASIBILITY_ENGINE=off disables it); it never controls a decision in any environment.
 */
export function createAwsDeps(): LambdaDeps {
  const store = awsStore();
  const bus = new AwsEventBridgeBus({ eventBusName: BUS_NAME, region: REGION });
  const mapping = createMappingProvider();
  const shadow = feasibilityMode() === 'shadow' ? createStoreBackedShadow({ store, bus, mapping }) : undefined;
  return { store, bus, mapping, shadow };
}
