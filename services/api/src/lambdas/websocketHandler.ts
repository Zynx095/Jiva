import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import type { AuthContext } from '@jiva/auth';
import type { AnyEvent } from '@jiva/event-schema';
import { authenticateRequest } from '../authVerification';
import { canReceiveEvent, eventForRecipient } from '../authorization';

const TABLE_NAME = process.env.DYNAMO_TABLE_NAME || 'jiva-operational-mesh';
const REGION = process.env.AWS_REGION || 'ap-south-1';

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

/**
 * Realtime fan-out on AWS, with the SAME per-principal rules as the local Socket.IO server.
 *
 * Previously every event was posted to every connection (recorded as a pre-existing issue in Phase 0).
 * Now: the principal is verified once at $connect (a Cognito JWT, sent as `?token=` because browsers
 * cannot set headers on WebSockets; unsigned claims and, in production, demo personas are refused by
 * authenticateRequest) and stored with the connection — never the token. Each event is then delivered
 * only to connections whose principal may receive it (canReceiveEvent), in that principal's copy
 * (eventForRecipient). A connection without a verified principal receives nothing (fail closed). Where
 * a rule needs state this function does not hold (e.g. which case a crew is on), it also fails closed.
 */
export interface StoredPrincipal {
  userId: string;
  role: AuthContext['role'];
  hospitalId?: string;
  ambulanceId?: string;
  caseId?: string;
  practitionerId?: string;
  isDemo?: boolean;
}

export interface ConnectionRecord {
  connectionId: string;
  principal?: StoredPrincipal;
}

export function toStoredPrincipal(auth: AuthContext): StoredPrincipal {
  return {
    userId: auth.userId,
    role: auth.role,
    ...(auth.hospitalId ? { hospitalId: auth.hospitalId } : {}),
    ...(auth.ambulanceId ? { ambulanceId: auth.ambulanceId } : {}),
    ...(auth.caseId ? { caseId: auth.caseId } : {}),
    ...(auth.practitionerId ? { practitionerId: auth.practitionerId } : {}),
    ...(auth.isDemo ? { isDemo: true } : {}),
  };
}

/** Verify the principal of a $connect request; undefined when there is none. */
export async function principalFromConnect(event: { headers?: Record<string, string | undefined>; queryStringParameters?: Record<string, string | undefined> | null }): Promise<StoredPrincipal | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) headers[k.toLowerCase()] = v;
  const token = event.queryStringParameters?.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const auth = await authenticateRequest(headers);
  return auth ? toStoredPrincipal(auth) : undefined;
}

/** Which connections receive this event, and in which copy. Fail closed. */
export function deliveriesFor(connections: ConnectionRecord[], event: AnyEvent): Array<{ connectionId: string; data: string }> {
  const out: Array<{ connectionId: string; data: string }> = [];
  for (const c of connections) {
    if (!c.principal) continue;
    const auth = c.principal as AuthContext;
    if (!canReceiveEvent(auth, event)) continue;
    out.push({ connectionId: c.connectionId, data: JSON.stringify({ type: 'event', data: eventForRecipient(auth, event) }) });
  }
  return out;
}

export const handler = async (event: any) => {
  const { eventType, connectionId } = event.requestContext || {};

  // 1. WebSocket Connect
  if (eventType === 'CONNECT') {
    const principal = await principalFromConnect(event).catch(() => undefined);
    console.log(`[WebSocket:Connect] ${connectionId} connected (${principal ? principal.role : 'no verified principal: receives nothing'})`);
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `WS_CONN#${connectionId}`,
        SK: 'CONNECTION',
        EntityType: 'WS_CONNECTION',
        connectionId,
        ...(principal ? { principal } : {}),
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

  // 3. EventBridge Broadcast Trigger (an EventBridge rule forwards each event; delivered per principal)
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

    const connections = (connectionsRes.Items || []).map((c: any) => ({ connectionId: String(c.connectionId), principal: c.principal as StoredPrincipal | undefined }));
    const deliveries = deliveriesFor(connections, event.detail as AnyEvent);

    await Promise.allSettled(
      deliveries.map(async (d) => {
        try {
          await apigw.send(new PostToConnectionCommand({
            ConnectionId: d.connectionId,
            Data: Buffer.from(d.data),
          }));
        } catch (err: any) {
          if (err.statusCode === 410 || err.name === 'GoneException') {
            await docClient.send(new DeleteCommand({
              TableName: TABLE_NAME,
              Key: { PK: `WS_CONN#${d.connectionId}`, SK: 'CONNECTION' },
            }));
          }
        }
      })
    );
  }

  return { statusCode: 200, body: 'OK' };
};
