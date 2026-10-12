import type { AuthContext } from '@jiva/auth';
import type { AnyEvent } from '@jiva/event-schema';
import { stampTrustedEvidence } from './evidenceTrust';
import { stateStore } from './stateStore';
import { eventBus } from './eventBus';

/**
 * The tail of the ingestion pipeline shared by `POST /api/events` and the command endpoints, for an
 * event that has ALREADY been schema-validated and authorized:
 *   trust stamp (provenance from the principal, never the payload) → ledger (idempotent by eventId) → bus.
 */
export async function recordAndPublish(auth: AuthContext, event: AnyEvent): Promise<{ duplicate: boolean; event: AnyEvent }> {
  const stamped = stampTrustedEvidence(event, auth);
  const recordResult = await stateStore.recordEvent(stamped);
  if (recordResult.isDuplicate) return { duplicate: true, event: stamped };
  await eventBus.publish(stamped);
  return { duplicate: false, event: stamped };
}
