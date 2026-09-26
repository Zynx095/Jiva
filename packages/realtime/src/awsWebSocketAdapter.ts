import { AnyEvent } from '@jiva/event-schema';
import { IRealtimeAdapter } from './adapter';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

export interface ConnectionStore {
  listConnections(): Promise<string[]>;
  removeConnection(connectionId: string): Promise<void>;
  listChannelConnections?(channel: string): Promise<string[]>;
}

export class AwsWebSocketAdapter implements IRealtimeAdapter {
  private client: ApiGatewayManagementApiClient;
  private connectionStore: ConnectionStore;

  constructor(endpoint: string, connectionStore: ConnectionStore, region: string = 'ap-south-1') {
    this.client = new ApiGatewayManagementApiClient({
      endpoint,
      region,
    });
    this.connectionStore = connectionStore;
  }

  async broadcast(event: AnyEvent): Promise<void> {
    const connectionIds = await this.connectionStore.listConnections();
    const data = Buffer.from(JSON.stringify({ type: 'event', data: event }));

    const postPromises = connectionIds.map(async (connectionId) => {
      try {
        await this.client.send(new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: data,
        }));
      } catch (err: any) {
        if (err.statusCode === 410 || err.name === 'GoneException') {
          // Connection stale, cleanup
          await this.connectionStore.removeConnection(connectionId);
        } else {
          console.error(`[AwsWebSocket] Error posting to connection ${connectionId}:`, err);
        }
      }
    });

    await Promise.allSettled(postPromises);
  }

  async emitToChannel(channel: string, event: AnyEvent): Promise<void> {
    if (this.connectionStore.listChannelConnections) {
      const channelConnections = await this.connectionStore.listChannelConnections(channel);
      const data = Buffer.from(JSON.stringify({ type: 'event', channel, data: event }));

      const postPromises = channelConnections.map(async (connectionId) => {
        try {
          await this.client.send(new PostToConnectionCommand({
            ConnectionId: connectionId,
            Data: data,
          }));
        } catch (err: any) {
          if (err.statusCode === 410 || err.name === 'GoneException') {
            await this.connectionStore.removeConnection(connectionId);
          }
        }
      });

      await Promise.allSettled(postPromises);
    } else {
      // Fallback to broadcast
      await this.broadcast(event);
    }
  }

  async getConnectionCount(): Promise<number> {
    const connections = await this.connectionStore.listConnections();
    return connections.length;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }
}
