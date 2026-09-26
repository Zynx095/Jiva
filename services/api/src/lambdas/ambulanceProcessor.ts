import { EventBridgeEvent } from 'aws-lambda';
import { DynamoStateStore } from '../infrastructure/stateStore/DynamoStateStore';

const TABLE_NAME = process.env.DYNAMO_TABLE_NAME || 'jiva-operational-mesh';
const REGION = process.env.AWS_REGION || 'ap-south-1';
const stateStore = new DynamoStateStore({ tableName: TABLE_NAME, region: REGION });

export const handler = async (event: EventBridgeEvent<string, any>) => {
  const jivaEvent = event.detail;
  console.log(`[Lambda:AmbulanceProcessor] Processing ${event['detail-type']} (${jivaEvent.eventId})`);

  const recordResult = await stateStore.recordEvent(jivaEvent);
  if (recordResult.isDuplicate) {
    return { status: 'duplicate_skipped' };
  }

  if (jivaEvent.eventType === 'ambulance.dispatched') {
    const { ambulanceId, caseId } = jivaEvent.payload;
    const existing = await stateStore.getAmbulance(ambulanceId);

    if (existing) {
      await stateStore.setAmbulance({
        ...existing,
        status: 'DISPATCHED',
        assignedPatient: caseId || existing.assignedPatient,
        lastUpdated: new Date().toISOString(),
        provenance: [...existing.provenance, {
          sourceType: jivaEvent.source.type,
          sourceId: jivaEvent.source.id,
          eventId: jivaEvent.eventId,
          timestamp: jivaEvent.timestamp,
          confidence: jivaEvent.metadata?.confidence || 1.0,
        }],
      });
    }
  } else if (jivaEvent.eventType === 'ambulance.location.updated') {
    const { ambulanceId, coordinates, heading, speedKmh } = jivaEvent.payload;
    const existing = await stateStore.getAmbulance(ambulanceId);

    if (existing) {
      await stateStore.setAmbulance({
        ...existing,
        currentLocation: coordinates,
        heading,
        speedKmh,
        lastUpdated: new Date().toISOString(),
      });
    }
  }

  return { status: 'processed' };
};
