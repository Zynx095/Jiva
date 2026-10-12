import { createHash, randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ZodError } from 'zod';
import type { AuthContext } from '@jiva/auth';
import type { AuditRecord } from '@jiva/domain-models';
import { canonicalJson } from '@jiva/feasibility';
import { clinicalStore } from '../clinical';
import { actorFromAuth, type Decision } from '../clinical/policy';

/**
 * Shared plumbing for command endpoints: structured errors, idempotency, per-key serialization and the
 * content-free audit log.
 */

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Allowance for client clocks: a client-supplied time may be at most this far in the future. */
export const CLOCK_SKEW_MS = 60_000;

/**
 * Express 4 does not pass a rejected async handler to the error middleware: the request would hang and the
 * rejection would only be logged. Command handlers are wrapped so a failure answers 500 (no details).
 */
export function asyncRoute<Req extends Request>(fn: (req: Req, res: Response) => Promise<unknown>) {
  return (req: Req, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

/** 400 with field-level issues (messages come from the schema, never echo the submitted values). */
export function validationError(res: Response, error: ZodError) {
  return res.status(400).json({
    error: 'validation_failed',
    issues: error.issues.slice(0, 20).map(i => ({ path: i.path.join('.'), message: i.message })),
  });
}

export function denied(res: Response, decision: Extract<Decision, { allowed: false }>) {
  return res.status(decision.status).json(decision.status === 404 ? { error: 'not_found' } : { error: 'forbidden', code: decision.code, message: decision.reason });
}

export function conflict(res: Response, code: string, message: string, extra: Record<string, unknown> = {}) {
  return res.status(409).json({ error: code, message, ...extra });
}

// ------------------------------------------------------------------ idempotency

/**
 * A command retried with the same clientRequestId gets the original response (no second record).
 * Reusing a clientRequestId for a DIFFERENT request is refused, so a stale key can never silently
 * apply someone's earlier action.
 */
export function idempotent(scope: string, auth: AuthContext, clientRequestId: string, body: unknown) {
  const key = `${scope}|${auth.userId}|${clientRequestId}`;
  const fingerprint = sha256Hex(canonicalJson(body));
  return {
    /** Previously stored response for this exact request, or a conflict marker. */
    replay(): { status: number; body: unknown } | 'KEY_REUSED' | undefined {
      const prior = clinicalStore.getCommandResult(key);
      if (!prior) return undefined;
      return prior.fingerprint === fingerprint ? { status: prior.status, body: prior.body } : 'KEY_REUSED';
    },
    remember(status: number, responseBody: unknown) {
      clinicalStore.putCommandResult(key, { fingerprint, status, body: responseBody });
    },
  };
}

export function replayOr(res: Response, idem: ReturnType<typeof idempotent>): boolean {
  const r = idem.replay();
  if (r === 'KEY_REUSED') {
    res.status(422).json({ error: 'idempotency_key_reused', message: 'This clientRequestId was already used for a different request.' });
    return true;
  }
  if (r) {
    res.status(r.status).json(r.body);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ serialization

const locks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` exclusively for `key` (e.g. one encounter): check-then-act sequences of concurrent requests
 * cannot interleave, so two users cannot both record the same handover.
 */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.catch(() => undefined);
  locks.set(key, settled);
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

// ------------------------------------------------------------------ audit

const lastAccess = new Map<string, number>();
const ACCESS_AUDIT_WINDOW_MS = 60_000;

/**
 * Read access to clinical records is audited as well (who looked at which encounter's records). Screens
 * refresh often, so one reader's repeated reads of the same records are recorded at most once a minute.
 */
export function auditAccess(auth: AuthContext, action: string, target: Omit<AuditRecord, 'auditId' | 'at' | 'actor' | 'action' | 'outcome'>): void {
  const key = `${auth.userId}|${action}|${target.entityId ?? target.encounterId ?? ''}`;
  const now = Date.now();
  if ((lastAccess.get(key) ?? 0) > now - ACCESS_AUDIT_WINDOW_MS) return;
  if (lastAccess.size > 10_000) lastAccess.clear();
  lastAccess.set(key, now);
  audit(auth, action, 'ALLOWED', target);
}

export function resetAccessAudit(): void {
  lastAccess.clear();
}

export function audit(
  auth: AuthContext,
  action: string,
  outcome: AuditRecord['outcome'],
  target: Omit<AuditRecord, 'auditId' | 'at' | 'actor' | 'action' | 'outcome'>,
): void {
  clinicalStore.appendAudit({ auditId: randomUUID(), at: new Date().toISOString(), actor: actorFromAuth(auth), action, outcome, ...target });
}
