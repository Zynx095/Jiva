import {
  HospitalState,
  Address,
  LocationData,
  ContactData,
  Capabilities,
  HistoricalCapacity,
  OperationalState,
  DataProvenance,
  DataStatus,
} from './hospital';
import {
  EvidenceRecord,
  isValidOperationalEvidence,
  assertNoHistoricalPromotion,
} from './evidence';
import {
  HospitalDigitalTwin,
  FacilityTier,
  CriticalEquipmentTwin,
  EmergencyDepartmentTwin,
  IntensiveCareTwin,
  ClinicalStaffingTwin,
} from './digitalTwin';

/**
 * Granular, field-level evidence repository for a canonical hospital record.
 * Every imported factual field carries explicit provenance, confidence, observation time,
 * and dataStatus conforming to the JIVA canonical taxonomy.
 */
export interface CanonicalHospitalEvidence {
  displayName: EvidenceRecord<string>;
  legalName?: EvidenceRecord<string>;
  aliases?: EvidenceRecord<string[]>;
  facilityType?: EvidenceRecord<string>;
  ownership?: EvidenceRecord<string>;
  tier?: EvidenceRecord<FacilityTier>;
  address: EvidenceRecord<Address>;
  location?: EvidenceRecord<LocationData>;
  ambulanceEntranceLocation?: EvidenceRecord<LocationData>;
  contact?: {
    phone?: EvidenceRecord<string>;
    emergencyPhone?: EvidenceRecord<string>;
    email?: EvidenceRecord<string>;
    website?: EvidenceRecord<string>;
  };
  capabilities: EvidenceRecord<Capabilities>;
  specialties?: EvidenceRecord<string[]>;
  historicalCapacity: {
    totalBeds?: EvidenceRecord<number>;
    icuBeds?: EvidenceRecord<number>;
    ventilators?: EvidenceRecord<number>;
    emergencyBeds?: EvidenceRecord<number>;
  };
  regulatory?: {
    kpmeRegistrationNumber?: EvidenceRecord<string>;
    hfrId?: EvidenceRecord<string>;
    pmjayId?: EvidenceRecord<string>;
    rohsId?: EvidenceRecord<string>;
    otherIdentifiers?: Record<string, EvidenceRecord<string>>;
  };
  operationalState?: EvidenceRecord<OperationalState>;
}

/**
 * Canonical Hospital Record.
 *
 * Extends the baseline HospitalState for seamless backward compatibility across
 * all existing consumers (StateStore, Simulation, Event Mesh, and Frontend APIs)
 * while enriching it with field-level EvidenceRecord<T> provenance, regulatory metadata,
 * and deterministic digital twin materialization capability.
 */
export interface CanonicalHospitalRecord extends HospitalState {
  aliases?: string[];
  tier?: FacilityTier;
  specialties?: string[];
  ambulanceEntranceLocation?: LocationData;
  evidence: CanonicalHospitalEvidence;
  lastSynchronizedAt?: string;
}

/**
 * Helper to infer facility tier from facility type/category when not explicitly published.
 */
export function inferFacilityTier(facilityType?: string): FacilityTier {
  if (!facilityType) return 'UNKNOWN';
  const norm = facilityType.toLowerCase();
  if (norm.includes('teaching') || norm.includes('medical college') || norm.includes('super specialty')) {
    return 'TERTIARY_CARE';
  }
  if (norm.includes('maternity') || norm.includes('mother')) {
    return 'SPECIALTY_MATERNITY';
  }
  if (norm.includes('cardiac') || norm.includes('heart')) {
    return 'SPECIALTY_CARDIAC';
  }
  if (norm.includes('neuro')) {
    return 'SPECIALTY_NEURO';
  }
  if (norm.includes('pediatric') || norm.includes('children')) {
    return 'SPECIALTY_PEDIATRIC';
  }
  if (norm.includes('referral') || norm.includes('general hospital') || norm.includes('district')) {
    return 'SECONDARY_CARE';
  }
  if (norm.includes('primary') || norm.includes('dispensary') || norm.includes('health centre') || norm.includes('phc')) {
    return 'PRIMARY_CARE';
  }
  return 'SECONDARY_CARE';
}

