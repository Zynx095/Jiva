import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { requestIdFor } from './lib/requestIds';
import { reportShadowDisagreements } from './lib/shadowReport';

const API_URL = 'http://localhost:4000/api/events';


// DEMO-ONLY auth: act as the persona that matches the event's source (server enforces scope).
function personaHeaders(event: any): Record<string, string> {
  const id: string = event?.source?.id || '';
  const hosp = id.match(/^HOSP-BLR-00(\d)$/);
  const amb = id.match(/^AMB-BLR-00(\d)$/);
  const persona = hosp ? `demo-hosp-${hosp[1]}` : amb ? `demo-amb-${amb[1]}` : 'demo-mgmt-1';
  return { 'Content-Type': 'application/json', 'x-jiva-demo-user': persona };
}

async function sendEvent(event: any) {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: personaHeaders(event),
      body: JSON.stringify(event)
    });
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    console.log(`[Simulator] Sent ${event.eventType} for ${event.source?.id || 'unknown'}`);
  } catch (err) {
    console.error(`[Simulator] Failed to send ${event.eventType}:`, err);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:4000/api/health', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runAcceptanceScenario(fullResponse = true) {
  const isServerRunning = await checkServer();
  if (!isServerRunning) {
    console.error('\n============================================================');
    console.error('❌ JIVA API SERVER NOT FOUND ON http://localhost:4000');
    console.error('============================================================');
    console.error('The simulation pushes live events to the JIVA backend to');
    console.error('demonstrate real-time hospital acceptance & coordination.\n');
    console.error('👉 HOW TO RUN:');
    console.error('  1. In Terminal 1, start the backend server (or full app):');
    console.error('     npm run dev:api     (or: npm run dev)');
    console.error('');
    console.error('  2. In Terminal 2, re-run this simulation:');
    console.error('     npm run simulate:hospital-response:blr');
    console.error('============================================================\n');
    process.exit(1);
  }

  console.log('--- STARTING PHASE 2 SIMULATION (SYNTHETIC DEMO) ---');
  
  // 1. Initial State - Preload Mock Bengaluru Hospitals
  const hospitalsData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/synthetic/bengaluru/hospitals.json'), 'utf8'));
  for (const h of hospitalsData) {
    // Reset all hospitals to UNKNOWN state for testing acceptance flow
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'hospital.capacity.updated',
      timestamp: new Date().toISOString(),
      source: { type: 'hospital', id: h.hospitalId },
      version: '1.0',
      payload: {
        hospitalId: h.hospitalId,
        emergencyStatus: 'UNKNOWN',
        traumaStatus: 'UNKNOWN',
        icuStatus: 'UNKNOWN',
        ventilatorStatus: 'UNKNOWN'
      },
      metadata: { confidence: 1.0, sourceType: 'SYNTHETIC_DEMO' }
    });
  }
  await sleep(1000);

  // Load ambulances
  const ambData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/synthetic/bengaluru/ambulances.json'), 'utf8'));
  for (const a of ambData) {
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'ambulance.location.updated',
      timestamp: new Date().toISOString(),
      source: { type: 'ambulance', id: a.ambulanceId },
      version: '1.0',
      payload: {
        ambulanceId: a.ambulanceId,
        coordinates: a.currentLocation
      }
    });
  }
  await sleep(1000);

  // 2. Patient Emergency
  const patientId = `CASE-BLR-002`;
  const patientLocation = { latitude: 13.0358, longitude: 77.5970 }; // Hebbal
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'patient.emergency.created',
    timestamp: new Date().toISOString(),
    source: { type: 'system', id: 'dispatch-blr-1' },
    version: '1.0',
    patientId,
    payload: {
      condition: 'Severe Trauma',
      location: patientLocation,
      severity: 'CRITICAL'
    },
    metadata: { confidence: 1.0, sourceType: '911-dispatch' }
  });
  console.log('Emergency registered. The engine should automatically create Care Requirement and Request Acceptances.');
  await sleep(3000); // Wait for engine to send requests

  // 3. Ambulance Dispatched
  const ambulanceId = 'AMB-BLR-001';
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'ambulance.dispatched',
    timestamp: new Date().toISOString(),
    source: { type: 'system', id: 'dispatch-blr-1' },
    version: '1.0',
    payload: {
      ambulanceId,
      caseId: patientId,
      destination: patientLocation,
      estimatedEtaMinutes: 8
    }
  });
  await sleep(2000);
  
  if (fullResponse) {
    console.log('--- HOSPITAL RESPONSES ---');
    // Hospital C REJECTS
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'hospital.acceptance.received',
      timestamp: new Date().toISOString(),
      source: { type: 'hospital', id: 'HOSP-BLR-004' },
      version: '1.0',
      payload: {
        responseId: uuidv4(),
        requestId: await requestIdFor(API_URL, patientId, 'HOSP-BLR-004'),
        caseId: patientId,
        hospitalId: 'HOSP-BLR-004',
        status: 'REJECTED',
        acceptedCapabilities: [],
        limitations: ['Trauma service unavailable'],
        respondedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
        responderRole: 'CLINICAL_COORDINATOR',
        source: 'SYNTHETIC_DEMO'
      }
    });
    await sleep(1000);
    
    // Hospital B LIMITED
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'hospital.acceptance.received',
      timestamp: new Date().toISOString(),
      source: { type: 'hospital', id: 'HOSP-BLR-002' },
      version: '1.0',
      payload: {
        responseId: uuidv4(),
        requestId: await requestIdFor(API_URL, patientId, 'HOSP-BLR-002'),
        caseId: patientId,
        hospitalId: 'HOSP-BLR-002',
        status: 'LIMITED',
        acceptedCapabilities: ['EMERGENCY', 'TRAUMA'],
        limitations: ['ICU capacity limited'],
        respondedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
        responderRole: 'CLINICAL_COORDINATOR',
        source: 'SYNTHETIC_DEMO'
      }
    });
    await sleep(1000);

    // Hospital A ACCEPTS
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'hospital.acceptance.received',
      timestamp: new Date().toISOString(),
      source: { type: 'hospital', id: 'HOSP-BLR-001' },
      version: '1.0',
      payload: {
        responseId: uuidv4(),
        requestId: await requestIdFor(API_URL, patientId, 'HOSP-BLR-001'),
        caseId: patientId,
        hospitalId: 'HOSP-BLR-001',
        status: 'ACCEPTED',
        acceptedCapabilities: ['EMERGENCY', 'TRAUMA', 'ICU'],
        limitations: [],
        respondedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
        responderRole: 'CLINICAL_COORDINATOR',
        source: 'SYNTHETIC_DEMO'
      }
    });
    
    console.log('Hospital A accepted. Destination should change to HOSP-BLR-001.');
    await sleep(4000);

    // Then Hospital A becomes unavailable
    console.log('--- HOSPITAL A BECOMES UNAVAILABLE ---');
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'hospital.capacity.updated',
      timestamp: new Date().toISOString(),
      source: { type: 'hospital', id: 'HOSP-BLR-001' },
      version: '1.0',
      payload: {
        hospitalId: 'HOSP-BLR-001',
        emergencyStatus: 'UNAVAILABLE',
        traumaStatus: 'UNAVAILABLE',
        icuStatus: 'UNAVAILABLE',
        ventilatorStatus: 'UNAVAILABLE'
      },
      metadata: { confidence: 1.0, sourceType: 'SYNTHETIC_DEMO' }
    });
    console.log('Destination should invalidate and reroute to HOSP-BLR-002 (LIMITED but best available).');
  }

  await sleep(2000);
  await reportShadowDisagreements(API_URL);
  console.log('--- SCENARIO COMPLETE ---');
}

const scenario = process.argv[2];
runAcceptanceScenario(scenario !== 'acceptance');
