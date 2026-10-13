#!/usr/bin/env node
/**
 * Launch the complete local JIVA demo with one command.
 *
 *   npm run dev          API (tsx watch) + 6 Vite dev servers
 *   npm run start:prod   API + production builds served by `vite preview`
 *
 * Ports:  API 4000 | management 5173/4173 | ambulance 5174/4174 | hospital 5175/4175 | patient 5176/4176
 *         doctor workspace 5177/4177 | demo portal 5178/4178 (the separate demonstration interface)
 */
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prod = process.argv.includes('--prod');
const isWin = process.platform === 'win32';

const apps = [
  ['management', 'management-web', 5173, 4173],
  ['ambulance', 'ambulance-web', 5174, 4174],
  ['hospital', 'hospital-web', 5175, 4175],
  ['patient', 'patient-web', 5176, 4176],
  ['doctor', 'doctor-web', 5177, 4177],
  ['demo portal', 'demo-portal', 5178, 4178],
];

// A port still held by an earlier run is the most common demo failure: say so before starting anything.
const portFree = (port) => new Promise((resolve) => {
  const check = (host) => new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      if (err.code === 'EADDRNOTAVAIL' || err.code === 'EINVAL') res(true);
      else res(false);
    });
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, host);
  });
  Promise.all([check('127.0.0.1'), check('::1')]).then(([ipv4, ipv6]) => resolve(ipv4 && ipv6));
});
const ports = [4000, ...apps.map(([, , d, p]) => (prod ? p : d))];
const busy = [];
for (const port of ports) if (!(await portFree(port))) busy.push(port);
if (busy.length) {
  console.error(`[dev-all] Port${busy.length > 1 ? 's' : ''} ${busy.join(', ')} already in use — probably an earlier JIVA run is still open.`);
  console.error('[dev-all] Close it (or the process using the port) and start again. Nothing was started.');
  process.exit(1);
}

const sharedPackages = [
  'config', 'event-schema', 'domain-models', 'auth', 'feasibility',
  'intelligence', 'mapping', 'realtime', 'ui'
];
const missingDist = sharedPackages.filter(pkg => !fs.existsSync(path.join(ROOT, 'packages', pkg, 'dist', 'index.js')));

if (prod) {
  console.log('[dev-all] Building all workspaces for production…');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
} else if (missingDist.length > 0) {
  console.log(`[dev-all] Missing compiled shared packages (${missingDist.join(', ')}). Building shared packages first…`);
  for (const pkg of sharedPackages) {
    execSync(`npm run build --workspace=packages/${pkg}`, { cwd: ROOT, stdio: 'inherit' });
  }
}

const services = [
  ['api', prod ? 'npx tsx services/api/src/index.ts' : 'npm run dev --workspace=@jiva/api'],
  ...apps.map(([name, ws]) => [name, `npm run ${prod ? 'preview' : 'dev'} --workspace=${ws}`]),
];

const colors = [36, 33, 35, 32, 34, 95, 93];
const children = services.map(([name, cmd], i) => {
  const child = spawn(cmd, { cwd: ROOT, shell: true, env: process.env });
  const tag = `\x1b[${colors[i % colors.length]}m[${name}]\x1b[0m `;
  const pipe = stream => stream.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => console.log(tag + l)));
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', code => {
    console.log(`${tag}exited (${code})`);
    if (code !== 0 && code !== null && !stopping && name === 'api') {
      console.error(`\n[dev-all] FATAL: API process terminated unexpectedly (code ${code}). Stopping all servers…`);
      stop();
    }
  });
  return child;
});

console.log(`
JIVA local demo (${prod ? 'PRODUCTION BUILD' : 'development'})
  API          http://localhost:4000   (health: /api/health)
${apps.map(([n, , d, p]) => `  ${n.padEnd(12)} http://localhost:${prod ? p : d}`).join('\n')}
  Demo portal (scenarios, controls, recorded timeline): http://localhost:${prod ? 4178 : 5178}
  Flagship scenario:  npm run simulate:full:blr     Reset:  npm run demo:reset
  Auth: DEMO personas only (x-jiva-demo-user). Not production authentication.
`);

// Readiness: report when the API (health) and every app actually answer, or which one did not.
const answers = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1500) })).status < 500;
  } catch {
    return false;
  }
};
void (async () => {
  const deadline = Date.now() + (prod ? 120_000 : 90_000);
  const targets = [['API', 'http://localhost:4000/api/health'], ...apps.map(([n, , d, p]) => [n, `http://localhost:${prod ? p : d}/`])];
  const pending = new Set(targets.map(([n]) => n));
  while (pending.size && Date.now() < deadline) {
    for (const [n, url] of targets) if (pending.has(n) && (await answers(url))) pending.delete(n);
    if (pending.size) await new Promise((r) => setTimeout(r, 1000));
  }
  if (pending.size) {
    console.error(`\n[dev-all] NOT READY: ${[...pending].join(', ')} did not answer in time. Check its log lines above.`);
  } else {
    let mode = 'unknown';
    try { mode = (await (await fetch('http://localhost:4000/api/health')).json()).mode ?? 'unknown'; } catch { /* reported above */ }
    console.log(`\n[dev-all] READY — API healthy (${mode} mode) and all ${apps.length} apps answering. Run \`npm run demo:check\` for a full readiness report.`);
  }
})();

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      if (isWin) execSync(`taskkill /pid ${c.pid} /T /F`, { stdio: 'ignore' });
      else process.kill(-c.pid);
    } catch { /* already gone */ }
  }
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
