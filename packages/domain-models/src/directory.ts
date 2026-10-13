/**
 * Public facility directory (Phase 3). A directory entry says a facility is LISTED somewhere public;
 * it says nothing about what the facility can do right now. Directory facilities are not connected to
 * JIVA: they never receive referrals, never become routing candidates, and their services and capacity
 * stay unknown unless a source states them.
 */

export type FacilityCategory =
  | 'HOSPITAL'
  | 'SPECIALTY_HOSPITAL'
  | 'MATERNITY_HOME'
  | 'HEALTH_CENTRE'
  | 'CLINIC'
  | 'NURSING_HOME'
  | 'DIAGNOSTIC_CENTRE'
  | 'UNKNOWN';

/**
 * OSM_FACILITY_MATCH — coordinates of an OpenStreetMap health facility whose name matched the listing
 *                      under the documented matching rules (not a site survey; © OSM contributors, ODbL).
 * MANUAL_UNVERIFIED  — coordinates typed in by a contributor, with no reproducible source.
 * UNRESOLVED         — no coordinates could be verified; the facility is listed but not placed on the map.
 */
export type CoordinateStatus = 'OSM_FACILITY_MATCH' | 'MANUAL_UNVERIFIED' | 'UNRESOLVED';

export interface DirectorySourceRef {
  /** Stable source id, e.g. 'rohini-network-list', 'bbmp-health-facilities'. */
  sourceId: string;
  /** Repository file the record came from. */
  file: string;
  /** 1-based data row in that file (header excluded). */
  row: number;
  originalName: string;
  originalAddress?: string;
  originalType?: string;
}

export interface FacilityDirectoryEntry {
  facilityId: string;
  name: string;
  category: FacilityCategory;
  /** Why this category: e.g. 'SOURCE_TYPE:BBMP Referral Hospital' or 'NAME_KEYWORD:eye'. Reviewable. */
  categoryBasis: string;
  /** A specialty suggested by the facility's NAME only (e.g. EYE). Never a capability claim. */
  specialtyHint?: string;
  ownership: 'MUNICIPAL' | 'GOVERNMENT' | 'PRIVATE' | 'UNKNOWN';
  address: {
    fullAddress: string;
    pincode?: string;
    ward?: string;
    city: string;
  };
  /** Publicly listed facility phone number, when a government source lists one. */
  phone?: string;
  identifiers?: { rohiniId?: string };
  coordinateStatus: CoordinateStatus;
  location?: {
    latitude: number;
    longitude: number;
    /** The OpenStreetMap feature the coordinates came from (OSM_FACILITY_MATCH only). */
    osm?: { type: 'node' | 'way' | 'relation'; id: number; name: string };
    /** 0..1 name similarity of the match. */
    matchScore?: number;
    /** Independent agreement found for the match, e.g. 'POSTCODE', 'LOCALITY'. */
    corroboration?: string[];
  };
  /** Where the listing came from (several sources when records were merged). */
  sources: DirectorySourceRef[];
  dataStatus: 'PUBLIC_LISTED';
  /** Directory facilities have no JIVA connection: no acceptance channel, capacity unknown. */
  operational: { connectedToJiva: false; acceptanceChannel: 'NONE'; capacity: 'UNKNOWN' };
}

export interface FacilityDirectory {
  /** Deterministic build fingerprint (inputs + rules), not a wall-clock time. */
  buildId: string;
  osmSnapshot?: { fetchedAt: string; elementCount: number; attribution: string; license: string };
  sources: Array<{ sourceId: string; file: string; title: string; publisher: string; notes: string }>;
  counts: {
    total: number;
    byCategory: Record<string, number>;
    byCoordinateStatus: Record<string, number>;
    mergedDuplicates: number;
  };
  facilities: FacilityDirectoryEntry[];
}
