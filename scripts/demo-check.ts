/**
 * Demo readiness check. Every line is a real probe, not a file-existence claim.
 * Static checks always run; runtime checks run when the API is up (npm run dev / start:prod).
 * Exit code 1 if any REQUIRED check fails.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const API = process.env.API_URL || 'http://localhost:4000';
type Status = 'PASS' | 'FAIL' | 'INFO' | 'SKIP';
const rows: { name: string; status: Status; detail: string; required: boolean }[] = [];
const add = (name: string, status: Status, detail: string, required = true) => rows.push({ name, status, detail, required });

async function probe(url: string, init?: RequestInit, ms = 1500) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) }); } catch { return undefined; }
}

async function main() {
  // --- static: production bundles exist and include the MapLibre worker
  for (const app of ['management-web', 'ambulance-web', 'hospital-web', 'patient-web']) {
    const assets = path.join(ROOT, 'apps', app, 'dist', 'assets');
    const files = fs.existsSync(assets) ? fs.readdirSync(assets) : [];
    const needsMap = app === 'management-web' || app === 'ambulance-web';
    const ok = files.some(f => f.endsWith('.js')) && (!needsMap || files.some(f => f.startsWith('maplibre-gl-worker')));
    add(`Build: ${app}`, ok ? 'PASS' : 'FAIL', ok ? `${files.length} assets${needsMap ? ', map worker bundled' : ''}` : 'missing dist — run npm run build');
  }
  {
    // Every handler must exist in the self-contained bundle AND actually load in a fresh Node process.
    const dir = path.join(ROOT, 'infrastructure/aws/lambda-dist');
    const names = ['ingestion', 'emergencyProcessor', 'hospitalAcceptanceProcessor', 'ambulanceProcessor', 'routingProcessor', 'aiProcessor', 'websocketHandler'];
    const missing = names.filter(n => !fs.existsSync(path.join(dir, `${n}.js`)));
    let notLoadable: string[] = [];
    if (!missing.length) {
      const { execFileSync } = require('child_process');
      notLoadable = names.filter(n => {
        try {
          execFileSync(process.execPath, ['-e', `const m=require(${JSON.stringify(path.join(dir, `${n}.js`))}); if(typeof m.handler!=='function') process.exit(3)`], { stdio: 'ignore', timeout: 30000 });
          return false;
        } catch { return true; }
      });
    }
    const ok = !missing.length && !notLoadable.length;
    add('Build: API lambdas (bundled)', ok ? 'PASS' : 'FAIL', ok ? `${names.length} handlers load from infrastructure/aws/lambda-dist (package-load only; NOT deployed)` : `missing: ${missing.join(', ') || '-'}; not loadable: ${notLoadable.join(', ') || '-'} — run npm run build`);
  }

  // --- data
  const canonical = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/canonical/hospitals.json'), 'utf8'));
  const synthetic = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/synthetic/bengaluru/hospitals.json'), 'utf8'));
  add('Data: canonical', 'INFO', `${canonical.length} PUBLIC_LISTED facilities, operational state UNKNOWN (not used by the demo map)`, false);
  const synthOk = synthetic.every((h: any) => h.dataStatus === 'SYNTHETIC_DEMO' && h.operationalState.acceptance === 'UNKNOWN');
  add('Data: synthetic demo', synthOk ? 'PASS' : 'FAIL', `${synthetic.length} hospitals labelled SYNTHETIC_DEMO, acceptance UNKNOWN at seed`);

  // --- routing providers actually reachable?
  const valhalla = await probe('http://localhost:8002/status');
  const osrm = await probe('http://localhost:5000/nearest/v1/driving/77.5946,12.9716');
  add('Routing: Valhalla', valhalla?.ok ? 'PASS' : 'INFO', valhalla?.ok ? 'reachable on :8002' : 'not running → fallback', false);
  add('Routing: OSRM', osrm?.ok ? 'PASS' : 'INFO', osrm?.ok ? 'reachable on :5000' : 'not running → fallback', false);
  if (!valhalla?.ok && !osrm?.ok) add('Routing: effective', 'INFO', 'MOCK / synthetic routes (labelled in UI)', false);

  // --- runtime (only if API is up)
  const health = await probe(`${API}/api/health`);
  if (!health) {
    add('Runtime: API', 'SKIP', `not running at ${API} (start with npm run dev) — runtime checks skipped`, false);
  } else {
    const h = await health.json();
    add('Runtime: API health', h.status === 'HEALTHY' ? 'PASS' : 'FAIL', `${h.components.eventBus.provider}, ${h.components.database.provider}, AI ${h.components.ai.provider}, mapping ${h.components.mapping.activeProvider}`);
    const anon = await probe(`${API}/api/patients`);
    add('Runtime: RBAC (anonymous read denied)', anon?.status === 401 ? 'PASS' : 'FAIL', `GET /api/patients without credentials → ${anon?.status}`);
    const bad = await probe(`${API}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jiva-demo-user': 'demo-admin' }, body: '{"eventId":"x","eventType":"patient.emergency.created"}' });
    const still = await probe(`${API}/api/health`);
    add('Runtime: malformed event rejected, API alive', bad?.status === 400 && !!still?.ok ? 'PASS' : 'FAIL', `→ ${bad?.status}, alive=${!!still?.ok}`);
  }

  add('AWS', 'INFO', 'CDK synthesizes (run `npx cdk synth` in infrastructure/aws); NOT deployed, NOT live-verified', false);
  add('Auth', 'INFO', 'DEMO personas (x-jiva-demo-user) — not production authentication', false);

  console.log('\nJIVA DEMO READINESS (probed)\n');
  for (const r of rows) console.log(`${r.status.padEnd(4)}  ${r.name.padEnd(42)} ${r.detail}`);
  const failed = rows.filter(r => r.required && r.status === 'FAIL');
  console.log(`\nSTATUS: ${failed.length ? `NOT READY (${failed.length} required check(s) failed)` : 'READY (with the INFO limitations above)'}`);
  if (failed.length) process.exit(1);
}

main();
