import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { AmbulanceState } from '@jiva/domain-models';

async function testEventOrdering() {
  console.log('[Test] Running Event Ordering (A -> C -> B) Verification...');
  const store = new LocalStateStore();

  const timeA = new Date('2026-09-26T10:00:00Z').toISOString();
  const timeB = new Date('2026-09-26T10:05:00Z').toISOString();
  const timeC = new Date('2026-09-26T10:10:00Z').toISOString();

  const ambulanceA: AmbulanceState = {
    ambulanceId: 'AMB-TEST-ORDER-1',
    status: 'AVAILABLE',
    currentLocation: { latitude: 12.9716, longitude: 77.5946 },
    requiredCapabilities: [],
    lastUpdated: timeA,
    provenance: [],
  };

  const ambulanceB: AmbulanceState = {
    ...ambulanceA,
    status: 'DISPATCHED',
    currentLocation: { latitude: 12.9750, longitude: 77.5980 },
    lastUpdated: timeB,
  };

  const ambulanceC: AmbulanceState = {
    ...ambulanceA,
    status: 'EN_ROUTE_TO_HOSPITAL',
    currentLocation: { latitude: 12.9800, longitude: 77.6020 },
    lastUpdated: timeC,
  };

  // Sequence 1: Ingest A
  await store.setAmbulance(ambulanceA);
  let current = await store.getAmbulance('AMB-TEST-ORDER-1');
  if (current?.status !== 'AVAILABLE') {
    throw new Error('Expected status to be AVAILABLE after event A');
  }

  // Sequence 2: Ingest C (Out of order: C arrives BEFORE B)
  await store.setAmbulance(ambulanceC);
  current = await store.getAmbulance('AMB-TEST-ORDER-1');
  if (current?.status !== 'EN_ROUTE_TO_HOSPITAL') {
    throw new Error('Expected status to be EN_ROUTE_TO_HOSPITAL after event C');
  }

  // Sequence 3: Ingest B (Older event arrives late)
  await store.setAmbulance(ambulanceB);
  current = await store.getAmbulance('AMB-TEST-ORDER-1');
  if (current?.status !== 'EN_ROUTE_TO_HOSPITAL') {
    throw new Error(`Out-of-order event B overwritten newer state C! Status was ${current?.status}`);
  }
  if (current?.currentLocation.latitude !== 12.9800) {
    throw new Error(`Location was overwritten by older event! Latitude was ${current?.currentLocation.latitude}`);
  }

  console.log('✓ Event ordering test passed: older event B arriving after C was safely ignored without overwriting state.\n');
}

testEventOrdering().catch((err) => {
  console.error('✗ Event ordering test failed:', err);
  process.exit(1);
});