/**
 * Helper to create an UNKNOWN operational twin when no live operational feed is connected.
 * Invariant: Never assume operational availability from static or historical registry data.
 */
function createUnknownLiveOperations(timestamp: string): HospitalDigitalTwin['liveOperations'] {
  const unknownEvidence = <T>(value: T, reason: string): EvidenceRecord<T> => ({
    value,
    source: 'UNCONFIRMED_OPERATIONS',
    sourceType: 'SYSTEM_DEFAULT',
    observedAt: timestamp,
    confidence: 0.0,
    dataStatus: 'UNKNOWN',
    notes: reason,
  });

  return {
    state: unknownEvidence<OperationalState>(
      {
        emergency: 'UNKNOWN',
        icu: 'UNKNOWN',
        trauma: 'UNKNOWN',
        nicu: 'UNKNOWN',
        picu: 'UNKNOWN',
        ventilator: 'UNKNOWN',
        acceptance: 'UNKNOWN',
        source: 'UNKNOWN',
      },
      'No authoritative live operational feed connected. Invariant enforced: operational availability is UNKNOWN.'
    ),
    emergencyDepartment: {
      intakeStatus: unknownEvidence('UNKNOWN', 'ED live intake unconfirmed'),
    },
    intensiveCare: {
      generalIcu: unknownEvidence('UNKNOWN', 'ICU live capacity unconfirmed'),
    },
    equipment: [],
    staffing: {
      emergencyPhysicianOnDuty: unknownEvidence(false, 'On-duty emergency physician roster unconfirmed'),
      interventionalCardiologistOnCall: unknownEvidence(false, 'On-call interventional cardiologist roster unconfirmed'),
      neurosurgeonOnCall: unknownEvidence(false, 'On-call neurosurgeon roster unconfirmed'),
      traumaSurgeonOnCall: unknownEvidence(false, 'On-call trauma surgeon roster unconfirmed'),
      intensivistOnDuty: unknownEvidence(false, 'On-duty intensivist roster unconfirmed'),
    },
  };
}

/**
 * Deterministic Transformation:
 * CanonicalHospitalRecord -> HospitalDigitalTwin
 *
 * Invariants Enforced:
 * 1. Historical/public records exclusively populate `historicalBaseline` (dataStatus: HISTORICAL / PUBLIC_LISTED).
 * 2. Live operational capacity strictly defaults to UNKNOWN unless verified via HOSPITAL_CONFIRMED or AUTHORIZED_FEED.
 * 3. Synthetic demo records maintain SYNTHETIC_DEMO status without contaminating canonical datasets.
 * 4. All evidence records (source, sourceType, confidence, observedAt, dataStatus, sourceUrl) survive intact.
 */
