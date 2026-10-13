import { useCallback, useEffect, useState } from 'react';

/**
 * Client view of the public facility directory (GET /api/directory/facilities). Directory facilities
 * are listings only: not connected to JIVA, no acceptance channel, services and capacity unknown.
 */
export interface DirectoryFacility {
  facilityId: string;
  name: string;
  category: string;
  categoryBasis: string;
  specialtyHint?: string;
  ownership: string;
  address: { fullAddress: string; pincode?: string; ward?: string; city: string };
  phone?: string;
  coordinateStatus: 'OSM_FACILITY_MATCH' | 'MANUAL_UNVERIFIED' | 'UNRESOLVED';
  location?: { latitude: number; longitude: number; osm?: { type: string; id: number; name: string }; matchScore?: number; corroboration?: string[] };
  sources: Array<{ sourceId: string; file: string; row: number; originalName: string }>;
}

export interface DirectoryResponse {
  buildId: string;
  osmSnapshot?: { fetchedAt: string; elementCount: number; attribution: string; license: string };
  sources: Array<{ sourceId: string; title: string; publisher: string; notes: string }>;
  counts: { total: number; byCategory: Record<string, number>; byCoordinateStatus: Record<string, number>; mergedDuplicates: number };
  note: string;
  facilities: DirectoryFacility[];
}

const CATEGORY_TEXT: Record<string, string> = {
  HOSPITAL: 'Hospital',
  SPECIALTY_HOSPITAL: 'Specialty hospital',
  MATERNITY_HOME: 'Maternity home',
  HEALTH_CENTRE: 'Health centre',
  CLINIC: 'Clinic',
  NURSING_HOME: 'Nursing home',
  DIAGNOSTIC_CENTRE: 'Diagnostic centre',
  UNKNOWN: 'Type not stated',
};
export const facilityCategoryLabel = (c: string) => CATEGORY_TEXT[c] ?? c;

const SPECIALTY_TEXT: Record<string, string> = {
  EYE: 'eye care', DENTAL: 'dental', MATERNITY: 'maternity', PAEDIATRIC: "children's care", ONCOLOGY: 'cancer care',
  CARDIAC: 'heart care', ORTHOPAEDIC: 'orthopaedics', NEURO_OR_MENTAL_HEALTH: 'neuro / mental health', RENAL_UROLOGY: 'kidney / urology', OTHER_SPECIALTY: 'a specialty',
};
export const specialtyHintLabel = (h?: string) => (h ? SPECIALTY_TEXT[h] ?? h.toLowerCase() : undefined);

const SOURCE_TEXT: Record<string, string> = {
  'rohini-network-list': 'Insurance network list (ROHINI)',
  'bbmp-health-facilities': 'BBMP health facility list',
  'bbmp-referral-hospitals': 'BBMP referral hospital list',
  'bbmp-maternity-homes': 'BBMP maternity home list',
  'hospitals-in-india': 'Hospitals-in-India list',
  'manual-extract': 'Official listing (manual extract)',
};
export const directorySourceLabel = (id: string) => SOURCE_TEXT[id] ?? id;

export function coordinateBasis(f: Pick<DirectoryFacility, 'coordinateStatus' | 'location'>): string {
  if (f.coordinateStatus === 'OSM_FACILITY_MATCH') return `Placed by matching its name to an OpenStreetMap facility${f.location?.corroboration?.length ? ` (confirmed by ${f.location.corroboration.map((c) => c.toLowerCase()).join(' and ')})` : ''}`;
  if (f.coordinateStatus === 'MANUAL_UNVERIFIED') return 'Location typed in by a contributor — unverified';
  return 'Location not verified — not shown on the map';
}

export type DirectoryLoad = 'loading' | 'ready' | 'unavailable' | 'error';

/** Load the directory once with the app's own authenticated fetcher. */
export function useDirectory(fetcher: () => Promise<DirectoryResponse>, enabled = true) {
  const [data, setData] = useState<DirectoryResponse | null>(null);
  const [state, setState] = useState<DirectoryLoad>('loading');
  const load = useCallback(async () => {
    setState('loading');
    try {
      setData(await fetcher());
      setState('ready');
    } catch (err) {
      setState(/\b503\b/.test(err instanceof Error ? err.message : '') ? 'unavailable' : 'error');
    }
  }, [fetcher]);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  return { data, state, reload: load };
}
