import { EventBridgeClient, PutEventsCommand, DescribeEventBusCommand } from '@aws-sdk/client-eventbridge';
import { EventEmitter } from 'events';
import { AnyEvent } from '@jiva/event-schema';
import { IEventBus, EventHandler } from './types';

export interface AwsEventBridgeBusOptions {
  eventBusName: string;
  region: string;
  source?: string;
}

export class AwsEventBridgeBus implements IEventBus {
  private client: EventBridgeClient;
  private eventBusName: string;
  private source: string;
  private localEmitter = new EventEmitter();

  constructor(options: AwsEventBridgeBusOptions) {
    this.eventBusName = options.eventBusName;
    this.source = options.source || 'jiva.healthcare';
    this.client = new EventBridgeClient({ region: options.region });
    this.localEmitter.setMaxListeners(100);
  }

  async publish(event: AnyEvent): Promise<void> {
    const correlationId = (event as any).correlationId || (event as any).payload?.caseId || (event as any).patientId || event.eventId;
    const causationId = (event as any).causationId || event.eventId;

    // Preserving event identity
    const enrichedEvent = {
      ...event,
      correlationId,
      causationId,
    };

    console.log(`[AwsEventBridgeBus] Sending ${event.eventType} to EventBridge bus '${this.eventBusName}'`);

    const command = new PutEventsCommand({
      Entries: [
        {
          EventBusName: this.eventBusName,
          Source: this.source,
          DetailType: event.eventType,
          Time: new Date(event.timestamp),
          Detail: JSON.stringify(enrichedEvent),
          Resources: [correlationId],
        },
      ],
    });

    try {
      const response = await this.client.send(command);
      if (response.FailedEntryCount && response.FailedEntryCount > 0) {
        const error = response.Entries?.[0]?.ErrorMessage || 'EventBridge entry submission failed';
        console.error(`[AwsEventBridgeBus] Failed to publish event: ${error}`);
        throw new Error(error);
      }
    } catch (err) {
      console.error(`[AwsEventBridgeBus] Network/IAM error sending to EventBridge:`, err);
      // For failure resilience in demo/testing, still notify local listeners
      throw err;
    } finally {
      // Local listeners (for in-process engines and local WebSocket broadcasting)
      this.localEmitter.emit(event.eventType, enrichedEvent);
      this.localEmitter.emit('*', enrichedEvent);
    }
  }

  on(eventType: string, handler: EventHandler): void {
    this.localEmitter.on(eventType, handler);
  }

  off(eventType: string, handler: EventHandler): void {
    this.localEmitter.off(eventType, handler);
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.client.send(new DescribeEventBusCommand({ Name: this.eventBusName }));
      return true;
    } catch {
      return false;
    }
  }

  getProviderName(): string {
    return 'AwsEventBridgeBus';
  }
}