export function materializeDigitalTwin(canonical: CanonicalHospitalRecord): HospitalDigitalTwin {
  const syncTime = canonical.lastSynchronizedAt || new Date().toISOString();

  // Geography & facility locations
  const facilityLocEvidence: EvidenceRecord<LocationData> = canonical.evidence?.location || {
    value: canonical.location || { latitude: 0, longitude: 0, coordinateSource: 'UNKNOWN' },
    source: canonical.provenance[0]?.sourceId || 'UNKNOWN',
    sourceType: canonical.provenance[0]?.sourceType || 'UNKNOWN',
    observedAt: canonical.provenance[0]?.retrievedAt || syncTime,
    confidence: canonical.provenance[0]?.confidence || 0.5,
    dataStatus: canonical.dataStatus,
    sourceUrl: canonical.provenance[0]?.sourceUrl,
  };

  // Facility Tier evidence
  const tierEvidence: EvidenceRecord<FacilityTier> = canonical.evidence?.tier || {
    value: canonical.tier || inferFacilityTier(canonical.facilityType),
    source: canonical.provenance[0]?.sourceId || 'INFERENCE_RULE',
    sourceType: canonical.provenance[0]?.sourceType || 'INFERRED',
    observedAt: canonical.provenance[0]?.retrievedAt || syncTime,
    confidence: 0.8,
    dataStatus: canonical.dataStatus,
  };

  // Historical baseline: strictly historical / public
  const totalBedsEvidence: EvidenceRecord<number> = canonical.evidence?.historicalCapacity?.totalBeds || {
    value: canonical.historicalCapacity?.totalBeds || 0,
    source: canonical.provenance[0]?.sourceId || 'UNKNOWN',
    sourceType: canonical.provenance[0]?.sourceType || 'HISTORICAL_AUDIT',
    observedAt: canonical.provenance[0]?.retrievedAt || syncTime,
    confidence: canonical.provenance[0]?.confidence || 0.5,
    dataStatus: canonical.historicalCapacity?.totalBeds ? 'HISTORICAL' : 'UNKNOWN',
    sourceUrl: canonical.provenance[0]?.sourceUrl,
    notes: 'Historical static bed count. Never promoted to real-time bed availability.',
  };

  const capabilitiesEvidence: EvidenceRecord<Capabilities> = canonical.evidence?.capabilities || {
    value: canonical.capabilities || {},
    source: canonical.provenance[0]?.sourceId || 'UNKNOWN',
    sourceType: canonical.provenance[0]?.sourceType || 'PUBLIC_REGISTRY',
    observedAt: canonical.provenance[0]?.retrievedAt || syncTime,
    confidence: canonical.provenance[0]?.confidence || 0.5,
    dataStatus: 'PUBLIC_LISTED',
    sourceUrl: canonical.provenance[0]?.sourceUrl,
  };

  // Live Operations determination
  let liveOperations: HospitalDigitalTwin['liveOperations'];

  const operationalEvidence = canonical.evidence?.operationalState;
  const isAuthoritativeLive = operationalEvidence && isValidOperationalEvidence(operationalEvidence);
  const isSyntheticDemo = canonical.dataStatus === 'SYNTHETIC_DEMO' || canonical.operationalState?.source === 'SYNTHETIC_DEMO';

  if (isAuthoritativeLive) {
    // Valid live operational confirmation exists
    liveOperations = {
      state: operationalEvidence,
      emergencyDepartment: {
        intakeStatus: {
          value: operationalEvidence.value.emergency,
          source: operationalEvidence.source,
          sourceType: operationalEvidence.sourceType,
          observedAt: operationalEvidence.observedAt,
          confidence: operationalEvidence.confidence,
          dataStatus: operationalEvidence.dataStatus,
        },
      },
      intensiveCare: {
        generalIcu: {
          value: operationalEvidence.value.icu,
          source: operationalEvidence.source,
          sourceType: operationalEvidence.sourceType,
          observedAt: operationalEvidence.observedAt,
          confidence: operationalEvidence.confidence,
          dataStatus: operationalEvidence.dataStatus,
        },
      },
      equipment: [],
      staffing: {
        emergencyPhysicianOnDuty: {
          value: operationalEvidence.value.emergency === 'AVAILABLE',
          source: operationalEvidence.source,
          sourceType: operationalEvidence.sourceType,
          observedAt: operationalEvidence.observedAt,
          confidence: operationalEvidence.confidence,
          dataStatus: operationalEvidence.dataStatus,
        },
        interventionalCardiologistOnCall: {
          value: false,
          source: operationalEvidence.source,
          sourceType: operationalEvidence.sourceType,
          observedAt: operationalEvidence.observedAt,
          confidence: operationalEvidence.confidence,
          dataStatus: operationalEvidence.dataStatus,
        },
        neurosurgeonOnCall: {
          value: false,
          source: operationalEvidence.source,
          sourceType: operationalEvidence.sourceType,
          observedAt: operationalEvidence.observedAt,
          confidence: operationalEvidence.confidence,
          dataStatus: operationalEvidence.dataStatus,
        },
        traumaSurgeonOnCall: {
          value: operationalEvidence.value.trauma === 'AVAILABLE',
          source: operationalEvidence.source,
          sourceType: operationalEvidence.sourceType,
          observedAt: operationalEvidence.observedAt,
          confidence: operationalEvidence.confidence,
          dataStatus: operationalEvidence.dataStatus,
        },
        intensivistOnDuty: {
          value: operationalEvidence.value.icu === 'AVAILABLE',
          source: operationalEvidence.source,
          sourceType: operationalEvidence.sourceType,
          observedAt: operationalEvidence.observedAt,
          confidence: operationalEvidence.confidence,
          dataStatus: operationalEvidence.dataStatus,
        },
      },
    };
  } else if (isSyntheticDemo) {
    // Synthetic simulation twin
    liveOperations = {
      state: {
        value: canonical.operationalState,
        source: 'synthetic-demo-generator',
        sourceType: 'SYNTHETIC_GENERATOR',
        observedAt: syncTime,
        confidence: 1.0,
        dataStatus: 'SYNTHETIC_DEMO',
        notes: 'Simulated operational state for demonstration scenarios.',
      },
      emergencyDepartment: {
        intakeStatus: {
          value: canonical.operationalState.emergency,
          source: 'synthetic-demo-generator',
          sourceType: 'SYNTHETIC_GENERATOR',
          observedAt: syncTime,
          confidence: 1.0,
          dataStatus: 'SYNTHETIC_DEMO',
        },
      },
      intensiveCare: {
        generalIcu: {
          value: canonical.operationalState.icu,
          source: 'synthetic-demo-generator',
          sourceType: 'SYNTHETIC_GENERATOR',
          observedAt: syncTime,
          confidence: 1.0,
          dataStatus: 'SYNTHETIC_DEMO',
        },
      },
      equipment: [],
      staffing: {
        emergencyPhysicianOnDuty: {
          value: canonical.operationalState.emergency === 'AVAILABLE',
          source: 'synthetic-demo-generator',
          sourceType: 'SYNTHETIC_GENERATOR',
          observedAt: syncTime,
          confidence: 1.0,
          dataStatus: 'SYNTHETIC_DEMO',
        },
        interventionalCardiologistOnCall: {
          value: true,
          source: 'synthetic-demo-generator',
          sourceType: 'SYNTHETIC_GENERATOR',
          observedAt: syncTime,
          confidence: 1.0,
          dataStatus: 'SYNTHETIC_DEMO',
        },
        neurosurgeonOnCall: {
          value: true,
          source: 'synthetic-demo-generator',
          sourceType: 'SYNTHETIC_GENERATOR',
          observedAt: syncTime,
          confidence: 1.0,
          dataStatus: 'SYNTHETIC_DEMO',
        },
        traumaSurgeonOnCall: {
          value: canonical.operationalState.trauma === 'AVAILABLE',
          source: 'synthetic-demo-generator',
          sourceType: 'SYNTHETIC_GENERATOR',
          observedAt: syncTime,
          confidence: 1.0,
          dataStatus: 'SYNTHETIC_DEMO',
        },
        intensivistOnDuty: {
          value: canonical.operationalState.icu === 'AVAILABLE',
          source: 'synthetic-demo-generator',
          sourceType: 'SYNTHETIC_GENERATOR',
          observedAt: syncTime,
          confidence: 1.0,
          dataStatus: 'SYNTHETIC_DEMO',
        },
      },
    };
  } else {
    // Check if an illegal promotion was attempted
    if (operationalEvidence) {
      assertNoHistoricalPromotion(operationalEvidence, 'HospitalDigitalTwin liveOperations');
    }
    // Strict invariant: no confirmed live feed -> UNKNOWN
    liveOperations = createUnknownLiveOperations(syncTime);
  }

  return {
    hospitalId: canonical.hospitalId,
    displayName: canonical.displayName,
    legalName: canonical.legalName,
    tier: tierEvidence,
    regulatory: {
      kpmeRegistrationNumber: canonical.evidence?.regulatory?.kpmeRegistrationNumber,
      hfrId: canonical.evidence?.regulatory?.hfrId,
      pmjayId: canonical.evidence?.regulatory?.pmjayId,
      rohsId: canonical.evidence?.regulatory?.rohsId,
    },
    geography: {
      address: canonical.address,
      facilityLocation: facilityLocEvidence,
      ambulanceEmergencyBayLocation: canonical.evidence?.ambulanceEntranceLocation,
    },
    contact: canonical.contact || {},
    historicalBaseline: {
      totalBeds: totalBedsEvidence,
      historicalIcuBeds: canonical.evidence?.historicalCapacity?.icuBeds,
      historicalVentilators: canonical.evidence?.historicalCapacity?.ventilators,
      registeredCapabilities: capabilitiesEvidence,
    },
    liveOperations,
    lastSynchronizedAt: syncTime,
    rootDataStatus: canonical.dataStatus,
  };
}

