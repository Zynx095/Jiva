import { AnyEvent } from '@jiva/event-schema';
import { IRealtimeAdapter } from './adapter';

export class LocalSocketIoAdapter implements IRealtimeAdapter {
  private io: any;

  constructor(ioInstance?: any) {
    this.io = ioInstance;
  }

  setIo(ioInstance: any) {
    this.io = ioInstance;
  }

  async broadcast(event: AnyEvent): Promise<void> {
    if (this.io) {
      this.io.emit('event', event);
    }
  }

  async emitToChannel(channel: string, event: AnyEvent): Promise<void> {
    if (this.io) {
      this.io.to(channel).emit('event', event);
    }
  }

  getConnectionCount(): number {
    if (!this.io || !this.io.sockets || !this.io.sockets.sockets) return 0;
    return this.io.sockets.sockets.size || 0;
  }

  isHealthy(): boolean {
    return !!this.io;
  }
}
