/**
 * Phase 11 — a REAL API process in OPERATIONAL mode (JIVA_ENVIRONMENT=production, :4102): no synthetic
 * network, clinicians or simulator; demo personas refused everywhere (HTTP and realtime); the health
 * report states the mode and that no live integration exists.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { check, results, ROOT, startApi } from './helpers/api';

/** Start the API with `env` and wait for it to exit (or give up after `ms`). */
function runUntilExit(env: Record<string, string | undefined>, ms = 40_000): Promise<{ code: number | null; log: string }> {
  return new Promise(resolve => {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) merged[k] = v; // undefined = unset
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'services/api/src/index.ts'], { cwd: ROOT, env: merged, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout?.on('data', d => { log += d; });
    child.stderr?.on('data', d => { log += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: null, log }); }, ms);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, log }); });
  });
}

async function main() {
  console.log('[Test] Operational mode against a real API on :4102');
  const documentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-operational-docs-'));
  const api = await startApi(4102, { JIVA_ENVIRONMENT: 'production', JIVA_DOCUMENT_DIR: documentDir });
  try {
    const health = await api.get(undefined, '/api/health');
    const p = health.json?.provenance;
    check('health reports OPERATIONAL mode and no demo authentication', health.json?.mode === 'OPERATIONAL' && health.json?.demoAuth === false, health.text.slice(0, 300));
    check('no synthetic network was loaded (0 hospitals, 0 ambulances)', p?.datasets?.network?.hospitals === 0 && p.datasets.network.ambulances === 0);
    check('no synthetic clinicians, no simulator', p?.datasets?.clinicians?.count === 0 && p.datasets.clinicians.dataStatus === 'NONE' && p.providers?.telemetry?.simulator === false);
    check('no live integration is claimed', p && Object.values(p.liveIntegrations).every(v => v === false));
    check('the statement says unknowns stay unknown', /unknown/i.test(p?.statement ?? ''));

    for (const [method, route] of [['GET', '/api/patients'], ['GET', '/api/hospitals'], ['POST', '/api/emergencies'], ['POST', '/api/demo/reset'], ['GET', '/api/encounters']] as const) {
      const r = await api.req(method, route, 'demo-admin', method === 'POST' ? {} : undefined);
      check(`demo persona refused: ${method} ${route} → 401`, r.status === 401, `${r.status}`);
    }
    check('responses are never cached', (await api.get('demo-admin', '/api/patients')).headers.get('cache-control') === 'no-store');
    const sock = await api.socket('demo-patient-1');
    check('a demo realtime handshake is refused', !!sock.error, sock.error ?? 'connected');
    sock.s.close();
    check('API process still healthy at the end', (await api.get(undefined, '/api/health')).status === 200);
  } finally {
    api.stop();
    try {
      fs.rmSync(documentDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  // An insecure configuration fails closed: "production" without operational mode would accept demo personas.
  const insecure = await runUntilExit({ PORT: '4103', ENVIRONMENT: 'production', NODE_ENV: 'production', JIVA_ENVIRONMENT: undefined, AWS_LAMBDA_FUNCTION_NAME: undefined, MAPPING_PROVIDER: 'mock', JIVA_DOCUMENT_DIR: documentDir });
  check('ENVIRONMENT=production without JIVA_ENVIRONMENT=production → the API refuses to start', insecure.code === 1 && /Refusing to start/.test(insecure.log), `exit ${insecure.code}`);
  const { passes, failures } = results();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('✓ Operational mode PASSED.');
  process.exit(0);
}

main().catch(err => { console.error('✗ Operational mode crashed:', err); process.exit(1); });
