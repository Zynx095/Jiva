import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { PatientEmergencyCreated } from '@jiva/event-schema';

async function testIdempotency() {
  console.log('[Test] Running Idempotency Verification...');
  const store = new LocalStateStore();

  const event: PatientEmergencyCreated = {
    eventId: 'EVT-TEST-IDEMP-001',
    eventType: 'patient.emergency.created',
    timestamp: new Date().toISOString(),
    source: { type: 'system', id: 'test' },
    version: '1.0',
    patientId: 'CASE-TEST-001',
    payload: {
      condition: 'Cardiac Arrest',
      location: { latitude: 12.9716, longitude: 77.5946 },
      severity: 'CRITICAL',
    },
  };

  // First ingestion
  const res1 = await store.recordEvent(event);
  if (res1.isDuplicate !== false) {
    throw new Error('First event insertion must NOT be duplicate');
  }

  // Second ingestion with SAME eventId (simulating EventBridge retry or duplicate delivery)
  const res2 = await store.recordEvent(event);
  if (res2.isDuplicate !== true) {
    throw new Error('Second event insertion with identical eventId MUST be detected as duplicate');
  }

  // Check event history length
  const history = await store.queryEventsByCase('CASE-TEST-001');
  if (history.length !== 1) {
    throw new Error(`Expected exactly 1 event in history, found ${history.length}`);
  }

  console.log('✓ Idempotency test passed: duplicate event safely ignored without state pollution.\n');
}

testIdempotency().catch((err) => {
  console.error('✗ Idempotency test failed:', err);
  process.exit(1);
});
