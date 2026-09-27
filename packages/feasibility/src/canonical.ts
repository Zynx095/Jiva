import { createHash } from 'crypto';
import type { FeasibilitySnapshot } from '@jiva/domain-models';

/** Canonical JSON: object keys sorted recursively, undefined dropped. Arrays keep their order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Content hash of a snapshot. Independent of candidate array order and of the snapshotId /
 * contentHash fields themselves, so two snapshots with identical evidence hash identically.
 */
export function hashSnapshot(snapshot: FeasibilitySnapshot): string {
  const { snapshotId: _id, contentHash: _hash, ...content } = snapshot;
  const candidates = [...content.candidates].sort((a, b) => cmp(a.hospitalId, b.hospitalId));
  return sha256(canonicalJson({ ...content, candidates }));
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
