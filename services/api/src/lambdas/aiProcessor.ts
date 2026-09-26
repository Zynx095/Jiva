import { EventBridgeEvent } from 'aws-lambda';
import { DynamoStateStore } from '../infrastructure/stateStore/DynamoStateStore';
import { AwsEventBridgeBus } from '../infrastructure/eventBus/AwsEventBridgeBus';
import { BedrockAIProvider, MockAIProvider, CachedAIProvider, AIProvider } from '@jiva/intelligence';
import { MetricsCollector } from '../infrastructure/observability/metrics';
import { v4 as uuidv4 } from 'uuid';

const TABLE_NAME = process.env.DYNAMO_TABLE_NAME || 'jiva-operational-mesh';
const BUS_NAME = process.env.EVENT_BUS_NAME || 'jiva-healthcare-mesh';
const REGION = process.env.AWS_REGION || 'ap-south-1';

const stateStore = new DynamoStateStore({ tableName: TABLE_NAME, region: REGION });
const eventBus = new AwsEventBridgeBus({ eventBusName: BUS_NAME, region: REGION });
const metrics = new MetricsCollector(true, REGION);

// Bedrock with caching
const baseAi = process.env.USE_BEDROCK === 'true' ? new BedrockAIProvider(REGION) : new MockAIProvider();
const aiProvider: AIProvider = new CachedAIProvider(baseAi);

export const handler = async (event: EventBridgeEvent<string, any>) => {
  const jivaEvent = event.detail;
  const startTime = Date.now();

  try {
    // 1. Clinical Handoff when Hospital Accepts
    if (jivaEvent.eventType === 'hospital.acceptance.received' && jivaEvent.payload.status === 'ACCEPTED') {
      const patient = await stateStore.getPatient(jivaEvent.payload.caseId);
      const hospital = await stateStore.getHospital(jivaEvent.payload.hospitalId);
      const ambulances = await stateStore.listAmbulances();
      const ambulance = ambulances.find(a => a.assignedPatient === jivaEvent.payload.caseId);

      if (patient && hospital && ambulance) {
        await metrics.record('AI_REQUESTS', 1, 'Count', { Task: 'ClinicalHandoff' });
        const events = await stateStore.queryEventsByCase(patient.patientId);
        
        const handoff = await aiProvider.generateClinicalHandoff({
          patient,
          hospital,
          ambulance,
          events,
        });

        await metrics.record('AI_LATENCY', Date.now() - startTime, 'Milliseconds');

        await eventBus.publish({
          eventId: uuidv4(),
          eventType: 'ai.handoff.generated',
          timestamp: new Date().toISOString(),
          source: { type: 'system', id: 'bedrock-ai-processor' },
          version: '1.0',
          payload: {
            patientId: patient.patientId,
            ...handoff,
          },
        });
      }
    }

    // 2. Anomaly Explanation on Reroute or Rejection
    if (jivaEvent.eventType === 'destination.changed' || (jivaEvent.eventType === 'hospital.acceptance.received' && jivaEvent.payload.status === 'REJECTED')) {
      const caseId = jivaEvent.payload.caseId || jivaEvent.correlationId;
      if (caseId) {
        const patient = await stateStore.getPatient(caseId);
        if (patient) {
          await metrics.record('ANOMALIES_DETECTED', 1, 'Count');
          await metrics.record('AI_REQUESTS', 1, 'Count', { Task: 'AnomalyExplanation' });

          const reason = jivaEvent.payload.reason || jivaEvent.payload.limitations?.join(', ') || 'Operational deviation';
          const events = await stateStore.queryEventsByCase(caseId);

          const explanation = await aiProvider.explainAnomaly({
            patient,
            anomalies: [reason],
            events,
          });

          await metrics.record('AI_LATENCY', Date.now() - startTime, 'Milliseconds');

          await eventBus.publish({
            eventId: uuidv4(),
            eventType: 'ai.anomaly.explained',
            timestamp: new Date().toISOString(),
            source: { type: 'system', id: 'bedrock-ai-processor' },
            version: '1.0',
            payload: {
              patientId: patient.patientId,
              anomalies: [reason],
              ...explanation,
            },
          });
        }
      }
    }
  } catch (err) {
    // Bedrock failures must NEVER stop emergency coordination!
    console.error('[Lambda:AiProcessor] Asynchronous AI sidecar caught error:', err);
    await metrics.record('AI_FAILURES', 1, 'Count');
  }

  return { status: 'completed' };
};
