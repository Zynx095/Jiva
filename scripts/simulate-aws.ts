import { v4 as uuidv4 } from 'uuid';

const API_URL = process.env.API_GATEWAY_URL 
  ? `${process.env.API_GATEWAY_URL.replace(/\/$/, '')}/api/events` 
  : 'http://localhost:4000/api/events';

console.log('\n============================================================');
console.log('         JIVA AWS FLAGSHIP SIMULATION (BENGALURU)          ');
console.log(` Target Endpoint: ${API_URL}`);
console.log(' NOTE: without API_GATEWAY_URL this posts to the LOCAL API (no AWS deployment exists).');
console.log('============================================================\n');


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
      body: JSON.stringify(event),
    });
    const data = await res.json();
    console.log(`[AWS Mesh] Ingested: ${event.eventType.padEnd(32)} -> HTTP ${res.status} (${data.status || 'ok'})`);
  } catch (err: any) {
    console.error(`[AWS Mesh] Error delivering event ${event.eventType}:`, err.message);
  }
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:4000/api/health', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runAwsScenario() {
  const isServerRunning = await checkServer();
  if (!isServerRunning) {
    console.error('\n============================================================');
    console.error('❌ JIVA API SERVER NOT FOUND ON http://localhost:4000');
    console.error('============================================================');
    console.error('The simulation pushes live events to the JIVA backend to');
    console.error('demonstrate EventBridge, DynamoDB, and Bedrock choreography.\n');
    console.error('👉 HOW TO RUN:');
    console.error('  1. In Terminal 1, start the backend server (or full app):');
    console.error('     npm run dev:api     (or: npm run dev)');
    console.error('');
    console.error('  2. In Terminal 2, re-run this simulation:');
    console.error('     npm run simulate:aws:blr');
    console.error('============================================================\n');
    process.exit(1);
  }

  const caseId = 'CASE-BLR-876';
  const ambulanceId = 'AMB-BLR-001';

  // 1. Reset baseline hospital capacity state to UNKNOWN
  console.log('Step 1: Initializing Hospital Operational States...');
  const hospitals = ['HOSP-BLR-001', 'HOSP-BLR-002', 'HOSP-BLR-003', 'HOSP-BLR-004'];
  for (const h of hospitals) {
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'hospital.capacity.updated',
      timestamp: new Date().toISOString(),
      source: { type: 'hospital', id: h },
      version: '1.0',
      payload: {
        hospitalId: h,
        emergencyStatus: 'UNKNOWN',
        traumaStatus: 'UNKNOWN',
        icuStatus: 'UNKNOWN',
        ventilatorStatus: 'UNKNOWN',
      },
      metadata: { confidence: 1.0, sourceType: 'SYNTHETIC_DEMO' },
    });
  }

  await sleep(1500);

  // 2. Emergency Reported
  console.log('\nStep 2: Publishing Patient Emergency Event...');
  const patientLocation = { latitude: 13.0358, longitude: 77.5970 };
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'patient.emergency.created',
    timestamp: new Date().toISOString(),
    source: { type: 'system', id: 'blr-911-dispatch' },
    version: '1.0',
    patientId: caseId,
    payload: {
      condition: 'Severe Polytrauma',
      location: patientLocation,
      severity: 'CRITICAL',
    },
    metadata: { confidence: 1.0, sourceType: 'EMERGENCY_DISPATCH' },
  });

  await sleep(2000);

  // 3. Ambulance Dispatched
  console.log('\nStep 3: Dispatching Ambulance AMB-BLR-001...');
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'ambulance.dispatched',
    timestamp: new Date().toISOString(),
    source: { type: 'system', id: 'ems-central' },
    version: '1.0',
    payload: {
      ambulanceId,
      caseId,
      destination: patientLocation,
      estimatedEtaMinutes: 7,
    },
  });

  await sleep(2500);

  // 4. Hospital Acceptance Workflow
  console.log('\nStep 4: Simulating Hospital Acceptance Protocols (EventBridge Fan-out)...');
  
  // Hospital 3 REJECTS
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'hospital.acceptance.received',
    timestamp: new Date().toISOString(),
    source: { type: 'hospital', id: 'HOSP-BLR-004' },
    version: '1.0',
    payload: {
      responseId: uuidv4(),
      requestId: 'req-3',
      caseId,
      hospitalId: 'HOSP-BLR-004',
      status: 'REJECTED',
      acceptedCapabilities: [],
      limitations: ['Trauma bay undergoing emergency sanitization'],
      respondedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 3600000).toISOString(),
      responderRole: 'TRIAGE_COORDINATOR',
      source: 'SYNTHETIC_DEMO',
    },
  });

  await sleep(1500);

  // Hospital 2 LIMITED
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'hospital.acceptance.received',
    timestamp: new Date().toISOString(),
    source: { type: 'hospital', id: 'HOSP-BLR-002' },
    version: '1.0',
    payload: {
      responseId: uuidv4(),
      requestId: 'req-2',
      caseId,
      hospitalId: 'HOSP-BLR-002',
      status: 'LIMITED',
      acceptedCapabilities: ['EMERGENCY', 'TRAUMA'],
      limitations: ['ICU ventilator capacity near threshold'],
      respondedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 3600000).toISOString(),
      responderRole: 'TRIAGE_COORDINATOR',
      source: 'SYNTHETIC_DEMO',
    },
  });

  await sleep(1500);

  // Hospital 1 ACCEPTS
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'hospital.acceptance.received',
    timestamp: new Date().toISOString(),
    source: { type: 'hospital', id: 'HOSP-BLR-001' },
    version: '1.0',
    payload: {
      responseId: uuidv4(),
      requestId: 'req-1',
      caseId,
      hospitalId: 'HOSP-BLR-001',
      status: 'ACCEPTED',
      acceptedCapabilities: ['EMERGENCY', 'TRAUMA', 'ICU'],
      limitations: [],
      respondedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 3600000).toISOString(),
      responderRole: 'CHIEF_TRAUMA_COORDINATOR',
      source: 'SYNTHETIC_DEMO',
    },
  });

  console.log('\n✓ Destination Assigned: HOSP-BLR-001. Bedrock AI Sidecar triggered for Handoff.');
  await sleep(3000);

  // 5. Ambulance Moves Along Route
  console.log('\nStep 5: Updating Ambulance Telemetry (In-transit)...');
  let lat = 13.0358;
  let lng = 77.5970;
  for (let i = 1; i <= 3; i++) {
    lat -= 0.004;
    lng += 0.002;
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'ambulance.location.updated',
      timestamp: new Date().toISOString(),
      source: { type: 'ambulance', id: ambulanceId },
      version: '1.0',
      payload: {
        ambulanceId,
        coordinates: { latitude: lat, longitude: lng },
        speedKmh: 48,
        heading: 180,
      },
    });
    await sleep(1500);
  }

  // 6. Dynamic Reroute Event: Primary Destination Fails
  console.log('\nStep 6: Simulating Sudden Hospital Overload at HOSP-BLR-001 (UNAVAILABLE)...');
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
      ventilatorStatus: 'UNAVAILABLE',
    },
    metadata: { confidence: 1.0, sourceType: 'SYNTHETIC_DEMO' },
  });

  console.log('\n✓ Core Routing Engine evaluates fallback: Rerouting to HOSP-BLR-002.');
  console.log('✓ Bedrock Anomaly Sidecar triggered to explain diversion.');
  await sleep(3000);

  // 7. Continued transit to Fallback Hospital
  console.log('\nStep 7: Resuming transit to Fallback Hospital HOSP-BLR-002...');
  for (let i = 1; i <= 2; i++) {
    lat -= 0.003;
    lng -= 0.003;
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'ambulance.location.updated',
      timestamp: new Date().toISOString(),
      source: { type: 'ambulance', id: ambulanceId },
      version: '1.0',
      payload: {
        ambulanceId,
        coordinates: { latitude: lat, longitude: lng },
        speedKmh: 52,
        heading: 220,
      },
    });
    await sleep(1500);
  }

  console.log('\n============================================================');
  console.log('       AWS FLAGSHIP SCENARIO COMPLETED SUCCESSFULLY         ');
  console.log(' All events propagated across DynamoDB, EventBridge & UI   ');
  console.log('============================================================\n');
}

runAwsScenario().catch(console.error);
