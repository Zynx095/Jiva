import { EventBridgeEvent } from 'aws-lambda';
import { DynamoStateStore } from '../infrastructure/stateStore/DynamoStateStore';
import { AwsEventBridgeBus } from '../infrastructure/eventBus/AwsEventBridgeBus';
import { MappingProvider, createMappingProvider } from '@jiva/mapping';
import { calculateBestHospitals } from '../routingEngine';
import { v4 as uuidv4 } from 'uuid';

const TABLE_NAME = process.env.DYNAMO_TABLE_NAME || 'jiva-operational-mesh';
const BUS_NAME = process.env.EVENT_BUS_NAME || 'jiva-healthcare-mesh';
const REGION = process.env.AWS_REGION || 'ap-south-1';

const stateStore = new DynamoStateStore({ tableName: TABLE_NAME, region: REGION });
const eventBus = new AwsEventBridgeBus({ eventBusName: BUS_NAME, region: REGION });

const mappingProvider: MappingProvider = createMappingProvider();

export const handler = async (event: EventBridgeEvent<string, any>) => {
  const jivaEvent = event.detail;
  console.log(`[Lambda:HospitalProcessor] Processing ${event['detail-type']} (${jivaEvent.eventId})`);

  const recordResult = await stateStore.recordEvent(jivaEvent);
  if (recordResult.isDuplicate) {
    console.log(`[Lambda:HospitalProcessor] Skipping duplicate event ${jivaEvent.eventId}`);
    return { status: 'duplicate_skipped' };
  }

  if (jivaEvent.eventType === 'hospital.acceptance.received') {
    const { hospitalId, status, respondedAt, validUntil, source } = jivaEvent.payload;
    const existing = await stateStore.getHospital(hospitalId);

    if (existing) {
      const updatedOperationalState = {
        ...existing.operationalState,
        acceptance: status as any,
        lastConfirmedAt: respondedAt,
        expiresAt: validUntil,
        source: source as any,
      };

      await stateStore.setHospital({
        ...existing,
        operationalState: updatedOperationalState,
        provenance: [...existing.provenance, {
          sourceType: jivaEvent.source.type,
          sourceId: jivaEvent.source.id,
          sourceName: 'Acceptance Protocol',
          retrievedAt: new Date().toISOString(),
          verificationStatus: 'UNKNOWN',
          confidence: 1.0,
        }],
      });

      // Route / Reroute assignment
      const patientId = jivaEvent.payload.caseId;
      const ambulances = await stateStore.listAmbulances();

      if (status === 'ACCEPTED' || status === 'LIMITED') {
        for (const amb of ambulances) {
          if (amb.assignedPatient === patientId && !amb.destinationHospital && amb.currentLocation && existing.location) {
            console.log(`[Lambda:HospitalProcessor] Hospital ${hospitalId} accepted. Assigning ambulance ${amb.ambulanceId}`);
            amb.destinationHospital = hospitalId;
            await stateStore.setAmbulance(amb);

            await eventBus.publish({
              eventId: uuidv4(),
              eventType: 'destination.changed',
              timestamp: new Date().toISOString(),
              source: { type: 'system', id: 'routing-engine' },
              version: '1.0',
              payload: { ambulanceId: amb.ambulanceId, hospitalId, reason: 'Destination accepted request' },
            });

            const routeReq = {
              origin: amb.currentLocation,
              destination: { latitude: existing.location.latitude, longitude: existing.location.longitude },
              travelMode: 'DRIVING' as const,
            };
            const route = await mappingProvider.calculateRoute(routeReq);
            await eventBus.publish({
              eventId: uuidv4(),
              eventType: 'route.recalculated',
              timestamp: new Date().toISOString(),
              source: { type: 'system', id: 'routing-engine' },
              version: '1.0',
              payload: {
                ambulanceId: amb.ambulanceId,
                oldHospitalId: '',
                newHospitalId: hospitalId,
                distanceMeters: route.distanceMeters,
                durationSeconds: route.durationSeconds,
                polyline: route.polyline,
                coordinates: route.coordinates,
                provider: route.provider,
                sourceType: route.sourceType,
                synthetic: route.synthetic,
                reason: 'Initial route generated after acceptance',
              },
            });
            break;
          }
        }
      } else if (status === 'UNAVAILABLE' || status === 'REJECTED') {
        for (const amb of ambulances) {
          if (amb.destinationHospital === hospitalId && amb.currentLocation) {
            console.log(`[Lambda:HospitalProcessor] Hospital ${hospitalId} rejected/unavailable. Rerouting ${amb.ambulanceId}`);
            const patient = await stateStore.getPatient(amb.assignedPatient || '');
            const reqs = patient ? patient.careRequirements : [];
            const candidates = await calculateBestHospitals(amb.currentLocation, reqs);
            const newTarget = candidates.find(c => c.hospitalId !== hospitalId && c.factors.availability > 0);

            if (newTarget) {
              const newHosp = await stateStore.getHospital(newTarget.hospitalId);
              if (newHosp && newHosp.location) {
                const routeReq = {
                  origin: amb.currentLocation,
                  destination: { latitude: newHosp.location.latitude, longitude: newHosp.location.longitude },
                  travelMode: 'DRIVING' as const,
                };
                const route = await mappingProvider.calculateRoute(routeReq);

                await eventBus.publish({
                  eventId: uuidv4(),
                  eventType: 'destination.changed',
                  timestamp: new Date().toISOString(),
                  source: { type: 'system', id: 'routing-engine' },
                  version: '1.0',
                  payload: { ambulanceId: amb.ambulanceId, hospitalId: newHosp.hospitalId, reason: `Previous destination ${status}` },
                });

                await eventBus.publish({
                  eventId: uuidv4(),
                  eventType: 'route.recalculated',
                  timestamp: new Date().toISOString(),
                  source: { type: 'system', id: 'routing-engine' },
                  version: '1.0',
                  payload: {
                    ambulanceId: amb.ambulanceId,
                    oldHospitalId: hospitalId,
                    newHospitalId: newHosp.hospitalId,
                    distanceMeters: route.distanceMeters,
                    durationSeconds: route.durationSeconds,
                    polyline: route.polyline,
                    coordinates: route.coordinates,
                    provider: route.provider,
                    sourceType: route.sourceType,
                    synthetic: route.synthetic,
                    reason: `Destination capacity changed to ${status}`,
                  },
                });

                amb.destinationHospital = newHosp.hospitalId;
                await stateStore.setAmbulance(amb);
              }
            } else {
              amb.destinationHospital = undefined;
              await stateStore.setAmbulance(amb);
            }
          }
        }
      }
    }
  }

  return { status: 'processed' };
};
