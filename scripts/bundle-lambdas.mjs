/**
 * Bundles every AWS Lambda entry point into a SELF-CONTAINED artifact for the CDK stack.
 *
 *   input : services/api/src/lambdas/*.ts   (TypeScript source; @jiva/* workspace packages resolve via node_modules)
 *   output: infrastructure/aws/lambda-dist/<entry>.js   (single-file CommonJS, Node 20, no repo-relative paths)
 *
 * Why: `Code.fromAsset(services/api/dist/lambdas)` shipped only that folder, so `./core/*`, `../infrastructure/*`
 * and `@jiva/*` could not resolve at runtime, and tsc's extensionless ESNext imports do not load in Node.
 * Everything (including the AWS SDK v3 clients) is bundled, so the artifact needs no node_modules and no
 * repository checkout. Deterministic: same sources -> byte-identical output (no minify, no sourcemap, no
 * timestamps, sorted entry order).
 */
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'services/api/src/lambdas');
const OUT = path.join(ROOT, 'infrastructure/aws/lambda-dist');

const entries = fs.readdirSync(SRC).filter(f => f.endsWith('.ts')).sort();
fs.mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: entries.map(f => path.join(SRC, f)),
  outdir: OUT,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  absWorkingDir: ROOT,
  // The Lambda runtime provides only Node built-ins; nothing else is external.
  external: [],
  // esbuild embeds absolute paths in nothing when bundle=true and sourcemap=false; keep it that way.
});

const manifest = {};
for (const f of fs.readdirSync(OUT).filter(x => x.endsWith('.js')).sort()) {
  const buf = fs.readFileSync(path.join(OUT, f));
  manifest[f] = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
fs.writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Bundled ${entries.length} lambdas -> ${path.relative(ROOT, OUT)}`);
for (const [f, m] of Object.entries(manifest)) console.log(`  ${f.padEnd(40)} ${(m.bytes / 1024).toFixed(0).padStart(6)} KB  ${m.sha256.slice(0, 12)}`);
