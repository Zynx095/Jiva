/**
 * The demo portal's ten scenarios, run against a REAL API process (:4106) with the very step definitions
 * the portal uses (apps/demo-portal/src/workflows.ts). Every step is a real API call as a demo persona and
 * succeeds only when the server confirms the outcome; this suite fails if any scenario cannot be completed
 * through the supported backend workflows. Afterwards the routing invariants still hold: the decision
 * authority is SHADOW and no unexpected shadow disagreement appeared.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { io } from 'socket.io-client';
import { check, results, startApi } from './helpers/api';
import { SCENARIOS, newContext, type Deps } from '../../apps/demo-portal/src/workflows';
import { classifyDisagreements, type ShadowDisagreement } from '../../scripts/lib/shadowReport';

async function main() {
  console.log('[Test] Demo portal scenarios against a real API on :4106');
  const documentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-portal-docs-'));
  // A 1 s expiry check keeps the referral-expiry scenario short; everything else is the default configuration.
  const api = await startApi(4106, { JIVA_DOCUMENT_DIR: documentDir, ACCEPTANCE_EXPIRY_CHECK_MS: '1000' });
  // The portal's own live connection (it reconnects by itself, like every JIVA screen).
  const live = io(api.url, { auth: { demoUser: 'demo-admin' }, transports: ['websocket'], reconnectionDelay: 500, reconnectionDelayMax: 2000 });
  const deps: Deps = {
    call: async (persona, method, p, body) => {
      const r = await api.req(method, p, persona, body);
      return { status: r.status, ok: r.status >= 200 && r.status < 300, body: r.json };
    },
    realtimeConnected: () => live.connected,
  };
  try {
    await api.waitFor(async () => live.connected, 10_000);
    for (const scenario of SCENARIOS) {
      const ctx = newContext();
      const t0 = Date.now();
      let failedAt: string | undefined;
      let reason = '';
      for (const step of scenario.steps) {
        try {
          await step.run(ctx, deps);
        } catch (err) {
          failedAt = step.title;
          reason = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      check(`scenario "${scenario.title}" completes through real workflows (${scenario.steps.length} steps, ${((Date.now() - t0) / 1000).toFixed(1)} s)`, !failedAt, `failed at "${failedAt}": ${reason}`);
    }

    const shadow = (await api.get('demo-mgmt-1', '/api/feasibility/shadow')).json;
    const unexpected = classifyDisagreements((shadow?.disagreements ?? []) as ShadowDisagreement[]).filter(d => d.classification === 'UNEXPECTED_DISAGREEMENT');
    check('decision authority is still SHADOW after every scenario', shadow?.authority?.mode === 'SHADOW', JSON.stringify(shadow?.authority));
    check('no unexpected shadow disagreement across the scenarios (routing behaviour unchanged)', unexpected.length === 0, JSON.stringify(unexpected).slice(0, 400));
    // Each resetting scenario clears the demo audit trail too; what remains is the last one's plus the fault injection.
    const audit = (await api.get('demo-admin', '/api/audit?limit=2000')).json?.entries as Array<{ action: string; outcome: string }>;
    const expected = ['emergency.report', 'prehospital.record', 'encounter.arrival.record', 'encounter.handover.record', 'encounter.doctor.assign', 'prescription.draft', 'prescription.authorise', 'demo.realtime.interrupt'];
    const missing = expected.filter(a => !audit.some(x => x.action === a && x.outcome === 'ALLOWED'));
    check('the last scenarios left a real, content-free audit trail (intake, arrival, handover, doctor, draft, authorisation, fault injection)', missing.length === 0, `missing: ${missing.join(', ')}`);
    check('API process still healthy at the end', (await api.get(undefined, '/api/health')).status === 200);
  } finally {
    live.close();
    api.stop();
    try {
      fs.rmSync(documentDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  const { passes, failures } = results();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('✓ Demo portal scenarios PASSED.');
  process.exit(0);
}

main().catch(err => { console.error('✗ Demo portal scenarios crashed:', err); process.exit(1); });
