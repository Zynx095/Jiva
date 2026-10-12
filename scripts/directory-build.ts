/**
 * Build the Bengaluru public facility directory (Phase 3).
 *
 *   npm run directory:build              rebuild from the committed sources + OSM snapshot (offline)
 *   npm run directory:build -- --fetch-osm   refresh the OpenStreetMap snapshot first (one Overpass query)
 *
 * Inputs (repository root): Bengaluru.xlsx, bbmphospital.csv, bbmp_referral.csv, bbmp_maternity.csv,
 * HospitalsInIndia.csv (Bangalore rows), data/canonical/hospitals.json (manual extracts).
 * Outputs (data/directory/): bengaluru-facilities.json, build-report.json, osm-health-facilities.json.
 *
 * Nothing is invented: categories come from the source type or a documented name keyword; coordinates
 * come only from a name-matched OpenStreetMap health facility (or are marked unverified/unresolved);
 * services, capacity and operating status are never part of a directory entry.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { FacilityDirectory, FacilityDirectoryEntry } from '../packages/domain-models/src';
import { csvRecords, readXlsxFirstSheet } from './lib/tabular';
import {
  buildEntry, buildOsmIndex, cleanAddress, cleanName, extractPincode, MATCH_RULES, mergeListings,
  type ListedRecord, type MatchResult, type OsmFacility,
} from './lib/directory';

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data/directory');
const OSM_SNAPSHOT = path.join(OUT_DIR, 'osm-health-facilities.json');
const AREA = { minLat: 12.7, minLng: 77.3, maxLat: 13.3, maxLng: 77.95 };
const RULES_VERSION = 'directory-rules-1';
/** Public Overpass instances, tried in order (one query each, with a pause between attempts). */
const OVERPASS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
const USER_AGENT = 'JIVA-directory-build/1.0 (+https://github.com/Zynx095/Jiva)';

const SOURCES: FacilityDirectory['sources'] = [
  { sourceId: 'rohini-network-list', file: 'Bengaluru.xlsx', title: 'Bengaluru hospitals with ROHINI IDs', publisher: 'Not documented in the repository. ROHINI = Registry of Hospitals in Network of Insurance (Insurance Information Bureau of India).', notes: 'Name, address and ROHINI ID only. Listing in an insurance registry says nothing about emergency services or capacity.' },
  { sourceId: 'bbmp-health-facilities', file: 'bbmphospital.csv', title: 'BBMP health centres and urban family welfare centres', publisher: 'Bruhat Bengaluru Mahanagara Palike (BBMP) Health Department listing; copy supplied in the repository.', notes: 'Primary-care facilities, not hospitals. Phone numbers are the listed facility landlines.' },
  { sourceId: 'bbmp-referral-hospitals', file: 'bbmp_referral.csv', title: 'BBMP referral hospitals', publisher: 'BBMP Health Department listing; copy supplied in the repository.', notes: 'Bed counts, services and staff columns are empty in the source.' },
  { sourceId: 'bbmp-maternity-homes', file: 'bbmp_maternity.csv', title: 'BBMP maternity homes', publisher: 'BBMP Health Department listing; copy supplied in the repository.', notes: '' },
  { sourceId: 'hospitals-in-india', file: 'HospitalsInIndia.csv', title: 'Hospitals in India (rows with City = Bangalore)', publisher: 'Not documented in the repository.', notes: 'Name, address and pincode only.' },
  { sourceId: 'manual-extract', file: 'data/raw/*.json via data/canonical/hospitals.json', title: 'Manually extracted official listings', publisher: 'Repository contributors; the official source URL is kept per record.', notes: 'Coordinates were typed in by a contributor; they are MANUAL_UNVERIFIED unless an OpenStreetMap match confirms the facility.' },
];

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function listings(): ListedRecord[] {
  const out: ListedRecord[] = [];

  // ROHINI-listed hospitals (xlsx): S No | ROHINI ID | HOSPITAL NAME | Address | CITY
  const xlsx = readXlsxFirstSheet(read('Bengaluru.xlsx')).slice(1);
  xlsx.forEach((r, i) => {
    if (!r.C) return;
    const address = cleanAddress(r.D);
    out.push({
      name: cleanName(r.C), address, pincode: extractPincode(address), rohiniId: r.B || undefined,
      source: { sourceId: 'rohini-network-list', file: 'Bengaluru.xlsx', row: i + 1, originalName: r.C, ...(r.D ? { originalAddress: r.D } : {}) },
    });
  });

  // BBMP lists (csv): Name | Type | Beds | Address | Ward | area covered | Services | Staff | Contact
  for (const [file, sourceId] of [['bbmphospital.csv', 'bbmp-health-facilities'], ['bbmp_referral.csv', 'bbmp-referral-hospitals'], ['bbmp_maternity.csv', 'bbmp-maternity-homes']] as const) {
    csvRecords(read(file).toString('utf8')).forEach((r, i) => {
      if (!r.Name) return;
      const address = cleanAddress(r.Address);
      out.push({
        name: cleanName(r.Name), address, pincode: extractPincode(address), ward: r.Ward || undefined, phone: r.Contact || undefined, sourceType: r.Type || undefined,
        source: { sourceId, file, row: i + 1, originalName: r.Name, ...(r.Address ? { originalAddress: r.Address } : {}), ...(r.Type ? { originalType: r.Type } : {}) },
      });
    });
  }

  // Hospitals in India (csv), Bangalore rows: <index> | Hospital | State | City | LocalAddress | Pincode
  csvRecords(read('HospitalsInIndia.csv').toString('utf8')).forEach((r, i) => {
    if (!/^(bangalore|bengaluru)$/i.test(r.City || '') || !r.Hospital) return;
    const address = cleanAddress(r.LocalAddress);
    out.push({
      name: cleanName(r.Hospital), address, pincode: extractPincode(address, r.Pincode),
      source: { sourceId: 'hospitals-in-india', file: 'HospitalsInIndia.csv', row: i + 1, originalName: r.Hospital, ...(r.LocalAddress ? { originalAddress: r.LocalAddress } : {}) },
    });
  });

  // Manual extracts (via the canonical dataset, which keeps their source URLs and typed-in coordinates).
  const canonical = JSON.parse(read('data/canonical/hospitals.json').toString('utf8')) as Array<{ displayName: string; facilityType?: string; address: { fullAddress: string; pincode?: string; ward?: string }; location?: { latitude: number; longitude: number }; contact?: { phone?: string } }>;
  canonical.forEach((h, i) => {
    const address = cleanAddress(h.address.fullAddress);
    out.push({
      name: cleanName(h.displayName), address, pincode: extractPincode(address, h.address.pincode), ward: h.address.ward,
      phone: h.contact?.phone, sourceType: h.facilityType,
      manualLocation: h.location ? { latitude: h.location.latitude, longitude: h.location.longitude } : undefined,
      source: { sourceId: 'manual-extract', file: 'data/canonical/hospitals.json', row: i + 1, originalName: h.displayName, originalAddress: h.address.fullAddress, ...(h.facilityType ? { originalType: h.facilityType } : {}) },
    });
  });
  return out;
}

