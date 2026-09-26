import { EventEmitter } from 'events';
import { AnyEvent } from '@jiva/event-schema';
import { IEventBus, EventHandler } from './types';

/**
 * In-process event bus. Every subscriber is isolated: a handler that throws
 * (synchronously or via a rejected promise) is logged and never takes down
 * the process or prevents other subscribers from running.
 */
export class LocalEventBus implements IEventBus {
  private emitter = new EventEmitter();
  private wrapped = new Map<EventHandler, (event: AnyEvent) => void>();
  private failures = 0;

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  async publish(event: AnyEvent): Promise<void> {
    const correlationId = (event as any).correlationId || (event as any).payload?.caseId || (event as any).patientId || 'N/A';
    console.log(`[LocalEventBus] Publishing ${event.eventType} (ID: ${event.eventId}, Corr: ${correlationId})`);

    this.emitter.emit(event.eventType, event);
    this.emitter.emit('*', event);
  }

  on(eventType: string, handler: EventHandler): void {
    const safe = (event: AnyEvent) => {
      const report = (err: unknown) => {
        this.failures++;
        const message = err instanceof Error ? err.message : String(err);
        // Log only identifiers, never payload contents (may contain patient data).
        console.error(`[LocalEventBus] Handler for ${eventType} failed on ${event?.eventType} (${event?.eventId}): ${message}`);
      };
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(report);
        }
      } catch (err) {
        report(err);
      }
    };
    this.wrapped.set(handler, safe);
    this.emitter.on(eventType, safe);
  }

  off(eventType: string, handler: EventHandler): void {
    const safe = this.wrapped.get(handler);
    if (safe) {
      this.emitter.off(eventType, safe);
      this.wrapped.delete(handler);
    }
  }

  getHandlerFailureCount(): number {
    return this.failures;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  getProviderName(): string {
    return 'LocalEventBus';
  }
}
