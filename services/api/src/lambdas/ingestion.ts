import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const client = new EventBridgeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'jiva-healthcare-mesh';

export const handler = async (event: any) => {
  console.log('[Lambda:Ingestion] Received event:', JSON.stringify(event));

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

    if (!body || !body.eventId || !body.eventType) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Missing eventId or eventType' }),
      };
    }

    const correlationId = body.correlationId || body.payload?.caseId || body.patientId || body.eventId;
    const causationId = body.causationId || body.eventId;

    const enrichedEvent = {
      ...body,
      correlationId,
      causationId,
    };

    await client.send(new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: 'jiva.healthcare',
          DetailType: body.eventType,
          Time: new Date(body.timestamp || Date.now()),
          Detail: JSON.stringify(enrichedEvent),
          Resources: [correlationId],
        },
      ],
    }));

    return {
      statusCode: 202,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'accepted', eventId: body.eventId }),
    };
  } catch (err: any) {
    console.error('[Lambda:Ingestion] Error ingesting event:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message || 'Internal Server Error' }),
    };
  }
};