interface OsmSnapshot { fetchedAt: string; query: string; attribution: string; license: string; elementCount: number; elements: OsmFacility[] }

async function fetchOsm(): Promise<OsmSnapshot> {
  const bbox = `${AREA.minLat},${AREA.minLng},${AREA.maxLat},${AREA.maxLng}`;
  const query = `[out:json][timeout:120];(nwr["amenity"~"^(hospital|clinic)$"](${bbox});nwr["healthcare"~"^(hospital|clinic|centre|birthing_centre)$"](${bbox}););out center tags;`;
  type OverpassResponse = { osm3s?: { timestamp_osm_base?: string }; elements: Array<{ type: 'node' | 'way' | 'relation'; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }> };
  let data: OverpassResponse | undefined;
  for (const [i, url] of OVERPASS.entries()) {
    if (i > 0) await new Promise(r => setTimeout(r, 10_000)); // be polite between instances
    console.log(`[directory] Fetching OpenStreetMap health facilities (one Overpass query) from ${url}…`);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'user-agent': USER_AGENT, 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json() as OverpassResponse;
      if (!Array.isArray(data.elements)) throw new Error('response has no elements');
      break;
    } catch (err) {
      console.warn(`[directory] ${url} failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!data) throw new Error('No Overpass instance answered; the previous snapshot (if any) is unchanged');
  const elements: OsmFacility[] = [];
  for (const el of data.elements) {
    const t = el.tags || {};
    const name = t.name || t['name:en'];
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || lat === undefined || lon === undefined) continue;
    const altNames = [t['name:en'], t.alt_name, t.official_name, t.short_name, t.old_name]
      .filter((x): x is string => !!x).flatMap(x => x.split(';')).map(x => x.trim()).filter(x => x && x !== name);
    elements.push({
      type: el.type, id: el.id, lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), name, altNames: [...new Set(altNames)],
      ...(t.amenity ? { amenity: t.amenity } : {}), ...(t.healthcare ? { healthcare: t.healthcare } : {}), ...(t['addr:postcode'] ? { postcode: t['addr:postcode'] } : {}),
      addressText: [t['addr:housename'], t['addr:street'], t['addr:suburb'], t['addr:neighbourhood'], t['addr:city'], t['addr:place'], t['addr:full']].filter(Boolean).join(' ').toLowerCase(),
    });
  }
  elements.sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id);
  return {
    fetchedAt: data.osm3s?.timestamp_osm_base || new Date().toISOString(),
    query,
    attribution: '© OpenStreetMap contributors',
    license: 'Open Database License (ODbL) 1.0 — https://opendatacommons.org/licenses/odbl/',
    elementCount: elements.length,
    elements,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let snapshot: OsmSnapshot | undefined;
  if (process.argv.includes('--fetch-osm')) {
    snapshot = await fetchOsm();
    fs.writeFileSync(OSM_SNAPSHOT, JSON.stringify(snapshot, null, 1) + '\n');
    console.log(`[directory] Saved ${snapshot.elementCount} named OSM health facilities (${snapshot.fetchedAt}).`);
  } else if (fs.existsSync(OSM_SNAPSHOT)) {
    snapshot = JSON.parse(fs.readFileSync(OSM_SNAPSHOT, 'utf8')) as OsmSnapshot;
  } else {
    console.warn('[directory] No OSM snapshot: every facility stays UNRESOLVED (run with --fetch-osm to geocode).');
  }

  const records = listings();
  const { groups, merged } = mergeListings(records);
  const index = snapshot ? buildOsmIndex(snapshot.elements) : undefined;
  const built = groups.map(g => buildEntry(g, index, AREA));
  const facilities: FacilityDirectoryEntry[] = built.map(b => b.entry).sort((a, b) => a.name.localeCompare(b.name) || a.facilityId.localeCompare(b.facilityId));

  // Two listings resolving to one id would be a rule bug: fail loudly rather than silently overwrite.
  const ids = new Set<string>();
  for (const f of facilities) {
    if (ids.has(f.facilityId)) throw new Error(`Duplicate facility id ${f.facilityId} (${f.name})`);
    ids.add(f.facilityId);
  }

  const count = <K extends string>(get: (f: FacilityDirectoryEntry) => K) =>
    facilities.reduce<Record<string, number>>((m, f) => ({ ...m, [get(f)]: (m[get(f)] ?? 0) + 1 }), {});
  const inputs = ['Bengaluru.xlsx', 'bbmphospital.csv', 'bbmp_referral.csv', 'bbmp_maternity.csv', 'HospitalsInIndia.csv', 'data/canonical/hospitals.json'].map(f => sha(read(f)));
  const directory: FacilityDirectory = {
    buildId: sha([RULES_VERSION, ...inputs, snapshot ? sha(JSON.stringify(snapshot.elements)) : 'no-osm'].join('|')).slice(0, 16),
    ...(snapshot ? { osmSnapshot: { fetchedAt: snapshot.fetchedAt, elementCount: snapshot.elementCount, attribution: snapshot.attribution, license: snapshot.license } } : {}),
    sources: SOURCES,
    counts: { total: facilities.length, byCategory: count(f => f.category), byCoordinateStatus: count(f => f.coordinateStatus), mergedDuplicates: merged },
    facilities,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'bengaluru-facilities.json'), JSON.stringify(directory, null, 1) + '\n');

  // Review report: why records were not placed, which listings were merged.
  const unresolved = built.filter(b => b.entry.coordinateStatus !== 'OSM_FACILITY_MATCH').map(b => ({
    facilityId: b.entry.facilityId, name: b.entry.name, coordinateStatus: b.entry.coordinateStatus,
    reason: (b.match as Extract<MatchResult, { status: 'UNRESOLVED' }> | undefined)?.reason ?? (b.match?.status === 'MATCHED' ? 'MATCH_OUTSIDE_SERVICE_AREA' : 'NO_OSM_SNAPSHOT'),
    nearest: (b.match as Extract<MatchResult, { status: 'UNRESOLVED' }> | undefined)?.best,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const report = {
    buildId: directory.buildId,
    rulesVersion: RULES_VERSION,
    matchRules: MATCH_RULES,
    listingsRead: records.length,
    bySource: records.reduce<Record<string, number>>((m, r) => ({ ...m, [r.source.sourceId]: (m[r.source.sourceId] ?? 0) + 1 }), {}),
    counts: directory.counts,
    unresolvedReasons: unresolved.reduce<Record<string, number>>((m, u) => ({ ...m, [u.reason]: (m[u.reason] ?? 0) + 1 }), {}),
    mergedGroups: groups.filter(g => g.length > 1).map(g => g.map(r => `${r.source.sourceId}#${r.source.row}: ${r.source.originalName}`)).sort((a, b) => a[0].localeCompare(b[0])),
    unresolved,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'build-report.json'), JSON.stringify(report, null, 1) + '\n');

  console.log(`[directory] ${records.length} listings → ${facilities.length} facilities (${merged} merged).`);
  console.log(`[directory] Coordinates: ${JSON.stringify(directory.counts.byCoordinateStatus)}`);
  console.log(`[directory] Categories:  ${JSON.stringify(directory.counts.byCategory)}`);
}

main().catch(err => {
  console.error('[directory] Build failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
