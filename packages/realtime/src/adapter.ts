import { AnyEvent } from '@jiva/event-schema';

export interface IRealtimeAdapter {
  /**
   * Broadcast an event to all connected clients
   */
  broadcast(event: AnyEvent): Promise<void>;

  /**
   * Broadcast an event to a scoped channel (e.g. `hospital:HOSP-BLR-001`, `case:CASE-BLR-876`)
   */
  emitToChannel(channel: string, event: AnyEvent): Promise<void>;

  /**
   * Get count of currently connected clients
   */
  getConnectionCount(): number | Promise<number>;

  /**
   * Check connection health
   */
  isHealthy(): boolean | Promise<boolean>;
}
