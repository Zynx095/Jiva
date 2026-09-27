import { eventBus } from './eventBus';
import { patientsStore, hospitalsStore, ambulancesStore } from './stateStore';
import { MockAIProvider, BedrockAIProvider, CachedAIProvider } from '@jiva/intelligence';
import { v4 as uuidv4 } from 'uuid';
import { AnyEvent } from '@jiva/event-schema';
import { UNASSIGNED, getEpoch } from './stateEngines';

/**
 * AI SIDECAR. Consumes events and publishes ONLY `ai.*` informational events.
 * It has no write access to hospital, ambulance, patient or routing state, and no
 * engine subscribes to `ai.*` events. Provider failures are logged and swallowed so
 * the operational workflow never depends on AI availability.
 */
export const aiProviderName = process.env.USE_BEDROCK === 'true' ? 'BedrockAIProvider' : 'MockAIProvider';
const baseProvider = process.env.USE_BEDROCK === 'true' ? new BedrockAIProvider() : new MockAIProvider();
let aiProvider = new CachedAIProvider(baseProvider);

const MAX_HISTORY = 2000;
let history: AnyEvent[] = [];
const timers = new Set<NodeJS.Timeout>();
let aiFailures = 0;

export function getAiStatus() {
  return { provider: aiProviderName, failures: aiFailures };
}

export function resetIntelligence(): void {
  history = [];
  for (const t of timers) clearTimeout(t);
  timers.clear();
  aiProvider = new CachedAIProvider(baseProvider);
}

const caseEvents = (caseId: string, ambulanceId?: string) =>
  history.filter((e: any) => e.payload?.caseId === caseId || e.patientId === caseId || (ambulanceId && e.payload?.ambulanceId === ambulanceId));

async function run(label: string, fn: () => Promise<AnyEvent | undefined>) {
  const epoch = getEpoch();
  try {
    const out = await fn();
    if (out && epoch === getEpoch()) await eventBus.publish(out);
  } catch (err) {
    aiFailures++;
    console.error(`[Intelligence Engine] ${label} failed (non-blocking): ${err instanceof Error ? err.message : err}`);
  }
}

const aiEvent = (eventType: string, payload: Record<string, unknown>) => ({
  eventId: uuidv4(),
  eventType,
  timestamp: new Date().toISOString(),
  source: { type: 'system', id: 'intelligence-engine' },
  version: '1.0',
  payload,
}) as AnyEvent;

export function initializeIntelligenceEngine() {
  console.log(`[Intelligence Engine] Initializing asynchronously (${aiProviderName})...`);

  eventBus.on('*', (event: AnyEvent) => {
    if (event.eventType === 'ambulance.location.updated') return; // high-frequency, not useful context
    // Engine audit telemetry is not AI context (keeps advisory input independent of the engine's own trace).
    if (event.eventType === 'feasibility.trace.recorded') return;
    history.push(event);
    if (history.length > MAX_HISTORY) history.shift();
  });

  // 1. Clinical handoff for the hospital the ambulance is actually heading to.
  eventBus.on('destination.changed', (event: AnyEvent) => {
    if (event.eventType !== 'destination.changed' || event.payload.hospitalId === UNASSIGNED) return;
    const ambulance = ambulancesStore.get(event.payload.ambulanceId);
    const patient = patientsStore.get(ambulance?.assignedPatient || '');
    const hospital = hospitalsStore.get(event.payload.hospitalId);
    if (!ambulance || !patient || !hospital) return;
    void run('handoff', async () => {
      const handoff = await aiProvider.generateClinicalHandoff({ patient, hospital, ambulance, events: caseEvents(patient.patientId, ambulance.ambulanceId) });
      return aiEvent('ai.handoff.generated', { patientId: patient.patientId, hospitalId: hospital.hospitalId, ...handoff });
    });
  });

  // 2. Anomaly explanation: deterministic trigger (rejection / unavailability / reroute).
  eventBus.on('hospital.acceptance.received', (event: AnyEvent) => {
    if (event.eventType !== 'hospital.acceptance.received') return;
    if (event.payload.status !== 'REJECTED' && event.payload.status !== 'UNAVAILABLE') return;
    const patient = patientsStore.get(event.payload.caseId);
    if (!patient) return;
    const anomaly = `Hospital ${event.payload.hospitalId} responded ${event.payload.status}${event.payload.limitations.length ? `: ${event.payload.limitations.join(', ')}` : ''}`;
    void run('anomaly', async () => {
      const explanation = await aiProvider.explainAnomaly({ patient, anomalies: [anomaly], events: caseEvents(patient.patientId) });
      return aiEvent('ai.anomaly.explained', { patientId: patient.patientId, anomalies: [anomaly], ...explanation });
    });
  });

  eventBus.on('route.recalculated', (event: AnyEvent) => {
    if (event.eventType !== 'route.recalculated' || !event.payload.oldHospitalId) return; // initial routes are not anomalies
    const ambulance = ambulancesStore.get(event.payload.ambulanceId);
    const patient = patientsStore.get(ambulance?.assignedPatient || '');
    if (!ambulance || !patient) return;
    const anomaly = `Ambulance ${ambulance.ambulanceId} rerouted ${event.payload.oldHospitalId} -> ${event.payload.newHospitalId}: ${event.payload.reason}`;
    void run('reroute-anomaly', async () => {
      const explanation = await aiProvider.explainAnomaly({ patient, anomalies: [anomaly], events: caseEvents(patient.patientId, ambulance.ambulanceId) });
      return aiEvent('ai.anomaly.explained', { patientId: patient.patientId, anomalies: [anomaly], ...explanation });
    });
  });

  // 3. Timeline summary once the patient arrives.
  eventBus.on('ambulance.arrived', (event: AnyEvent) => {
    if (event.eventType !== 'ambulance.arrived') return;
    const patient = patientsStore.get(event.payload.caseId || '');
    if (!patient) return;
    const t = setTimeout(() => {
      timers.delete(t);
      void run('summary', async () => {
        const summary = await aiProvider.summarizeEmergency({ patient, events: caseEvents(patient.patientId, event.payload.ambulanceId) });
        return aiEvent('ai.summary.generated', { patientId: patient.patientId, ...summary });
      });
    }, 1000);
    timers.add(t);
  });
}
