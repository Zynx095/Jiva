import { Router, type Request } from 'express';
import type { AuthContext } from '@jiva/auth';
import { ambulanceCase, relatedCases } from '../authorization';
import { referralOverview } from '../referrals';
import { asyncRoute } from '../commands/support';

type AuthedRequest = Request & { auth?: AuthContext };

/**
 * GET /api/cases/:id/referrals — the case's referral overview (see referrals.ts).
 *   management / admin    → every connected hospital
 *   the case's own crew   → every connected hospital (it needs to know who can take the patient)
 *   a hospital involved   → its own row only (never other hospitals' answers)
 *   patients              → 403: hospitals' answers and limits are operational detail, not shared with patients
 */
export function referralRouter(): Router {
  const router = Router();
  router.get('/cases/:id/referrals', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const caseId = String(req.params.id);
    const privileged = auth.role === 'ADMIN' || auth.role === 'MANAGEMENT';
    const crew = auth.role === 'AMBULANCE' && !!auth.ambulanceId && ambulanceCase(auth.ambulanceId) === caseId;
    const hospital = auth.role === 'HOSPITAL' && !!auth.hospitalId && relatedCases(auth).has(caseId);
    if (auth.role === 'PATIENT') return res.status(403).json({ error: 'forbidden', message: 'Hospital answers are shared with the coordinating team, not with patients.' });
    if (!privileged && !crew && !hospital) return res.status(404).json({ error: 'not_found' });
    const overview = await referralOverview(caseId);
    if (!overview) return res.status(404).json({ error: 'not_found' });
    if (hospital) overview.rows = overview.rows.filter(r => r.hospitalId === auth.hospitalId);
    res.json(overview);
  }));
  return router;
}
