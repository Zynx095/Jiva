import { AnyEvent } from '@jiva/event-schema';

export type EventHandler = (event: any) => void | Promise<void>;

export interface IEventBus {
  /**
   * Publish an event to the bus
   */
  publish(event: AnyEvent): Promise<void>;

  /**
   * Subscribe to specific event types, or '*' for all events
   */
  on(eventType: string, handler: EventHandler): void;

  /**
   * Unsubscribe from an event type
   */
  off(eventType: string, handler: EventHandler): void;

  /**
   * Check health of the event bus adapter
   */
  isHealthy(): Promise<boolean>;

  /**
   * Get provider name for diagnostics
   */
  getProviderName(): string;
}
