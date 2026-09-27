import type { DataStatus } from '@jiva/domain-models';
import type { AnyEvent } from '@jiva/event-schema';
import type { EvidenceEnvironment } from '@jiva/feasibility';

/**
 * EVIDENCE TRUST BOUNDARY
 * -----------------------
 * The provenance grade the feasibility engine reads for LIVE evidence (hospital capacity updates,
 * acceptance responses) is never taken from the submitter. It is DERIVED here, at the trusted
 * ingestion adapter (local API `POST /api/events`, AWS ingestion lambda), from things the client
 * cannot forge: the authenticated principal, whether that principal is a demo persona, and the
 * deployment environment. The result is stamped into `event.metadata.trustedEvidence`, overwriting
 * anything the client sent there.
 *
 * Ignored on purpose: `metadata.sourceType`, `payload.source`, `payload.responderRole` and any
 * other claim such as "AUTHORIZED_FEED" or "hospital-confirmed". They are kept as informational
 * legacy fields and never upgrade evidence.
 *
 *   environment   principal                          derived status
 *   ------------  ---------------------------------  -----------------
 *   DEMO          demo persona (any role)            SYNTHETIC_DEMO
 *   PRODUCTION    demo persona                       UNVERIFIED  (demo auth is not production identity)
 *   any           real (non-demo) HOSPITAL principal HOSPITAL_CONFIRMED (only for its own facility; enforced by authorizeEventSubmission)
 *   any           anything else                      UNVERIFIED
 *   any           server-configured feed adapter     AUTHORIZED_FEED  (only via the `adapter` argument, which only server code can set)
 *
 * The engine additionally refuses SYNTHETIC_DEMO as operational evidence when its policy's
 * evidenceEnvironment is PRODUCTION (see @jiva/feasibility isOperationalGrade).
 */

/** Deployment environment. Explicit JIVA_ENVIRONMENT wins; a Lambda runtime defaults to PRODUCTION (fail safe). */
export function evidenceEnvironment(): EvidenceEnvironment {
  const raw = (process.env.JIVA_ENVIRONMENT || '').toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'PRODUCTION';
  if (raw === 'demo') return 'DEMO';
  return process.env.AWS_LAMBDA_FUNCTION_NAME ? 'PRODUCTION' : 'DEMO';
}

export interface TrustPrincipal { role: string; isDemo?: boolean }

export function deriveTrustedStatus(
  principal: TrustPrincipal,
  environment: EvidenceEnvironment,
  adapter?: 'AUTHORIZED_FEED'
): DataStatus {
  if (adapter === 'AUTHORIZED_FEED') return 'AUTHORIZED_FEED';
  if (principal.isDemo) return environment === 'DEMO' ? 'SYNTHETIC_DEMO' : 'UNVERIFIED';
  if (principal.role === 'HOSPITAL') return 'HOSPITAL_CONFIRMED';
  return 'UNVERIFIED';
}

/** Event types whose payload becomes live operational evidence. */
const LIVE_EVIDENCE_EVENTS = new Set(['hospital.acceptance.received', 'hospital.capacity.updated']);

/**
 * Stamp (or strip) trusted provenance on an event received from a client. MUST be called after
 * schema validation and authorization, before the event is recorded or published.
 */
export function stampTrustedEvidence<E extends AnyEvent>(
  event: E,
  principal: TrustPrincipal,
  environment: EvidenceEnvironment = evidenceEnvironment(),
  adapter?: 'AUTHORIZED_FEED'
): E {
  const live = LIVE_EVIDENCE_EVENTS.has(event.eventType);
  if (!live && !event.metadata) return event;
  const meta = { ...(event.metadata ?? { sourceType: 'server-stamped' }) } as NonNullable<AnyEvent['metadata']>;
  delete (meta as { trustedEvidence?: unknown }).trustedEvidence; // never accept a client-supplied stamp
  if (live) {
    meta.trustedEvidence = { status: deriveTrustedStatus(principal, environment, adapter) as 'SYNTHETIC_DEMO' | 'HOSPITAL_CONFIRMED' | 'AUTHORIZED_FEED' | 'UNVERIFIED', environment };
  }
  return { ...event, metadata: meta };
}
