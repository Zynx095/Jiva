import { Router, type Request } from 'express';
import type { AuthContext } from '@jiva/auth';
import { clinicalStore } from '../clinical';
import { authorizeAuditRead } from '../clinical/policy';
import { audit, denied } from '../commands/support';

type AuthedRequest = Request & { auth?: AuthContext };

const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The audit log (platform administrators only): who did what to which record, when, and whether it was
 * allowed. Entries never contain record content (no medication, finding, value or file), only
 * identifiers, the action, the outcome and a machine-readable reason. Reading the log is itself audited.
 */
export function auditRouter(): Router {
  const router = Router();
  router.get('/audit', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const decision = authorizeAuditRead(auth);
    if (!decision.allowed) {
      audit(auth, 'audit.read', 'DENIED', { entityType: 'AUDIT', reasonCode: decision.code });
      return denied(res, decision);
    }
    const encounterId = typeof req.query.encounterId === 'string' ? req.query.encounterId : undefined;
    const caseId = typeof req.query.caseId === 'string' ? req.query.caseId : undefined;
    if ((encounterId && !ID.test(encounterId)) || (caseId && !ID.test(caseId))) {
      return res.status(400).json({ error: 'validation_failed', issues: [{ path: 'query', message: 'Invalid identifier' }] });
    }
    const raw = parseInt(String(req.query.limit ?? '200'), 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 2000) : 200;
    const entries = clinicalStore.listAudit({ encounterId, caseId, limit });
    audit(auth, 'audit.read', 'ALLOWED', { entityType: 'AUDIT', ...(encounterId ? { encounterId } : {}), ...(caseId ? { caseId } : {}) });
    res.json({ entries, count: entries.length, limit });
  });
  return router;
}
