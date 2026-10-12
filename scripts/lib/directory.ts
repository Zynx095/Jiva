import { createHash } from 'crypto';
import type { CoordinateStatus, DirectorySourceRef, FacilityCategory, FacilityDirectoryEntry } from '../../packages/domain-models/src';

/**
 * Pure rules of the Bengaluru facility directory build (scripts/directory-build.ts). Every rule here is
 * deterministic and documented in data/directory/README.md, so a reviewer can trace why a record was
 * classified, merged or placed on the map — or why it was not.
 */

// ------------------------------------------------------------------ names and addresses

/** Source abbreviations expanded so names read clearly and match OpenStreetMap spellings. */
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bH\.\s?C\.?$/i, 'Health Centre'],
  [/\bUFWC\b/g, 'Urban Family Welfare Centre'],
];

/** Text after a comma that looks like an address (house number, road…) is not part of a name. */
const ADDRESS_TAIL = /,\s*(#|no\.?\s*\d|\d|.*\b(road|rd|main|cross|street|layout|nagar|block|stage|bengaluru|bangalore)\b)/i;

/** Clean a listed facility name: abbreviations expanded, embedded address and stray punctuation removed. */
export function cleanName(raw: string): string {
  // Insurer notes appended to some listing names, e.g. "(No Cashless for Ophthalmology P…" (often unclosed).
  let s = raw.replace(/\s*\((?:[^)]*cashless|no\s)[^)]*\)?/gi, ' ').replace(/\s+/g, ' ').trim();
  const tail = s.search(ADDRESS_TAIL);
  if (tail > 0) s = s.slice(0, tail);
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  return s.replace(/[,.;:\s]+$/g, '').replace(/^[,.;:\s]+/g, '').replace(/\s+/g, ' ').trim();
}

export function cleanAddress(raw: string | undefined): string {
  return (raw ?? '')
    .replace(/\s*\?\s*/g, ' - ') // mis-encoded en dash in the BBMP lists ("Bangalore ? 79")
    .replace(/\bBanglore\b/gi, 'Bangalore')
    .replace(/\s+/g, ' ')
    .replace(/[,\s]+$/g, '')
    .trim();
}

/**
 * Pincode: an explicit 6-digit 56xxxx value, else one written in the address, else the postal shorthand
 * "Bangalore - 79" / "Bangalore-32" (→ 560079 / 560032; the Bangalore head office series).
 */
export function extractPincode(address: string, explicit?: string): string | undefined {
  const ex = explicit?.trim();
  if (ex && /^5[6]\d{4}$/.test(ex)) return ex;
  const full = address.match(/\b(56\d{4})\b/);
  if (full) return full[1];
  const short = address.match(/\b(?:bangalore|bengaluru)\s*[-–]?\s*(\d{1,3})\s*$/i);
  if (short) return `560${short[1].padStart(3, '0')}`;
  return undefined;
}

// ------------------------------------------------------------------ classification

export interface Classification {
  category: FacilityCategory;
  basis: string;
  specialtyHint?: string;
  ownership: FacilityDirectoryEntry['ownership'];
}

const SOURCE_TYPES: Record<string, FacilityCategory> = {
  'bbmp health centre': 'HEALTH_CENTRE',
  'bbmp urban family welfare centre': 'HEALTH_CENTRE',
  'bbmp referral hospital': 'HOSPITAL',
  'bbmp maternity home': 'MATERNITY_HOME',
  'government hospital': 'HOSPITAL',
  'referral hospital': 'HOSPITAL',
  'maternity home': 'MATERNITY_HOME',
  'private teaching hospital': 'HOSPITAL',
  'private hospital': 'HOSPITAL',
};

