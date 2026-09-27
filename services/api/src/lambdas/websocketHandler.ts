import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

const TABLE_NAME = process.env.DYNAMO_TABLE_NAME || 'jiva-operational-mesh';
const REGION = process.env.AWS_REGION || 'ap-south-1';

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

export const handler = async (event: any) => {
  const { eventType, connectionId } = event.requestContext || {};

  // 1. WebSocket Connect
  if (eventType === 'CONNECT') {
    console.log(`[WebSocket:Connect] Client connected: ${connectionId}`);
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `WS_CONN#${connectionId}`,
        SK: 'CONNECTION',
        EntityType: 'WS_CONNECTION',
        connectionId,
        connectedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + (24 * 3600), // 24hr auto-cleanup
      },
    }));
    return { statusCode: 200, body: 'Connected' };
  }

  // 2. WebSocket Disconnect
  if (eventType === 'DISCONNECT') {
    console.log(`[WebSocket:Disconnect] Client disconnected: ${connectionId}`);
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `WS_CONN#${connectionId}`,
        SK: 'CONNECTION',
      },
    }));
    return { statusCode: 200, body: 'Disconnected' };
  }

  // 3. EventBridge Broadcast Trigger (when called from an EventBridge rule to broadcast to all connected WebSockets)
  if (event.detail && event['detail-type']) {
    // Defense in depth: feasibility trace events are privileged audit telemetry, never broadcast.
    if (event['detail-type'] === 'feasibility.trace.recorded') return { statusCode: 200, body: 'Skipped' };
    const endpoint = process.env.WEBSOCKET_ENDPOINT;
    if (!endpoint) return { statusCode: 200 };

    const apigw = new ApiGatewayManagementApiClient({ endpoint, region: REGION });

    const connectionsRes = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'EntityType = :type',
      ExpressionAttributeValues: { ':type': 'WS_CONNECTION' },
    }));

    const connections = connectionsRes.Items || [];
    const payload = Buffer.from(JSON.stringify({ type: 'event', data: event.detail }));

    await Promise.allSettled(
      connections.map(async (c: any) => {
        try {
          await apigw.send(new PostToConnectionCommand({
            ConnectionId: c.connectionId,
            Data: payload,
          }));
        } catch (err: any) {
          if (err.statusCode === 410 || err.name === 'GoneException') {
            await docClient.send(new DeleteCommand({
              TableName: TABLE_NAME,
              Key: { PK: `WS_CONN#${c.connectionId}`, SK: 'CONNECTION' },
            }));
          }
        }
      })
    );
  }

  return { statusCode: 200, body: 'OK' };
};
