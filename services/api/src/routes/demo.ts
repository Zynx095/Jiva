import { Router, type Request } from 'express';
import type { AuthContext } from '@jiva/auth';
import { z } from 'zod';
import { runtimeMode } from '../mode';
import { audit, validationError } from '../commands/support';

type AuthedRequest = Request & { auth?: AuthContext };

/**
 * Realtime fault injection for demonstrations (DEMO mode only).
 *
 * "Interrupt realtime" closes every live Socket.IO connection and refuses new ones for a short window, so
 * the screens show that they lost the live connection, keep their last known state, retry, and recover by
 * themselves when the window ends. It is a real interruption of the real channel, not a simulated screen
 * state. The REST API keeps answering; a full API outage is demonstrated by stopping the API process.
 */
let interruptedUntil = 0;
let closeConnections: (() => number) | undefined;

/** index.ts registers how to drop the live connections (it owns the Socket.IO server). */
export function registerRealtimeConnections(close: () => number): void {
  closeConnections = close;
}

export const realtimeInterrupted = (now = Date.now()) => now < interruptedUntil;

export function interruptRealtime(seconds: number, now = Date.now()): { until: string; closed: number } {
  interruptedUntil = now + seconds * 1000;
  return { until: new Date(interruptedUntil).toISOString(), closed: closeConnections?.() ?? 0 };
}

export function resetDemoFaults(): void {
  interruptedUntil = 0;
}

const InterruptCommandSchema = z.object({ seconds: z.number().int().min(5).max(60) }).strict();

export function demoRouter(): Router {
  const router = Router();

  router.post('/demo/realtime-interruption', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    // Demo tooling does not exist in operational mode.
    if (runtimeMode() !== 'DEMO') return res.status(404).json({ error: 'not_found' });
    if (auth.role !== 'ADMIN') {
      audit(auth, 'demo.realtime.interrupt', 'DENIED', { entityType: 'DEMO', reasonCode: 'ADMIN_ONLY' });
      return res.status(403).json({ error: 'forbidden', code: 'ADMIN_ONLY', message: 'Only the demo administrator may interrupt realtime delivery' });
    }
    const parsed = InterruptCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const result = interruptRealtime(parsed.data.seconds);
    audit(auth, 'demo.realtime.interrupt', 'ALLOWED', { entityType: 'DEMO' });
    return res.status(200).json({ status: 'interrupted', ...result, seconds: parsed.data.seconds });
  });

  router.get('/demo/realtime-interruption', (req: AuthedRequest, res) => {
    if (runtimeMode() !== 'DEMO') return res.status(404).json({ error: 'not_found' });
    res.json({ interrupted: realtimeInterrupted(), until: interruptedUntil ? new Date(interruptedUntil).toISOString() : null });
  });

  return router;
}
