import { stampTrustedEvidence } from '../../evidenceTrust';
import { CognitoAuthProvider } from '@jiva/auth';
import type { AuthContext } from '@jiva/auth';
import { AnyEvent, AnyEventSchema } from '@jiva/event-schema';
import type { IStateStore } from '../../infrastructure/stateStore/types';
import { authorizeEventSubmission } from '../../authorizationPolicy';
import { loadLedger } from './deps';
import { checkReferralAnswer, type OpenReferral } from '../../acceptanceCorrelation';

export interface IngestionDeps {
  /** Puts one event on the bus (AWS: EventBridge PutEvents). */
  put: (entry: { detailType: string; time: Date; detail: string; resource: string }) => Promise<void>;
  /** Needed only for the acceptance-correlation guard. */
  store: IStateStore;
  now?: () => number;
  /** Test hook / API Gateway adapter: resolves the caller from the request. */
  authenticate?: (event: any) => AuthContext | undefined;
}

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** Default: claims injected by API Gateway's Cognito authorizer. */
export function authenticateFromApiGateway(event: any): AuthContext | undefined {
  const claims = event?.requestContext?.authorizer?.claims;
  if (!claims) return undefined;
  const result = CognitoAuthProvider.parseClaims(claims);
  return result.authenticated ? result.context : undefined;
}

/**
 * AWS event ingestion with the SAME submission rules as the local API (POST /api/events):
 *  1. authenticated caller (Cognito claims)          -> 401
 *  2. schema validation (AnyEventSchema)              -> 400 unknown_event_type / validation_failed
 *  3. no future timestamps (> 60 s)                   -> 400
 *  4. RBAC: only external event types, source/scope   -> 403 (system-generated events, including
 *     matching the caller                                feasibility.trace.recorded, are never submittable)
 *  5. acceptance correlation: a hospital may only     -> 409 no_outstanding_request / request_mismatch,
 *     answer the open request it received, by its id     400 on an impossible validity window
 */
export function createIngestionHandler(d: IngestionDeps) {
  return async (event: any) => {
    const now = d.now ? d.now() : Date.now();
    const auth = (d.authenticate || authenticateFromApiGateway)(event);
    if (!auth) return json(401, { error: 'unauthenticated' });

    let body: any;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch {
      return json(400, { error: 'invalid_body', message: 'Body is not valid JSON.' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json(400, { error: 'invalid_body', message: 'Expected a JSON event object.' });
    }
    if (!body.eventId || !body.eventType) {
      return json(400, { error: 'invalid_event', message: 'eventId and eventType are required.' });
    }

    const parsed = AnyEventSchema.safeParse(body);
    if (!parsed.success) {
      const unknownType = parsed.error.issues.some(i => i.code === 'invalid_union_discriminator');
      return json(400, {
        error: unknownType ? 'unknown_event_type' : 'validation_failed',
        issues: parsed.error.issues.slice(0, 10).map(i => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const parsedEvent = parsed.data as AnyEvent;

    if (Date.parse(parsedEvent.timestamp) > now + 60_000) {
      return json(400, { error: 'validation_failed', issues: [{ path: 'timestamp', message: 'Timestamp is in the future' }] });
    }

    const denial = authorizeEventSubmission(auth, parsedEvent);
    if (denial) return json(403, { error: 'forbidden', message: denial });

    if (parsedEvent.eventType === 'hospital.acceptance.received') {
      // Same correlation contract as the local API (services/api/src/acceptanceCorrelation.ts): an open
      // referral for this case and hospital, answered by its own requestId, with a possible validity window.
      const { caseId, hospitalId } = parsedEvent.payload;
      let open: OpenReferral | undefined;
      const rec = d.store.getAcceptanceRecord ? await d.store.getAcceptanceRecord(caseId, hospitalId) : undefined;
      if (rec?.request) {
        open = rec.request;
      } else {
        const view = (await loadLedger(d.store, caseId)).view(caseId, hospitalId, now);
        open = view.request && view.requestState === 'OUTSTANDING' ? view.request : undefined;
      }
      const verdict = checkReferralAnswer(open, parsedEvent.payload, now);
      if (!verdict.ok) return json(verdict.status, { error: verdict.error, message: verdict.message });
    }

    // Publish the VALIDATED event (as the local API does), enriched with correlation/causation ids.
    // Trust boundary: provenance is derived from the authenticated principal, never from the payload.
    const anyEvent = stampTrustedEvidence(parsedEvent, auth) as AnyEvent & { correlationId?: string; causationId?: string; patientId?: string };
    const correlationId = anyEvent.correlationId || (anyEvent.payload as { caseId?: string })?.caseId || anyEvent.patientId || anyEvent.eventId;
    const causationId = anyEvent.causationId || anyEvent.eventId;
    await d.put({
      detailType: anyEvent.eventType,
      time: new Date(anyEvent.timestamp),
      detail: JSON.stringify({ ...anyEvent, correlationId, causationId }),
      resource: correlationId,
    });
    return json(202, { status: 'accepted', eventId: anyEvent.eventId });
  };
}
