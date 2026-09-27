/**
 * Failure containment for AUXILIARY observation (feasibility shadow, acceptance ledger, trace
 * generation/publishing, evidence reconstruction).
 *
 *   legacy decision flow  ──►  completes on its own
 *          └──► independent observation ──► failure is caught, counted and logged HERE
 *
 * Nothing wrapped by these helpers can throw into, reject into, or delay the legacy path.
 */
let failures = 0;
const recent: { label: string; message: string }[] = [];

function fail(label: string, err: unknown): void {
  failures++;
  const message = err instanceof Error ? err.message : String(err);
  recent.push({ label, message });
  if (recent.length > 50) recent.shift();
  console.error(`[Observation] ${label} failed (contained; legacy path unaffected): ${message}`);
}

/** Run an observation. Synchronous throws and asynchronous rejections are both contained. */
export function observe(label: string, fn: () => unknown): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).then(undefined, err => fail(label, err));
    }
  } catch (err) {
    fail(label, err);
  }
}

/** Await an auxiliary read; on failure return the fallback instead of throwing. */
export async function observeValue<T>(label: string, fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    fail(label, err);
    return fallback;
  }
}

export const auxiliaryFailureCount = () => failures;
export const recentAuxiliaryFailures = () => [...recent];
export function resetAuxiliaryFailures(): void {
  failures = 0;
  recent.length = 0;
}
