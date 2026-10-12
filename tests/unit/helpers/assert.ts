/**
 * Minimal assertion helpers for the clinical-domain suites (no engine or store imports, so a suite only
 * loads what it tests). Same reporting style as feasibilityHarness.ts.
 */
let passed = 0;
export const passCount = () => passed;

export async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

export function eq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual) ?? 'undefined';
  const e = JSON.stringify(expected) ?? 'undefined';
  const clip = (v: string) => (v.length > 600 ? `${v.slice(0, 600)}…(${v.length} chars)` : v);
  if (a !== e) throw new Error(`${msg}: expected ${clip(e)}, got ${clip(a)}`);
}

export function ok(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

/** Run a suite: prints a summary, exits non-zero on the first failure. */
export function run(title: string, suite: () => Promise<void>) {
  console.log(`[Test] ${title}\n`);
  suite()
    .then(() => {
      console.log(`\n✓ ${title}: ${passed} checks passed.\n`);
      process.exit(0);
    })
    .catch(err => {
      console.error(`\n✗ ${title} failed:`, err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
