import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { awsStore } from './core/awsWiring';
import { createIngestionHandler } from './core/ingestionCore';

const client = new EventBridgeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'jiva-healthcare-mesh';

const core = createIngestionHandler({
  store: awsStore(),
  put: async entry => {
    await client.send(new PutEventsCommand({
      Entries: [{
        EventBusName: EVENT_BUS_NAME,
        Source: 'jiva.healthcare',
        DetailType: entry.detailType,
        Time: entry.time,
        Detail: entry.detail,
        Resources: [entry.resource],
      }],
    }));
  },
});

export const handler = async (event: any) => {
  try {
    return await core(event);
  } catch (err: any) {
    console.error('[Lambda:Ingestion] Error ingesting event:', err);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Internal Server Error' }),
    };
  }
};