/** Name keywords, checked in order. The first match decides. Specialty hints come from the NAME only. */
const NAME_RULES: Array<{ re: RegExp; category: FacilityCategory; hint?: string; key: string }> = [
  { re: /\b(eye|netra|nethra|netralaya|nethralaya|nethradhama|ophthalm\w*|vision)\b/i, category: 'SPECIALTY_HOSPITAL', hint: 'EYE', key: 'eye' },
  { re: /\b(dental|dentistry|teeth)\b/i, category: 'CLINIC', hint: 'DENTAL', key: 'dental' },
  { re: /\b(diagnostic|diagnostics|scans?|imaging|laborator(y|ies)|labs?)\b/i, category: 'DIAGNOSTIC_CENTRE', key: 'diagnostic' },
  { re: /\b(maternity|mother|motherhood|women'?s?|fertility|ivf|birth)\b/i, category: 'MATERNITY_HOME', hint: 'MATERNITY', key: 'maternity' },
  { re: /\b(child|children'?s?|childrens|kids|paediatric|pediatric)\b/i, category: 'SPECIALTY_HOSPITAL', hint: 'PAEDIATRIC', key: 'children' },
  { re: /\b(cancer|oncology|onco)\b/i, category: 'SPECIALTY_HOSPITAL', hint: 'ONCOLOGY', key: 'cancer' },
  { re: /\b(heart|cardiac|cardio\w*)\b/i, category: 'SPECIALTY_HOSPITAL', hint: 'CARDIAC', key: 'heart' },
  { re: /\b(ortho\w*|bone|joint|spine)\b/i, category: 'SPECIALTY_HOSPITAL', hint: 'ORTHOPAEDIC', key: 'ortho' },
  { re: /\b(neuro\w*|brain|psychiatr\w*|mental)\b/i, category: 'SPECIALTY_HOSPITAL', hint: 'NEURO_OR_MENTAL_HEALTH', key: 'neuro' },
  { re: /\b(kidney|nephro\w*|urology|uro)\b/i, category: 'SPECIALTY_HOSPITAL', hint: 'RENAL_UROLOGY', key: 'kidney' },
  { re: /\b(skin|derma\w*|ent)\b/i, category: 'SPECIALTY_HOSPITAL', hint: 'OTHER_SPECIALTY', key: 'specialty' },
  { re: /\bnursing\s+home\b/i, category: 'NURSING_HOME', key: 'nursing home' },
  { re: /\b(poly\s*clinic|clinic|dispensary)\b/i, category: 'CLINIC', key: 'clinic' },
  { re: /\b(health\s+cent(re|er)|welfare\s+cent(re|er)|phc|uphc)\b/i, category: 'HEALTH_CENTRE', key: 'health centre' },
  { re: /\b(hospitals?|medical\s+college|institute\s+of\s+medical|medical\s+cent(re|er)|healthcare|health\s+care|medicare)\b/i, category: 'HOSPITAL', key: 'hospital' },
];

export function classify(name: string, sourceType: string | undefined, sourceId: string): Classification {
  const ownership: Classification['ownership'] = sourceId.startsWith('bbmp') ? 'MUNICIPAL' : /government/i.test(sourceType ?? '') ? 'GOVERNMENT' : /private/i.test(sourceType ?? '') ? 'PRIVATE' : 'UNKNOWN';
  const fromSource = sourceType ? SOURCE_TYPES[sourceType.trim().toLowerCase()] : undefined;
  const nameRule = NAME_RULES.find(r => r.re.test(name));
  if (fromSource) {
    // The source's own type wins; a name keyword may still add a specialty hint.
    return { category: fromSource, basis: `SOURCE_TYPE:${sourceType!.trim()}`, specialtyHint: nameRule?.hint, ownership };
  }
  if (nameRule) return { category: nameRule.category, basis: `NAME_KEYWORD:${nameRule.key}`, specialtyHint: nameRule.hint, ownership };
  return { category: 'UNKNOWN', basis: 'NO_RULE', ownership };
}

// ------------------------------------------------------------------ tokens and similarity

/** One plural "s" off long words, so "Zamindars"/"Zamindar" and "Hospitals"/"Hospital" compare equal. */
export const stem = (w: string) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

const stemmed = (words: string[]) => new Set(words.map(stem));

/** Words that do not identify a facility on their own: facility types, legal forms, places, honorifics, address words. */
const GENERIC = stemmed([
  'hospital', 'clinic', 'nursing', 'home', 'centre', 'center', 'health', 'healthcare', 'care', 'medical', 'medicare',
  'institute', 'institution', 'research', 'speciality', 'specialty', 'specialities', 'specialties', 'super',
  'superspeciality', 'superspecialty', 'superspecialities', 'multi', 'multispeciality', 'multispecialty', 'pvt', 'private',
  'privated', 'ltd', 'limited', 'llp', 'inc', 'the', 'and', 'of', 'an', 'unit', 'trust', 'foundation', 'society', 'memorial',
  'general', 'government', 'goverment', 'govt', 'bbmp', 'referral', 'science', 'city', 'bangalore', 'bengaluru', 'blr',
  'karnataka', 'india', 'road', 'rd', 'main', 'cross', 'circle', 'nagar', 'layout', 'stage', 'block', 'phase', 'extension',
  'new', 'old', 'sri', 'shri', 'shree', 'st', 'dr', 'doctor', 'polyclinic', 'hc', 'phc', 'uphc', 'family', 'welfare',
  'urban', 'rural', 'north', 'south', 'east', 'west', 'primary', 'community', 'enterprise', 'group', 'service', 'co', 'company',
]);

/**
 * Specialty words. They describe a facility but never identify it alone, and the specialty classes of
 * two names must agree for a match (an eye hospital is not the general hospital of the same name).
 */
const DESCRIPTOR_CLASSES: Record<string, string[]> = {
  EYE: ['eye', 'netralaya', 'nethralaya', 'netra', 'nethra', 'nethradhama', 'ophthalmology', 'ophthalmic', 'vision', 'drishti'],
  MATERNITY: ['maternity', 'women', 'womens', 'mother', 'cradle', 'fertility', 'ivf', 'birth'],
  CHILD: ['children', 'childrens', 'child', 'kids', 'paediatric', 'pediatric', 'paediatrics', 'pediatrics'],
  ORTHO: ['orthopaedic', 'orthopaedics', 'orthopedic', 'ortho', 'bone', 'joint', 'spine'],
  CANCER: ['cancer', 'oncology', 'onco'],
  HEART: ['heart', 'cardiac', 'cardiology', 'hrudayalaya'],
  DENTAL: ['dental', 'dentistry', 'teeth'],
  DIAGNOSTIC: ['diagnostic', 'diagnostics', 'scan', 'scans', 'imaging', 'lab', 'labs', 'laboratory'],
  MENTAL: ['psychiatric', 'psychiatry', 'mental', 'neuropsychiatry', 'deaddiction'],
  KIDNEY: ['kidney', 'nephrology', 'urology', 'dialysis'],
};
const CLASS_OF = new Map<string, string>(Object.entries(DESCRIPTOR_CLASSES).flatMap(([cls, words]) => words.map(w => [stem(w), cls] as [string, string])));
/** Descriptive words without a class. */
const DESCRIPTIVE = stemmed(['surgical', 'surgery', 'microsurgical', 'global', 'international', 'national', 'trauma', 'critical', 'emergency', 'rehabilitation', 'rehab', 'skin', 'ent']);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem);
}

/** Tokens plus adjacent pairs joined ("kalyan nagar" also yields "kalyannagar"). */
function tokensWithJoins(text: string): Set<string> {
  const t = tokens(text);
  const out = new Set(t);
  for (let i = 0; i + 1 < t.length; i++) out.add(t[i] + t[i + 1]);
  return out;
}

/** The part of a name that identifies the facility: no parenthetical, no "unit of …" legal tail. */
export function identityName(name: string): string {
  return name.replace(/\([^)]*\)/g, ' ').replace(/[,-]?\s*\b(a\s+)?unit\s+of\b.*$/i, ' ').trim();
}

/** Non-generic tokens (including specialty words). Single letters count only together with longer tokens. */
export function distinctive(text: string): string[] {
  const t = tokens(identityName(text)).filter(w => !GENERIC.has(w));
  return t.some(w => w.length > 1) ? [...new Set(t)] : [];
}

/** Specialty classes named by a facility name. */
export function descriptorClasses(text: string): string[] {
  return [...new Set(tokens(identityName(text)).map(w => CLASS_OF.get(w)).filter((c): c is string => !!c))].sort();
}

/**
 * Identity tokens: distinctive tokens that are neither specialty words nor (when other tokens remain)
 * locality names from the facility's own address. "Cloudnine Jayanagar" → {cloudnine};
 * "Hosahalli Referral Hospital" → {hosahalli} (the locality IS its identity).
 */
export function identityTokens(name: string, locality: Set<string> = new Set()): string[] {
  const t = distinctive(name).filter(w => !CLASS_OF.has(w) && !DESCRIPTIVE.has(w) && w.length > 1);
  const nonLocal = t.filter(w => !locality.has(w));
  return nonLocal.length ? nonLocal : t;
}

export function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Name without parenthetical text, legal suffixes and punctuation — the identity key used for dedupe. */
export function nameKey(name: string): string {
  return tokens(identityName(name))
    .filter(w => !['pvt', 'private', 'ltd', 'limited', 'llp', 'the', 'a', 'unit', 'of'].includes(w))
    .join(' ');
}

/** Locality words of an address (place names), used to corroborate a match and to read identity. */
const ADDRESS_NOISE = stemmed([
  'road', 'rd', 'main', 'cross', 'stage', 'block', 'phase', 'sector', 'layout', 'near', 'opp', 'opposite', 'behind', 'next',
  'bangalore', 'bengaluru', 'banglore', 'karnataka', 'india', 'post', 'street', 'extension', 'extn', 'circle', 'floor',
  'building', 'complex', 'bus', 'stop', 'police', 'station', 'temple', 'school', 'hospital', 'office', 'colony', 'area', 'ward',
  'mahal', 'number', 'ring', 'outer', 'inner', 'junction', 'off', 'and', 'nagar', 'garden', 'town', 'village', 'opposite',
]);

export function localityTokens(address: string): string[] {
  return [...new Set(tokens(address).filter(w => w.length >= 5 && !/\d/.test(w) && !ADDRESS_NOISE.has(w)))];
}

// ------------------------------------------------------------------ OpenStreetMap matching

export interface OsmFacility {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat: number;
  lon: number;
  name: string;
  altNames: string[];
  amenity?: string;
  healthcare?: string;
  postcode?: string;
  /** Lower-case text of address-ish tags (street, suburb, city, full address) for locality corroboration. */
  addressText: string;
}

export interface OsmIndex {
  items: OsmFacility[];
  byToken: Map<string, number[]>;
  byExactName: Map<string, number[]>;
}

export function buildOsmIndex(items: OsmFacility[]): OsmIndex {
  const byToken = new Map<string, number[]>();
  const byExactName = new Map<string, number[]>();
  items.forEach((it, i) => {
    for (const n of [it.name, ...it.altNames]) {
      const k = nameKey(n);
      if (k) (byExactName.get(k) || byExactName.set(k, []).get(k)!).push(i);
      for (const t of [...distinctive(n), ...tokensWithJoins(n)]) {
        if (GENERIC.has(t)) continue;
        const list = byToken.get(t) || byToken.set(t, []).get(t)!;
        if (list[list.length - 1] !== i) list.push(i);
      }
    }
  });
  return { items, byToken, byExactName };
}

export function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export type UnresolvedReason = 'NO_IDENTIFYING_NAME' | 'NO_CANDIDATE' | 'NAME_MISMATCH' | 'LOW_SCORE' | 'NEEDS_CORROBORATION' | 'AMBIGUOUS' | 'POSTCODE_CONFLICT';

export type MatchResult =
  | { status: 'MATCHED'; osm: OsmFacility; score: number; corroboration: string[] }
  | { status: 'UNRESOLVED'; reason: UnresolvedReason; best?: { name: string; score: number } };

/**
 * Matching rules (documented in data/directory/README.md):
 *  1. Specialty classes of the two names must be identical (eye ≠ general, maternity ≠ welfare centre).
 *  2. Every identity token of the listing must appear in the OSM name, and every identity token of the OSM
 *     name must appear in the listing's name or address (no unexplained extra identity on either side).
 *  3. Name similarity (Jaccard over non-generic tokens) ≥ strongScore, or ≥ corroboratedScore WITH an
 *     independent corroboration (same postcode, or an address locality named in the OSM feature).
 *  4. A listing whose identity rests only on common tokens (found in ≥ commonTokenDf OSM names), or on a
 *     single identifying word while the rest of the name differs, needs corroboration whatever its score.
 *  5. A differing postcode on both sides rejects the candidate.
 *  6. If another candidate with a near-equal score lies more than sameSiteMeters away (a chain), only a
 *     uniquely corroborated candidate may be chosen; otherwise the listing stays UNRESOLVED.
 */
export const MATCH_RULES = { strongScore: 0.75, corroboratedScore: 0.5, tieMargin: 0.05, sameSiteMeters: 300, commonTokenDf: 6 } as const;

export function matchFacility(entry: { name: string; pincode?: string; address: string }, index: OsmIndex): MatchResult {
  const locality = new Set(localityTokens(entry.address));
  const eId = identityTokens(entry.name, locality);
  if (!eId.length) return { status: 'UNRESOLVED', reason: 'NO_IDENTIFYING_NAME' };
  const eDistinct = distinctive(entry.name);
  const eClasses = descriptorClasses(entry.name).join(',');
  const entryAll = new Set([...tokensWithJoins(entry.name), ...tokensWithJoins(entry.address)]);

  const candidateIdx = new Set<number>();
  for (const t of eId) for (const i of index.byToken.get(t) || []) candidateIdx.add(i);
  if (!candidateIdx.size) return { status: 'UNRESOLVED', reason: 'NO_CANDIDATE' };

  let bestRejected: { name: string; score: number } | undefined;
  const accepted: Array<{ it: OsmFacility; score: number; corroboration: string[] }> = [];
  let postcodeConflicts = 0;
  for (const i of [...candidateIdx].sort((a, b) => a - b)) {
    const it = index.items[i];
    let best: { score: number; name: string } | undefined;
    for (const n of [it.name, ...it.altNames]) {
      if (descriptorClasses(n).join(',') !== eClasses) continue; // rule 1
      const osmAll = tokensWithJoins(n);
      if (!eId.every(t => osmAll.has(t))) continue; // rule 2 (listing → OSM)
      if (!identityTokens(n).every(t => entryAll.has(t))) continue; // rule 2 (OSM → listing)
      const score = jaccard(eDistinct, distinctive(n)); // rule 3
      if (!best || score > best.score) best = { score, name: n };
    }
    if (!best) {
      const loose = jaccard(eDistinct, distinctive(it.name));
      if (!bestRejected || loose > bestRejected.score) bestRejected = { name: it.name, score: Number(loose.toFixed(3)) };
      continue;
    }
    const corroboration: string[] = [];
    if (entry.pincode && it.postcode) {
      if (it.postcode.replace(/\s/g, '') !== entry.pincode) { postcodeConflicts++; continue; } // rule 5
      corroboration.push('POSTCODE');
    }
    const hay = `${it.name} ${it.altNames.join(' ')} ${it.addressText}`.toLowerCase();
    if ([...locality].some(w => hay.includes(w))) corroboration.push('LOCALITY');
    accepted.push({ it, score: best.score, corroboration });
  }

  if (!accepted.length) {
    return postcodeConflicts ? { status: 'UNRESOLVED', reason: 'POSTCODE_CONFLICT', best: bestRejected } : { status: 'UNRESOLVED', reason: 'NAME_MISMATCH', best: bestRejected };
  }
  accepted.sort((a, b) => b.score - a.score || b.corroboration.length - a.corroboration.length || a.it.id - b.it.id);
  const top = accepted[0];
  const info = { name: top.it.name, score: Number(top.score.toFixed(3)) };
  const commonOnly = eId.every(t => (index.byToken.get(t)?.length ?? 0) >= MATCH_RULES.commonTokenDf); // rule 4
  const key = nameKey(entry.name);
  // rule 4b: a single identifying word with otherwise different wording ("Premier Health Care" vs
  // "Premier Hospital") is not enough on its own.
  const thin = (c: typeof top) => eId.length === 1 && ![c.it.name, ...c.it.altNames].some(n => nameKey(n) === key);
  const passes = (c: typeof top) =>
    (c.score >= MATCH_RULES.strongScore && ((!commonOnly && !thin(c)) || c.corroboration.length > 0)) ||
    (c.score >= MATCH_RULES.corroboratedScore && c.corroboration.length > 0);

  const rivals = accepted.filter(c => c !== top && c.score >= top.score - MATCH_RULES.tieMargin && distanceMeters(c.it, top.it) > MATCH_RULES.sameSiteMeters);
  if (rivals.length) { // rule 6
    const corroborated = [top, ...rivals].filter(c => c.corroboration.length > 0);
    if (corroborated.length !== 1 || !passes(corroborated[0])) return { status: 'UNRESOLVED', reason: 'AMBIGUOUS', best: info };
    const only = corroborated[0];
    return { status: 'MATCHED', osm: only.it, score: Number(only.score.toFixed(3)), corroboration: only.corroboration };
  }
  if (passes(top)) return { status: 'MATCHED', osm: top.it, score: Number(top.score.toFixed(3)), corroboration: top.corroboration };
  return { status: 'UNRESOLVED', reason: top.score >= MATCH_RULES.corroboratedScore ? 'NEEDS_CORROBORATION' : 'LOW_SCORE', best: info };
}

// ------------------------------------------------------------------ assembly

export interface ListedRecord {
  name: string;
  address: string;
  pincode?: string;
  ward?: string;
  phone?: string;
  rohiniId?: string;
  sourceType?: string;
  /** Coordinates typed in by a contributor (manual extracts only). */
  manualLocation?: { latitude: number; longitude: number };
  source: DirectorySourceRef;
}

/** Stable id: name key + pincode + the first listing (sorted by source and row), so branches never collide. */
export const facilityId = (key: string, pincode: string | undefined, first: DirectorySourceRef) =>
  `FAC-BLR-${createHash('sha256').update(`${key}|${pincode ?? ''}|${first.sourceId}#${first.row}`).digest('hex').slice(0, 10).toUpperCase()}`;

/**
 * Merge listings of the same facility. Two listings are the same facility only with positive evidence:
 *  - the same name key, AND
 *  - never two rows of the same source (a source lists each branch once) unless the rows are identical,
 *  - no conflicting pincodes, AND
 *  - the same pincode, or a shared address locality word.
 * A listing joins an existing facility only when exactly ONE facility qualifies; otherwise it stays
 * separate (chains such as "Manipal Hospital" keep their branches apart).
 */
export function mergeListings(records: ListedRecord[]): { groups: ListedRecord[][]; merged: number } {
  const ordered = [...records].sort((a, b) => a.source.sourceId.localeCompare(b.source.sourceId) || a.source.row - b.source.row);
  const byName = new Map<string, ListedRecord[][]>();
  const sameAddress = (a: ListedRecord, b: ListedRecord) => tokens(a.address).join(' ') === tokens(b.address).join(' ');
  const compatible = (r: ListedRecord, cluster: ListedRecord[]) => {
    for (const m of cluster) {
      if (m.source.sourceId === r.source.sourceId && !sameAddress(m, r)) return false;
      if (m.pincode && r.pincode && m.pincode !== r.pincode) return false;
    }
    const loc = new Set(localityTokens(r.address));
    return cluster.some(m =>
      (m.source.sourceId === r.source.sourceId && sameAddress(m, r)) ||
      (!!m.pincode && m.pincode === r.pincode) ||
      localityTokens(m.address).some(w => loc.has(w)));
  };
  for (const r of ordered) {
    const key = nameKey(r.name);
    const clusters = byName.get(key) || byName.set(key, []).get(key)!;
    const fits = clusters.filter(c => compatible(r, c));
    if (fits.length === 1) fits[0].push(r);
    else clusters.push([r]);
  }
  const groups = [...byName.values()].flat();
  return { groups, merged: records.length - groups.length };
}

/** Prefer the most informative listing for display: a non-ROHINI government source, then the longest address. */
export function pickPrimary(group: ListedRecord[]): ListedRecord {
  return [...group].sort((a, b) =>
    Number(b.source.sourceId.startsWith('bbmp') || b.source.sourceId === 'manual-extract') - Number(a.source.sourceId.startsWith('bbmp') || a.source.sourceId === 'manual-extract') ||
    b.address.length - a.address.length ||
    a.source.sourceId.localeCompare(b.source.sourceId) || a.source.row - b.source.row)[0];
}

export function buildEntry(group: ListedRecord[], index: OsmIndex | undefined, area: { minLat: number; minLng: number; maxLat: number; maxLng: number }): { entry: FacilityDirectoryEntry; match?: MatchResult } {
  const primary = pickPrimary(group);
  const pincode = group.map(g => g.pincode).find(Boolean);
  const cls = classify(primary.name, group.map(g => g.sourceType).find(Boolean), primary.source.sourceId);
  const key = nameKey(primary.name);
  const first = [...group].sort((a, b) => a.source.sourceId.localeCompare(b.source.sourceId) || a.source.row - b.source.row)[0].source;
  const entry: FacilityDirectoryEntry = {
    facilityId: facilityId(key, pincode, first),
    name: primary.name,
    category: cls.category,
    categoryBasis: cls.basis,
    ...(cls.specialtyHint ? { specialtyHint: cls.specialtyHint } : {}),
    ownership: cls.ownership,
    address: { fullAddress: primary.address, ...(pincode ? { pincode } : {}), ...(primary.ward ? { ward: primary.ward } : {}), city: 'Bengaluru' },
    ...(group.map(g => g.phone).find(Boolean) ? { phone: group.map(g => g.phone).find(Boolean) } : {}),
    ...(group.map(g => g.rohiniId).find(Boolean) ? { identifiers: { rohiniId: group.map(g => g.rohiniId).find(Boolean) } } : {}),
    coordinateStatus: 'UNRESOLVED',
    sources: [...group].sort((a, b) => a.source.sourceId.localeCompare(b.source.sourceId) || a.source.row - b.source.row).map(g => g.source),
    dataStatus: 'PUBLIC_LISTED',
    operational: { connectedToJiva: false, acceptanceChannel: 'NONE', capacity: 'UNKNOWN' },
  };

  const inside = (lat: number, lon: number) => lat >= area.minLat && lat <= area.maxLat && lon >= area.minLng && lon <= area.maxLng;
  let match: MatchResult | undefined;
  if (index) {
    match = matchFacility({ name: primary.name, pincode, address: group.map(g => g.address).join(' ') }, index);
    if (match.status === 'MATCHED' && inside(match.osm.lat, match.osm.lon)) {
      entry.coordinateStatus = 'OSM_FACILITY_MATCH';
      entry.location = {
        latitude: Number(match.osm.lat.toFixed(6)),
        longitude: Number(match.osm.lon.toFixed(6)),
        osm: { type: match.osm.type, id: match.osm.id, name: match.osm.name },
        matchScore: match.score,
        corroboration: match.corroboration,
      };
    }
  }
  const manual = group.find(g => g.manualLocation)?.manualLocation;
  if (entry.coordinateStatus === 'UNRESOLVED' && manual && inside(manual.latitude, manual.longitude)) {
    entry.coordinateStatus = 'MANUAL_UNVERIFIED' as CoordinateStatus;
    entry.location = { latitude: manual.latitude, longitude: manual.longitude };
  }
  return { entry, match };
}
