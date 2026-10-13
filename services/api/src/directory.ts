import fs from 'fs';
import path from 'path';
import type { FacilityCategory, FacilityDirectory, FacilityDirectoryEntry } from '@jiva/domain-models';

/**
 * Read model over the generated public facility directory (data/directory/bengaluru-facilities.json,
 * built by `npm run directory:build`). Directory facilities are NOT part of the JIVA network: they are
 * never loaded into the hospital store, never receive referrals and never become routing candidates.
 */
const DIRECTORY_FILE = path.resolve(__dirname, '../../../data/directory/bengaluru-facilities.json');

let cached: FacilityDirectory | null | undefined;

/** The directory, or null when it has not been built (callers answer 503 instead of inventing one). */
export function loadDirectory(): FacilityDirectory | null {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(DIRECTORY_FILE, 'utf8')) as FacilityDirectory;
    console.log(`[Directory] Loaded ${cached.facilities.length} public facility listings (build ${cached.buildId}).`);
  } catch (err) {
    console.warn(`[Directory] Not available (${err instanceof Error ? err.message : err}). Run npm run directory:build.`);
    cached = null;
  }
  return cached;
}

function straightLineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Nearest LOCATED directory facilities by straight-line distance — context for a crew when no connected
 * hospital can be asked. Not a recommendation, not a route, and says nothing about services or capacity.
 */
export function nearbyFacilities(
  origin: { latitude: number; longitude: number },
  opts: { limit?: number; maxKm?: number; categories?: FacilityCategory[] } = {},
): Array<{ facility: FacilityDirectoryEntry; straightLineKm: number }> {
  const dir = loadDirectory();
  if (!dir) return [];
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 25);
  const maxKm = opts.maxKm ?? 15;
  return dir.facilities
    .filter(f => f.location && (!opts.categories?.length || opts.categories.includes(f.category)))
    .map(f => ({ facility: f, straightLineKm: Number(straightLineKm(origin, f.location!).toFixed(2)) }))
    .filter(x => x.straightLineKm <= maxKm)
    .sort((a, b) => a.straightLineKm - b.straightLineKm || a.facility.facilityId.localeCompare(b.facility.facilityId))
    .slice(0, limit);
}
