import { AnyEvent } from '@jiva/event-schema';
import { IEventBus, LocalEventBus, AwsEventBridgeBus } from './infrastructure/eventBus';
import { config } from '@jiva/config';

// Instantiated based on environment
export const eventBus: IEventBus = config.isAws
  ? new AwsEventBridgeBus({
      eventBusName: config.aws.eventBusName,
      region: config.aws.region,
    })
  : new LocalEventBus();

export type { IEventBus };
