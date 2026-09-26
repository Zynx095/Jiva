import { FallbackMappingProvider, FallbackLogger } from '../../packages/mapping/src/providers/FallbackMappingProvider';
import { MockMappingProvider } from '../../packages/mapping/src/providers/MockMappingProvider';
import { MappingProvider } from '../../packages/mapping/src/providers/MappingProvider';
import { createMappingProvider } from '../../packages/mapping/src/factory';
import { RouteRequest, RouteResult } from '../../packages/mapping/src/types';

class FailingProvider implements MappingProvider {
  constructor(readonly name: string) {}
  async calculateRoute(request: RouteRequest): Promise<RouteResult> {
    throw new Error(`${this.name} connection refused`);
  }
  async calculateETA() {
    throw new Error(`${this.name} connection refused`);
  }
  async geocode() {
    throw new Error(`${this.name} connection refused`);
  }
  async reverseGeocode() {
    throw new Error(`${this.name} connection refused`);
  }
}

async function testFallbackChain() {
  console.log('[Test] Running Mapping Fallback Chain Unit Tests...');

  const loggedWarnings: { message: string; meta?: any }[] = [];
  const testLogger: FallbackLogger = {
    warn: (message, meta) => loggedWarnings.push({ message, meta }),
    info: () => {}
  };

  const origin = { latitude: 12.9716, longitude: 77.5946 };
  const destination = { latitude: 12.9352, longitude: 77.6245 };
  const request: RouteRequest = { origin, destination, travelMode: 'DRIVING' };

  // Scenario 1: Primary fails, secondary succeeds
  console.log('  Testing Primary failure -> Secondary fallback...');
  const failingPrimary = new FailingProvider('valhalla');
  const mockSecondary = new MockMappingProvider();
  const failingTertiary = new FailingProvider('tertiary');

  const fallback1 = new FallbackMappingProvider(failingPrimary, mockSecondary, failingTertiary, testLogger);
  const res1 = await fallback1.calculateRoute(request);

  if (res1.provider !== 'mock') {
    throw new Error(`Expected fallback to succeed with secondary 'mock', got ${res1.provider}`);
  }
  if (loggedWarnings.length !== 1) {
    throw new Error(`Expected 1 warning logged, got ${loggedWarnings.length}`);
  }
  if (loggedWarnings[0].meta?.event !== 'mapping.provider.fallback') {
    throw new Error(`Expected structured log event 'mapping.provider.fallback', got ${loggedWarnings[0].meta?.event}`);
  }
  if (loggedWarnings[0].meta?.fromProvider !== 'valhalla' || loggedWarnings[0].meta?.toProvider !== 'mock') {
    throw new Error(`Expected fallback from valhalla to mock, got from ${loggedWarnings[0].meta?.fromProvider} to ${loggedWarnings[0].meta?.toProvider}`);
  }
  console.log('  ✓ Primary -> Secondary fallback passed with structured logging.');

  // Scenario 2: Primary and secondary fail -> Tertiary succeeds
  console.log('  Testing Primary & Secondary failure -> Tertiary fallback...');
  loggedWarnings.length = 0;
  const failingSecondary = new FailingProvider('osrm');
  const tertiaryMock = new MockMappingProvider();

  const fallback2 = new FallbackMappingProvider(failingPrimary, failingSecondary, tertiaryMock, testLogger);
  const res2 = await fallback2.calculateRoute(request);

  if (res2.provider !== 'mock') {
    throw new Error(`Expected tertiary fallback to succeed, got ${res2.provider}`);
  }
  if (loggedWarnings.length !== 2) {
    throw new Error(`Expected 2 fallback warnings, got ${loggedWarnings.length}`);
  }
  if (loggedWarnings[1].meta?.fromProvider !== 'osrm' || loggedWarnings[1].meta?.toProvider !== 'mock') {
    throw new Error(`Expected second fallback from osrm to mock`);
  }
  console.log('  ✓ Primary & Secondary -> Tertiary fallback passed.');

  // Scenario 3: Test Factory modes
  console.log('  Testing createMappingProvider() factory modes...');
  const autoProvider = createMappingProvider({ provider: 'auto' });
  if (autoProvider.name !== 'fallback') {
    throw new Error(`Expected auto mode to return 'fallback', got ${autoProvider.name}`);
  }

  const valhallaProvider = createMappingProvider({ provider: 'valhalla' });
  if (valhallaProvider.name !== 'valhalla') {
    throw new Error(`Expected valhalla mode to return 'valhalla', got ${valhallaProvider.name}`);
  }

  const osrmProvider = createMappingProvider({ provider: 'osrm' });
  if (osrmProvider.name !== 'osrm') {
    throw new Error(`Expected osrm mode to return 'osrm', got ${osrmProvider.name}`);
  }

  const mockProvider = createMappingProvider({ provider: 'mock' });
  if (mockProvider.name !== 'mock') {
    throw new Error(`Expected mock mode to return 'mock', got ${mockProvider.name}`);
  }
  console.log('  ✓ createMappingProvider() all modes verified.');

  console.log('✓ All Mapping Fallback Tests PASSED.\n');
}

testFallbackChain().catch((err) => {
  console.error('✗ Mapping Fallback Tests FAILED:', err);
  process.exit(1);
});
