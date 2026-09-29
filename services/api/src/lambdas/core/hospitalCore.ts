import {
  AcceptanceResponsePayload,
  CapacityUpdatePayload,
  applyAcceptanceResponse,
  applyCapacityUpdate,
  capacityHasUnavailable,
  capacityLossAffectsCase,
} from '../../stateTransitions';
import { observeValue } from '../../feasibility/containment';
import { withTrust } from '../../feasibility/acceptanceLedger';
import { LambdaDeps, loadLedger, nowMs } from './deps';
import { ensureDestination, reroutePredicate } from './routingCore';

/**
 * AWS hospital processor. Applies acceptance responses and capacity updates with the SAME pure
 * transition rules as the local engine (stateTransitions.ts), then performs the same destination
 * assignment / rerouting. Semantics preserved from local:
 *  - duplicate responseId (redelivered under a new eventId) -> ignored
 *  - response older than the applied one -> ignored (never overwrites)
 *  - ACCEPTED/LIMITED already past validUntil -> ignored (not current evidence)
 *  - capacity update older than the applied one -> ignored
 */
export function createHospitalHandler(d: LambdaDeps) {
  return async (event: { 'detail-type'?: string; detail: any }) => {
    const jivaEvent = event.detail;
    console.log(`[Lambda:HospitalProcessor] Processing ${event['detail-type']} (${jivaEvent.eventId})`);

    const recordResult = await d.store.recordEvent(jivaEvent);
    if (recordResult.isDuplicate) {
      console.log(`[Lambda:HospitalProcessor] Skipping duplicate event ${jivaEvent.eventId}`);
      return { status: 'duplicate_skipped' };
    }

    if (jivaEvent.eventType === 'hospital.acceptance.received') {
      const p = jivaEvent.payload as AcceptanceResponsePayload;
      const existing = await d.store.getHospital(p.hospitalId);
      if (!existing) return { status: 'unknown_hospital' };

      // Duplicate responseId under a new eventId: only the earliest event with that id counts.
      // This check reads history through the (auxiliary) ledger replay. If that read fails
      // (throttling, missing history) the legacy decision must still complete, so the check
      // degrades to "not a known duplicate": applying the same response twice is idempotent
      // (applyAcceptanceResponse is deterministic and its stale watermark protects newer state).
      let duplicate = false;
      try {
        const prior = await loadLedger(d.store, p.caseId, { timestamp: jivaEvent.timestamp, eventId: jivaEvent.eventId });
        duplicate = prior.hasProcessedResponse(p.responseId);
      } catch (err) {
        console.warn(`[Acceptance] Duplicate check unavailable (${err instanceof Error ? err.message : String(err)}); continuing with legacy handling.`);
      }
      if (duplicate) {
        console.warn(`[Acceptance] Duplicate response ${p.responseId} ignored.`);
        return { status: 'duplicate_response_ignored' };
      }

      // NOT observational: the materialized index is what evaluateHospitals' acceptanceOverride
      // reads to decide real eligibility (fixes the legacy one-slot bug), so this write is part of
      // the core decision path now, exactly like d.store.setHospital(...) below -- never contained.
      // A failure here throws out of the handler, which Lambda/EventBridge retries, same as any
      // other core store write in this function.
      await d.store.putAcceptanceResponse?.(p.caseId, p.hospitalId, withTrust(p as never, jivaEvent.metadata));

      const applied = applyAcceptanceResponse(existing, p, { sourceType: jivaEvent.source.type, sourceId: jivaEvent.source.id }, nowMs(d));
      if (applied.kind === 'IGNORED') {
        console.warn(applied.reason === 'STALE'
          ? `[Acceptance] Stale response from ${p.hospitalId} (${p.respondedAt} < ${existing.operationalState.acceptanceAsOf}) ignored.`
          : `[Acceptance] Response ${p.responseId} from ${p.hospitalId} arrived already expired; ignored.`);
        return { status: applied.reason === 'STALE' ? 'stale_ignored' : 'expired_ignored' };
      }
      await d.store.setHospital(applied.next);

      if (p.status === 'ACCEPTED' || p.status === 'LIMITED') {
        for (const amb of await d.store.listAmbulances()) {
          if (amb.assignedPatient === p.caseId && !amb.destinationHospital) {
            await ensureDestination(d, amb.ambulanceId, `Hospital ${p.hospitalId} ${p.status} the acceptance request`);
          }
        }
      } else if (p.status === 'REJECTED') {
        await reroutePredicate(d, a => a.assignedPatient === p.caseId, p.hospitalId, `Destination ${p.hospitalId} REJECTED the case`);
      } else if (p.status === 'UNAVAILABLE') {
        await reroutePredicate(d, () => true, p.hospitalId, `Destination ${p.hospitalId} reported UNAVAILABLE`);
      }
    } else if (jivaEvent.eventType === 'hospital.acceptance.cancelled') {
      const p = jivaEvent.payload as { requestId: string; caseId: string; hospitalId: string; cancelledAt: string };
      await observeValue('materialize.cancellation', () => d.store.putAcceptanceCancellation?.(p.caseId, p.hospitalId, p.requestId, p.cancelledAt), undefined);
    } else if (jivaEvent.eventType === 'hospital.capacity.updated') {
      const p = jivaEvent.payload as CapacityUpdatePayload;
      const existing = await d.store.getHospital(p.hospitalId);
      if (!existing) return { status: 'unknown_hospital' };
      const applied = applyCapacityUpdate(existing, p, jivaEvent, nowMs(d));
      if (applied.kind === 'IGNORED') {
        console.warn(`[Capacity] Stale capacity update for ${p.hospitalId} (${jivaEvent.timestamp} < ${existing.operationalState.capacityAsOf}) ignored.`);
        return { status: 'stale_ignored' };
      }
      await d.store.setHospital(applied.next);

      if (capacityHasUnavailable(p)) {
        // Only reroute when the lost capability is one the case actually needs.
        await reroutePredicate(
          d,
          async a => capacityLossAffectsCase(p, (await d.store.getPatient(a.assignedPatient || ''))?.careRequirements || []),
          p.hospitalId,
          `Destination ${p.hospitalId} capacity became UNAVAILABLE`
        );
      }
    }
    // hospital.acceptance.requested / .expired: recorded above; no further state change.

    // SHADOW-ONLY, after the legacy decision: is each destination currently held at this hospital
    // still feasible? Contained and time-bounded; never triggers routing.
    if (d.shadow && (jivaEvent.eventType === 'hospital.acceptance.received' || jivaEvent.eventType === 'hospital.capacity.updated')) {
      const shadow = d.shadow;
      const hospitalId = jivaEvent.payload?.hospitalId as string | undefined;
      await observeValue('shadow.current-destination', async () => {
        for (const amb of await d.store.listAmbulances()) {
          if (!hospitalId || amb.destinationHospital !== hospitalId || !amb.assignedPatient || !amb.currentLocation) continue;
          await shadow.observeDestination({
            caseId: amb.assignedPatient,
            hospitalId,
            trigger: { eventId: jivaEvent.eventId, eventType: jivaEvent.eventType, sourceId: jivaEvent.source?.id || 'unknown', sourceType: jivaEvent.source?.type },
            origin: amb.currentLocation,
            originAsOf: amb.locationAsOf,
            ambulanceId: amb.ambulanceId,
          });
        }
      }, undefined);
    }

    return { status: 'processed' };
  };
}
