#!/usr/bin/env node
/**
 * Launch the complete local JIVA demo with one command.
 *
 *   npm run dev          API (tsx watch) + 4 Vite dev servers
 *   npm run start:prod   API + production builds served by `vite preview`
 *
 * Ports:  API 4000 | management 5173/4173 | ambulance 5174/4174 | hospital 5175/4175 | patient 5176/4176
 */
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prod = process.argv.includes('--prod');
const isWin = process.platform === 'win32';

const apps = [
  ['management', 'management-web', 5173, 4173],
  ['ambulance', 'ambulance-web', 5174, 4174],
  ['hospital', 'hospital-web', 5175, 4175],
  ['patient', 'patient-web', 5176, 4176],
];

if (prod) {
  console.log('[dev-all] Building all workspaces for production…');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}

const services = [
  ['api', prod ? 'npx tsx services/api/src/index.ts' : 'npm run dev --workspace=@jiva/api'],
  ...apps.map(([name, ws]) => [name, `npm run ${prod ? 'preview' : 'dev'} --workspace=${ws}`]),
];

const colors = [36, 33, 35, 32, 34];
const children = services.map(([name, cmd], i) => {
  const child = spawn(cmd, { cwd: ROOT, shell: true, env: process.env });
  const tag = `\x1b[${colors[i % colors.length]}m[${name}]\x1b[0m `;
  const pipe = stream => stream.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => console.log(tag + l)));
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', code => console.log(`${tag}exited (${code})`));
  return child;
});

console.log(`
JIVA local demo (${prod ? 'PRODUCTION BUILD' : 'development'})
  API          http://localhost:4000   (health: /api/health)
${apps.map(([n, , d, p]) => `  ${n.padEnd(12)} http://localhost:${prod ? p : d}`).join('\n')}
  Flagship scenario:  npm run simulate:full:blr     Reset:  npm run demo:reset
  Auth: DEMO personas only (x-jiva-demo-user). Not production authentication.
`);

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
