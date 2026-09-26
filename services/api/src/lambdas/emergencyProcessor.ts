import { EventBridgeEvent } from 'aws-lambda';
import { DynamoStateStore } from '../infrastructure/stateStore/DynamoStateStore';
import { AwsEventBridgeBus } from '../infrastructure/eventBus/AwsEventBridgeBus';
import { evaluateHospitals } from '../eligibilityEngine';
import { v4 as uuidv4 } from 'uuid';

const TABLE_NAME = process.env.DYNAMO_TABLE_NAME || 'jiva-operational-mesh';
const BUS_NAME = process.env.EVENT_BUS_NAME || 'jiva-healthcare-mesh';
const REGION = process.env.AWS_REGION || 'ap-south-1';

const stateStore = new DynamoStateStore({ tableName: TABLE_NAME, region: REGION });
const eventBus = new AwsEventBridgeBus({ eventBusName: BUS_NAME, region: REGION });

export const handler = async (event: EventBridgeEvent<string, any>) => {
  const jivaEvent = event.detail;
  console.log(`[Lambda:EmergencyProcessor] Processing ${event['detail-type']} (${jivaEvent.eventId})`);

  // Idempotency check in DynamoDB
  const recordResult = await stateStore.recordEvent(jivaEvent);
  if (recordResult.isDuplicate) {
    console.log(`[Lambda:EmergencyProcessor] Skipping duplicate event ${jivaEvent.eventId}`);
    return { status: 'duplicate_skipped' };
  }

  if (jivaEvent.eventType === 'patient.emergency.created') {
    const patientId = jivaEvent.patientId || `patient-${Date.now()}`;
    await stateStore.setPatient({
      patientId,
      currentStatus: 'EMERGENCY_REPORTED',
      currentLocation: jivaEvent.payload.location,
      careRequirements: [jivaEvent.payload.condition],
      activeConditions: [],
      lastUpdated: new Date().toISOString(),
      provenance: [{
        sourceType: jivaEvent.source.type,
        sourceId: jivaEvent.source.id,
        eventId: jivaEvent.eventId,
        timestamp: jivaEvent.timestamp,
        confidence: jivaEvent.metadata?.confidence || 1.0,
      }],
    });

    // Emit Care Requirement
    const reqId = `REQ-${uuidv4().substring(0, 8)}`;
    await eventBus.publish({
      eventId: uuidv4(),
      eventType: 'care.requirement.created',
      timestamp: new Date().toISOString(),
      source: { type: 'system', id: 'engine' },
      version: '1.0',
      payload: {
        requirementId: reqId,
        caseId: patientId,
        requiredCapabilities: ['EMERGENCY', 'TRAUMA', 'ICU'],
        optionalCapabilities: [],
        severity: jivaEvent.payload.severity,
        createdAt: new Date().toISOString(),
      },
    });
  } else if (jivaEvent.eventType === 'care.requirement.created') {
    const req = jivaEvent.payload;
    const patient = await stateStore.getPatient(req.caseId);
    const ambulanceLocation = patient?.currentLocation || { latitude: 12.9716, longitude: 77.5946 };

    const requirement = {
      requirementId: req.requirementId,
      caseId: req.caseId,
      requiredCapabilities: req.requiredCapabilities as any[],
      optionalCapabilities: req.optionalCapabilities as any[],
      severity: req.severity,
      createdAt: req.createdAt,
      source: jivaEvent.source.id,
    };

    const candidates = await evaluateHospitals(requirement, ambulanceLocation);

    await eventBus.publish({
      eventId: uuidv4(),
      eventType: 'hospital.candidate.generated',
      timestamp: new Date().toISOString(),
      source: { type: 'system', id: 'engine' },
      version: '1.0',
      payload: {
        caseId: req.caseId,
        candidates: candidates.map(c => ({
          hospitalId: c.hospitalId,
          hospitalName: c.hospitalName,
          capabilityMatch: c.capabilityMatch,
          missingCapabilities: c.missingCapabilities,
          operationalEligibility: c.operationalEligibility,
          distanceKm: c.distanceKm,
          etaMinutes: c.etaMinutes,
          reason: c.reason,
        })),
      },
    });

    // Send requests to capable hospitals
    for (const c of candidates) {
      if (c.missingCapabilities.length === 0) {
        const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
        await eventBus.publish({
          eventId: uuidv4(),
          eventType: 'hospital.acceptance.requested',
          timestamp: new Date().toISOString(),
          source: { type: 'system', id: 'engine' },
          version: '1.0',
          payload: {
            requestId: `AR-${uuidv4().substring(0, 8)}`,
            caseId: req.caseId,
            hospitalId: c.hospitalId,
            requiredCapabilities: req.requiredCapabilities,
            optionalCapabilities: req.optionalCapabilities,
            ambulanceEtaMinutes: c.etaMinutes,
            requestedAt: new Date().toISOString(),
            expiresAt,
          },
        });
      }
    }
  }

  return { status: 'processed' };
};
