/**
 * PURE correlation rules for a hospital's answer to a referral, shared by the local API
 * (POST /api/events) and the AWS ingestion lambda so both enforce exactly the same contract:
 *
 *  1. The hospital must have an OPEN referral for this case: requested, not cancelled, not past its deadline.
 *  2. The answer must name THAT referral (requestId). An answer to another case or to a stale or invented
 *     request id is refused, so an acceptance can never be attributed to the wrong emergency.
 *  3. The answer's own times must be possible: respondedAt not in the future; an ACCEPTED/LIMITED answer
 *     must stay valid for some time after it was given, and for at most MAX_ACCEPTANCE_VALIDITY_MS.
 *
 * Ordering, duplicates and expiry-on-arrival keep their existing (frozen) handling downstream.
 */
export const MAX_ACCEPTANCE_VALIDITY_MS = 6 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 60_000;

export interface OpenReferral {
  requestId: string;
  expiresAt: string;
  cancelledAt?: string;
}

export interface ReferralAnswer {
  requestId: string;
  status: string;
  respondedAt: string;
  validUntil: string;
}

export type CorrelationResult =
  | { ok: true }
  | { ok: false; status: 400 | 409; error: string; message: string };

export function checkReferralAnswer(open: OpenReferral | undefined, answer: ReferralAnswer, nowMs: number): CorrelationResult {
  if (!open || open.cancelledAt || !(Date.parse(open.expiresAt) > nowMs)) {
    return { ok: false, status: 409, error: 'no_outstanding_request', message: 'No open acceptance request for this case and hospital.' };
  }
  if (answer.requestId !== open.requestId) {
    return { ok: false, status: 409, error: 'request_mismatch', message: `This answer names request ${answer.requestId}, but the open request for this case and hospital is ${open.requestId}.` };
  }
  const responded = Date.parse(answer.respondedAt);
  const validUntil = Date.parse(answer.validUntil);
  if (!Number.isFinite(responded) || responded > nowMs + FUTURE_SKEW_MS) {
    return { ok: false, status: 400, error: 'validation_failed', message: 'respondedAt is missing or in the future.' };
  }
  if (answer.status === 'ACCEPTED' || answer.status === 'LIMITED') {
    if (!Number.isFinite(validUntil) || validUntil <= responded) {
      return { ok: false, status: 400, error: 'validation_failed', message: 'An acceptance must remain valid after it is given (validUntil > respondedAt).' };
    }
    if (validUntil - responded > MAX_ACCEPTANCE_VALIDITY_MS) {
      return { ok: false, status: 400, error: 'validation_failed', message: 'An acceptance may be valid for at most 6 hours; send a new answer instead.' };
    }
  }
  return { ok: true };
}
