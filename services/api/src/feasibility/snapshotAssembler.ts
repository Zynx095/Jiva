import type {
  CanonicalHospitalRecord,
  Capabilities,
  CareRequirement,
  DataStatus,
  EvidenceRecord,
  FeasibilitySnapshot,
  GeoPoint,
  HospitalInput,
  HospitalState,
  LocationData,
  OperationalEvidence,
} from '@jiva/domain-models';
import type { AcceptanceView } from './acceptanceLedger';

const DATA_STATUSES: ReadonlySet<string> = new Set<DataStatus>([
  'CURRENT', 'HISTORICAL', 'PUBLIC_LISTED', 'HOSPITAL_CONFIRMED', 'AUTHORIZED_FEED',
  'SYNTHETIC_DEMO', 'UNKNOWN', 'NOT_DISCLOSED', 'UNVERIFIED',
]);

/** Anything outside the canonical taxonomy is UNVERIFIED (fixes D11 for the engine's inputs). */
function sanitizeStatus(value: string | undefined): DataStatus {
  return value && DATA_STATUSES.has(value) ? (value as DataStatus) : 'UNVERIFIED';
}

/** Deep-freeze-by-copy so later store mutations cannot change a snapshot. */
function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function capabilitiesEvidence(h: HospitalState): EvidenceRecord<Capabilities> {
  const canonical = (h as Partial<CanonicalHospitalRecord>).evidence?.capabilities;
  if (canonical) return clone(canonical);
  const prov = h.provenance?.[0];
  return {
    value: clone(h.capabilities || {}),
    source: prov?.sourceId || 'hospital-record',
    sourceType: prov?.sourceType || 'UNKNOWN',
    observedAt: prov?.retrievedAt || prov?.asOf || '',
    confidence: prov?.confidence ?? 0,
    dataStatus: h.dataStatus === 'SYNTHETIC_DEMO' ? 'SYNTHETIC_DEMO' : 'PUBLIC_LISTED',
  };
}

function locationEvidence(h: HospitalState): EvidenceRecord<LocationData> | undefined {
  if (!h.location) return undefined;
  const prov = h.provenance?.[0];
  return {
    value: clone(h.location),
    source: prov?.sourceId || 'hospital-record',
    sourceType: prov?.sourceType || 'UNKNOWN',
    observedAt: prov?.retrievedAt || '',
    confidence: prov?.confidence ?? 0,
    dataStatus: h.dataStatus,
  };
}

/**
 * Operational evidence: the capacity statuses with the event time of the capacity update that
 * produced them. Seeded operational state carries no observation time -> UNTIMED -> UNKNOWN.
 */
function operationalEvidence(h: HospitalState): OperationalEvidence {
  const op = h.operationalState;
  const lastCapacity = [...(h.provenance || [])].reverse().find(p => p.sourceName === 'Capacity Update');
  const observedAt = op.capacityAsOf;
  // Live evidence grade comes ONLY from the trusted ingestion stamp on the capacity update. The
  // submitter's claim (verificationStatus / op.source, which acceptance responses also overwrite)
  // never upgrades it. Seeded state with no capacity update is server-owned record data.
  // Timed evidence with no trusted stamp is UNVERIFIED. Untimed (seeded) state can never assert
  // current status whatever it is labelled (freshness = UNTIMED -> UNKNOWN), so its label is diagnostic only.
  const dataStatus: DataStatus = observedAt
    ? sanitizeStatus(lastCapacity?.trustedStatus ?? 'UNVERIFIED')
    : sanitizeStatus(op.source === 'UNKNOWN' ? 'UNKNOWN' : op.source);
  return {
    statuses: { emergency: op.emergency, icu: op.icu, trauma: op.trauma, nicu: op.nicu, picu: op.picu, ventilator: op.ventilator },
    source: observedAt ? `capacity-update:${lastCapacity?.sourceId ?? 'unknown'}` : 'hospital-record-seed',
    dataStatus,
    observedAt,
    confidence: lastCapacity?.confidence,
  };
}

export interface SnapshotRequest {
  snapshotId: string;
  evaluatedAt: string;
  policyVersion: string;
  policyHash: string;
  trigger: FeasibilitySnapshot['trigger'];
  requirement: CareRequirement;
  requirementProvenance: 'RULE_DERIVED' | 'CLINICIAN_CONFIRMED';
  excludedHospitalIds?: string[];
  ambulanceId?: string;
  origin?: GeoPoint;
  originAsOf?: string;
}

/** Freeze every input the engine will read. Transport ETAs are filled in by the enricher. */
export function assembleSnapshot(
  req: SnapshotRequest,
  hospitals: Iterable<HospitalState>,
  ledger: AcceptanceView
): FeasibilitySnapshot {
  const nowMs = Date.parse(req.evaluatedAt);
  const candidates: HospitalInput[] = [];
  for (const h of hospitals) {
    candidates.push({
      hospitalId: h.hospitalId,
      displayName: h.displayName,
      location: locationEvidence(h),
      capabilities: capabilitiesEvidence(h),
      operational: operationalEvidence(h),
      acceptance: ledger.view(req.requirement.caseId, h.hospitalId, nowMs),
      // No financial / insurance evidence exists in JIVA data yet -> factors report UNKNOWN.
    });
  }
  return {
    snapshotId: req.snapshotId,
    evaluatedAt: req.evaluatedAt,
    policyVersion: req.policyVersion,
    policyHash: req.policyHash,
    trigger: { ...req.trigger },
    case: {
      caseId: req.requirement.caseId,
      requirement: clone(req.requirement),
      requirementProvenance: req.requirementProvenance,
      excludedHospitalIds: req.excludedHospitalIds ? [...req.excludedHospitalIds].sort() : undefined,
    },
    candidates,
    transport: {
      ambulanceId: req.ambulanceId,
      origin: req.origin ? {
        value: { latitude: req.origin.latitude, longitude: req.origin.longitude },
        source: req.ambulanceId ? `gps:${req.ambulanceId}` : 'case-location',
        sourceType: req.ambulanceId ? 'TELEMETRY_STREAM' : 'CASE_REPORT',
        observedAt: req.originAsOf || '',
        confidence: 1,
        dataStatus: 'CURRENT',
      } : undefined,
      etaByHospital: {},
    },
  };
}
