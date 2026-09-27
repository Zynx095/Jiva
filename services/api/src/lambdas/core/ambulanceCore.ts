import { LambdaDeps } from './deps';
import { ensureDestination } from './routingCore';

/**
 * AWS ambulance processor. Dispatch now mirrors the local engine: a new dispatch starts a new
 * journey (previous case's destination is never carried over) and a destination is assigned from
 * any acceptance that already exists. GPS handling is unchanged from the previous AWS behaviour.
 */
export function createAmbulanceHandler(d: LambdaDeps) {
  return async (event: { 'detail-type'?: string; detail: any }) => {
    const jivaEvent = event.detail;
    console.log(`[Lambda:AmbulanceProcessor] Processing ${event['detail-type']} (${jivaEvent.eventId})`);

    const recordResult = await d.store.recordEvent(jivaEvent);
    if (recordResult.isDuplicate) {
      return { status: 'duplicate_skipped' };
    }

    if (jivaEvent.eventType === 'ambulance.dispatched') {
      const { ambulanceId, caseId } = jivaEvent.payload;
      const existing = await d.store.getAmbulance(ambulanceId);

      if (existing) {
        const newJourney = !!caseId && caseId !== existing.assignedPatient;
        await d.store.setAmbulance({
          ...existing,
          status: 'DISPATCHED',
          assignedPatient: caseId || existing.assignedPatient,
          destinationHospital: newJourney ? undefined : existing.destinationHospital,
          activeRoute: newJourney ? undefined : existing.activeRoute,
          lastUpdated: jivaEvent.timestamp,
          provenance: [...existing.provenance, {
            sourceType: jivaEvent.source.type,
            sourceId: jivaEvent.source.id,
            eventId: jivaEvent.eventId,
            timestamp: jivaEvent.timestamp,
            confidence: jivaEvent.metadata?.confidence || 1.0,
          }].slice(-50),
        });
        if (caseId) {
          const patient = await d.store.getPatient(caseId);
          if (patient) await d.store.setPatient({ ...patient, assignedAmbulance: ambulanceId, lastUpdated: jivaEvent.timestamp });
          // A hospital may have accepted before the ambulance was dispatched.
          await ensureDestination(d, ambulanceId, 'Destination assigned from existing acceptance');
        }
      }
    } else if (jivaEvent.eventType === 'ambulance.location.updated') {
      const { ambulanceId, coordinates, heading, speedKmh } = jivaEvent.payload;
      const existing = await d.store.getAmbulance(ambulanceId);

      if (existing) {
        await d.store.setAmbulance({
          ...existing,
          currentLocation: coordinates,
          heading,
          speedKmh,
          lastUpdated: new Date().toISOString(),
        });
      }
    }

    return { status: 'processed' };
  };
}
