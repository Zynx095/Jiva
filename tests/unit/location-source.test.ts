/**
 * Ambulance position source: no GPS receiver is integrated, so every position states where it came from —
 * set manually by the crew, simulated by a demo tool, or (only if one existed) a GPS device. Both the local
 * engine and the AWS ambulance core keep the source of the CURRENT position; an unstated source is never
 * turned into "GPS" and never inherited from an earlier position.
 */
import { randomUUID } from 'crypto';
import { AmbulanceLocationUpdatedSchema, type AnyEvent } from '../../packages/event-schema/src';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { createAmbulanceHandler } from '../../services/api/src/lambdas/core/ambulanceCore';
import { check, eq, ok, run } from './helpers/assert';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let t = Date.now() - 60_000;
const move = (ambulanceId: string, latitude: number, source?: string) => ({
  eventId: randomUUID(), eventType: 'ambulance.location.updated', timestamp: new Date((t += 1000)).toISOString(), version: '1.0',
  source: { type: 'ambulance', id: ambulanceId },
  payload: { ambulanceId, coordinates: { latitude, longitude: 77.59 }, ...(source ? { source } : {}) },
});

run('Ambulance position source', async () => {
  await check('the contract accepts MANUAL, SIMULATED and DEVICE_GPS, and no source (legacy); nothing else', () => {
    for (const s of ['MANUAL', 'SIMULATED', 'DEVICE_GPS', undefined]) ok(AmbulanceLocationUpdatedSchema.safeParse(move('AMB-BLR-001', 13, s)).success, String(s));
    ok(!AmbulanceLocationUpdatedSchema.safeParse(move('AMB-BLR-001', 13, 'LIVE')).success, 'unknown source refused');
  });

  await check('local engine: the current position carries its own source, never an inherited one', async () => {
    const { eventBus } = await import('../../services/api/src/eventBus');
    const engines = await import('../../services/api/src/stateEngines');
    const stores = await import('../../services/api/src/stateStore');
    await stores.preloadData();
    engines.initializeStateEngines();
    await eventBus.publish(move('AMB-BLR-001', 13.01, 'MANUAL') as unknown as AnyEvent);
    await sleep(50);
    eq(stores.ambulancesStore.get('AMB-BLR-001')?.locationSource, 'MANUAL', 'set by the crew');
    await eventBus.publish(move('AMB-BLR-001', 13.02, 'SIMULATED') as unknown as AnyEvent);
    await sleep(50);
    eq(stores.ambulancesStore.get('AMB-BLR-001')?.locationSource, 'SIMULATED', 'simulated');
    await eventBus.publish(move('AMB-BLR-001', 13.03) as unknown as AnyEvent);
    await sleep(50);
    const a = stores.ambulancesStore.get('AMB-BLR-001');
    eq([a?.currentLocation?.latitude, a?.locationSource], [13.03, undefined], 'unstated stays unstated (not GPS, not the previous source)');
  });

  await check('AWS ambulance core keeps the same source', async () => {
    const store = new LocalStateStore();
    await store.preloadData();
    const handler = createAmbulanceHandler({ store } as never);
    await handler({ 'detail-type': 'ambulance.location.updated', detail: move('AMB-BLR-002', 13.04, 'MANUAL') });
    eq((await store.getAmbulance('AMB-BLR-002'))?.locationSource, 'MANUAL', 'manual');
    await handler({ 'detail-type': 'ambulance.location.updated', detail: move('AMB-BLR-002', 13.05) });
    eq((await store.getAmbulance('AMB-BLR-002'))?.locationSource, undefined, 'unstated');
  });
});