/**
 * Validation function for a single CanonicalHospitalRecord.
 * Enforces all architectural and data invariants.
 */
export function validateCanonicalHospitalRecord(
  record: CanonicalHospitalRecord,
  options: { allowSynthetic?: boolean } = {}
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1. Required identity fields
  if (!record.hospitalId || typeof record.hospitalId !== 'string' || record.hospitalId.trim() === '') {
    errors.push(`Record missing valid hospitalId: ${JSON.stringify(record.hospitalId)}`);
  }
  if (!record.displayName || typeof record.displayName !== 'string' || record.displayName.trim() === '') {
    errors.push(`Hospital ${record.hospitalId}: missing valid displayName.`);
  }

  // 2. Required address fields
  if (!record.address || typeof record.address !== 'object') {
    errors.push(`Hospital ${record.hospitalId}: missing address object.`);
  } else {
    if (!record.address.city) errors.push(`Hospital ${record.hospitalId}: address missing city.`);
    if (!record.address.district) errors.push(`Hospital ${record.hospitalId}: address missing district.`);
    if (!record.address.state) errors.push(`Hospital ${record.hospitalId}: address missing state.`);
    if (!record.address.country) errors.push(`Hospital ${record.hospitalId}: address missing country.`);
  }

  // 3. Location coordinates validity
  if (record.location) {
    const { latitude, longitude } = record.location;
    if (typeof latitude !== 'number' || isNaN(latitude) || latitude < -90 || latitude > 90) {
      errors.push(`Hospital ${record.hospitalId}: invalid latitude ${latitude}.`);
    }
    if (typeof longitude !== 'number' || isNaN(longitude) || longitude < -180 || longitude > 180) {
      errors.push(`Hospital ${record.hospitalId}: invalid longitude ${longitude}.`);
    }
  }

  // 4. DataStatus validity
  const validStatuses: DataStatus[] = [
    'CURRENT',
    'HISTORICAL',
    'PUBLIC_LISTED',
    'HOSPITAL_CONFIRMED',
    'AUTHORIZED_FEED',
    'SYNTHETIC_DEMO',
    'UNKNOWN',
    'NOT_DISCLOSED',
    'UNVERIFIED',
  ];
  if (!validStatuses.includes(record.dataStatus)) {
    errors.push(`Hospital ${record.hospitalId}: invalid dataStatus '${record.dataStatus}'.`);
  }

  // 5. Synthetic contamination check
  if (!options.allowSynthetic && record.dataStatus === 'SYNTHETIC_DEMO') {
    errors.push(`Hospital ${record.hospitalId}: synthetic data (SYNTHETIC_DEMO) detected in canonical master dataset.`);
  }

  // 6. Provenance requirements
  if (record.dataStatus !== 'SYNTHETIC_DEMO') {
    if (!Array.isArray(record.provenance) || record.provenance.length === 0) {
      errors.push(`Hospital ${record.hospitalId}: non-synthetic canonical record has empty provenance.`);
    } else {
      for (const [idx, prov] of record.provenance.entries()) {
        if (!prov.sourceId || !prov.sourceName || !prov.sourceType) {
          errors.push(`Hospital ${record.hospitalId}: provenance item ${idx} lacks sourceId, sourceName, or sourceType.`);
        }
        if (typeof prov.confidence !== 'number' || isNaN(prov.confidence) || prov.confidence < 0 || prov.confidence > 1) {
          errors.push(`Hospital ${record.hospitalId}: impossible provenance confidence value ${prov.confidence}.`);
        }
        if (prov.retrievedAt && isNaN(Date.parse(prov.retrievedAt))) {
          errors.push(`Hospital ${record.hospitalId}: invalid retrievedAt timestamp '${prov.retrievedAt}'.`);
        }
      }
    }
  }

  // 7. Field Evidence verification (if provided)
  if (record.evidence) {
    const checkEvidenceRecord = (ev: EvidenceRecord<unknown> | undefined, fieldName: string) => {
      if (!ev) return;
      if (!ev.source || !ev.sourceType) {
        errors.push(`Hospital ${record.hospitalId} [${fieldName}]: evidence lacks source or sourceType.`);
      }
      if (typeof ev.confidence !== 'number' || isNaN(ev.confidence) || ev.confidence < 0 || ev.confidence > 1) {
        errors.push(`Hospital ${record.hospitalId} [${fieldName}]: impossible evidence confidence ${ev.confidence}.`);
      }
      if (ev.observedAt && isNaN(Date.parse(ev.observedAt))) {
        errors.push(`Hospital ${record.hospitalId} [${fieldName}]: invalid observedAt timestamp '${ev.observedAt}'.`);
      }
      if (ev.validUntil && isNaN(Date.parse(ev.validUntil))) {
        errors.push(`Hospital ${record.hospitalId} [${fieldName}]: invalid validUntil timestamp '${ev.validUntil}'.`);
      }
      if (!validStatuses.includes(ev.dataStatus)) {
        errors.push(`Hospital ${record.hospitalId} [${fieldName}]: invalid evidence dataStatus '${ev.dataStatus}'.`);
      }
    };

    checkEvidenceRecord(record.evidence.displayName, 'displayName');
    checkEvidenceRecord(record.evidence.facilityType, 'facilityType');
    checkEvidenceRecord(record.evidence.tier, 'tier');
    checkEvidenceRecord(record.evidence.address, 'address');
    checkEvidenceRecord(record.evidence.location, 'location');
    checkEvidenceRecord(record.evidence.capabilities, 'capabilities');
    checkEvidenceRecord(record.evidence.historicalCapacity?.totalBeds, 'historicalCapacity.totalBeds');
    checkEvidenceRecord(record.evidence.operationalState, 'operationalState');
  }

  // 8. Strict Invariant: No Historical / Public Promotion to Operational
  // If record has historical bed capacity or public source, operationalState cannot claim live availability without confirmed source
  if (record.dataStatus === 'PUBLIC_LISTED' || record.dataStatus === 'HISTORICAL') {
    if (
      record.operationalState.emergency !== 'UNKNOWN' ||
      record.operationalState.icu !== 'UNKNOWN' ||
      record.operationalState.trauma !== 'UNKNOWN'
    ) {
      if (
        record.operationalState.source !== 'HOSPITAL_CONFIRMED' &&
        record.operationalState.source !== 'AUTHORIZED_FEED'
      ) {
        errors.push(
          `Hospital ${record.hospitalId}: Invariant violation: public/historical facility cannot have active operational state with source '${record.operationalState.source}'. Must be UNKNOWN or backed by HOSPITAL_CONFIRMED/AUTHORIZED_FEED.`
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
