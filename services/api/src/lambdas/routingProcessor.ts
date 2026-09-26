import { EventBridgeEvent } from 'aws-lambda';
import { DynamoStateStore } from '../infrastructure/stateStore/DynamoStateStore';
import { MetricsCollector } from '../infrastructure/observability/metrics';

const TABLE_NAME = process.env.DYNAMO_TABLE_NAME || 'jiva-operational-mesh';
const REGION = process.env.AWS_REGION || 'ap-south-1';
const stateStore = new DynamoStateStore({ tableName: TABLE_NAME, region: REGION });
const metrics = new MetricsCollector(true, REGION);

export const handler = async (event: EventBridgeEvent<string, any>) => {
  const jivaEvent = event.detail;
  console.log(`[Lambda:RoutingProcessor] Processing ${event['detail-type']} (${jivaEvent.eventId})`);

  const recordResult = await stateStore.recordEvent(jivaEvent);
  if (recordResult.isDuplicate) {
    return { status: 'duplicate_skipped' };
  }

  if (jivaEvent.eventType === 'route.recalculated' || jivaEvent.eventType === 'route.calculated') {
    await metrics.record('ROUTE_CALCULATION_LATENCY', 150, 'Milliseconds');
    await metrics.record('JIVA_EVENTS_PROCESSED', 1, 'Count', { EventType: jivaEvent.eventType });
  }

  return { status: 'processed' };
};
