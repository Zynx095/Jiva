/**
 * Acceptance responses must name the request they answer (the feasibility engine ignores any
 * response that does not). Simulations therefore never invent a requestId: they read the one the
 * request flow actually generated (hospital.acceptance.requested) from the event history.
 */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** apiBase example: http://localhost:4000 (no trailing /api). Reads history as the demo management persona. */
export async function requestIdFor(apiBase: string, caseId: string, hospitalId: string, timeoutMs = 15000): Promise<string> {
  const base = apiBase.replace(/\/$/, '').replace(/\/api(\/events)?$/, '');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${base}/api/events/history?limit=1000`, { headers: { 'x-jiva-demo-user': 'demo-mgmt-1' } });
      if (res.ok) {
        const history: any[] = await res.json(); // newest first
        const req = history.find(e => e.eventType === 'hospital.acceptance.requested' && e.payload?.caseId === caseId && e.payload?.hospitalId === hospitalId);
        if (req) return req.payload.requestId as string;
      }
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error(`No acceptance request was issued to ${hospitalId} for ${caseId}; refusing to send a response with an invented requestId.`);
}
