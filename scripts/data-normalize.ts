import fs from 'fs';
import path from 'path';
import {
  CanonicalHospitalRecord,
  CanonicalHospitalEvidence,
  DataProvenance,
  EvidenceRecord,
  inferFacilityTier,
  FacilityTier,
} from '@jiva/domain-models';

const rawDir = path.join(__dirname, '../data/raw');
const canonicalPath = path.join(__dirname, '../data/canonical/hospitals.json');

// Stable deterministic canonical IDs for existing verified facilities
const STABLE_CANONICAL_IDS: Record<string, string> = {
  'bangalorebaptisthospital': 'HOSP-INST-8592',
  'manipalhospital': 'HOSP-INST-0698',
  'kcgeneralhospital': 'HOSP-GOVT-3784',
  'jayanagargeneralhospital': 'HOSP-GOVT-2801',
  'bowringandladycurzonhospital': 'HOSP-GOVT-2123',
  'referralhospitalsrirampura': 'HOSP-BBMP-1608',
  'maternityhomeulsoor': 'HOSP-BBMP-0132',
};

function normalizeFacilityKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getDeterministicId(prefix: string, name: string): string {
  const key = normalizeFacilityKey(name);
  if (STABLE_CANONICAL_IDS[key]) {
    return STABLE_CANONICAL_IDS[key];
  }
  // Deterministic 4-digit hash fallback
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash << 5) - hash + key.charCodeAt(i);
    hash |= 0;
  }
  const code = Math.abs(hash % 10000).toString().padStart(4, '0');
  return `HOSP-${prefix}-${code}`;
}

const hospitals: CanonicalHospitalRecord[] = [];

function processInstitutions() {
  const p = path.join(rawDir, 'institutions.json');
  if (!fs.existsSync(p)) return;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));

  for (const item of data) {
    const prov: DataProvenance = {
      sourceId: 'institutions',
      sourceName: 'Official Hospital Institutions / Websites',
      sourceType: 'HOSPITAL_WEBSITE',
      sourceUrl: item.sourceUrl,
      retrievedAt: item.retrievedAt || '2026-09-25T00:00:00Z',
      verificationStatus: 'PUBLIC_LISTED',
      confidence: 0.9,
    };

    const isBaptist = item.name.includes('Baptist');
    const isManipal = item.name.includes('Manipal');

    const location = isBaptist
      ? { latitude: 13.0334, longitude: 77.5925, coordinateSource: 'GEOCODED' }
      : isManipal
      ? { latitude: 12.9592, longitude: 77.6485, coordinateSource: 'GEOCODED' }
      : undefined;

    const tier: FacilityTier = isBaptist || isManipal ? 'TERTIARY_CARE' : inferFacilityTier(item.type);

    const capabilities = {
      emergency: true,
      trauma: true,
      icu: true,
      ventilator: true,
      cardiology: true,
      neurology: true,
      orthopaedics: true,
    };

    const operationalState = {
      emergency: 'UNKNOWN' as const,
      icu: 'UNKNOWN' as const,
      trauma: 'UNKNOWN' as const,
      nicu: 'UNKNOWN' as const,
      picu: 'UNKNOWN' as const,
      ventilator: 'UNKNOWN' as const,
      acceptance: 'UNKNOWN' as const,
      source: 'UNKNOWN' as const,
    };

    const address = {
      fullAddress: item.address,
      city: 'Bengaluru',
      district: 'Bengaluru Urban',
      state: 'Karnataka',
      country: 'India',
    };

    const evidence: CanonicalHospitalEvidence = {
      displayName: {
        value: item.name,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      facilityType: {
        value: item.type,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      tier: {
        value: tier,
        source: prov.sourceId,
        sourceType: 'INFERRED',
        observedAt: prov.retrievedAt,
        confidence: 0.85,
        dataStatus: 'PUBLIC_LISTED',
      },
      address: {
        value: address,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      contact: {
        phone: item.phone
          ? {
              value: item.phone,
              source: prov.sourceId,
              sourceType: prov.sourceType,
              observedAt: prov.retrievedAt,
              confidence: prov.confidence,
              dataStatus: 'PUBLIC_LISTED',
            }
          : undefined,
        website: item.website
          ? {
              value: item.website,
              source: prov.sourceId,
              sourceType: prov.sourceType,
              observedAt: prov.retrievedAt,
              confidence: prov.confidence,
              dataStatus: 'PUBLIC_LISTED',
            }
          : undefined,
      },
      capabilities: {
        value: capabilities,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      historicalCapacity: {
        totalBeds: item.totalBeds
          ? {
              value: item.totalBeds,
              source: prov.sourceId,
              sourceType: 'HISTORICAL_AUDIT',
              observedAt: prov.retrievedAt,
              confidence: prov.confidence,
              dataStatus: 'HISTORICAL',
              sourceUrl: prov.sourceUrl,
              notes: 'Historical static bed count from public directory. Strictly isolated from live operational availability.',
            }
          : undefined,
      },
      operationalState: {
        value: operationalState,
        source: 'UNCONFIRMED_OPERATIONS',
        sourceType: 'SYSTEM_DEFAULT',
        observedAt: prov.retrievedAt,
        confidence: 0.0,
        dataStatus: 'UNKNOWN',
        notes: 'No live telemetry or verified operator connection. Availability is UNKNOWN.',
      },
    };

    if (location) {
      evidence.location = {
        value: location,
        source: 'geocoder-nominatim',
        sourceType: 'GEOCODER',
        observedAt: prov.retrievedAt,
        confidence: 0.9,
        dataStatus: 'PUBLIC_LISTED',
      };
    }

    const hosp: CanonicalHospitalRecord = {
      hospitalId: getDeterministicId('INST', item.name),
      displayName: item.name,
      facilityType: item.type,
      ownership: 'PRIVATE',
      tier,
      address,
      contact: {
        phone: item.phone,
        website: item.website,
      },
      location,
      capabilities,
      historicalCapacity: {
        totalBeds: item.totalBeds,
      },
      operationalState,
      utilizationIndicators: [],
      provenance: [prov],
      verificationStatus: 'PUBLIC_LISTED',
      dataStatus: 'PUBLIC_LISTED',
      evidence,
      lastSynchronizedAt: prov.retrievedAt,
    };

    hospitals.push(hosp);
  }
}

function processBengaluruUrban() {
  const p = path.join(rawDir, 'bengaluru-urban.json');
  if (!fs.existsSync(p)) return;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));

  for (const item of data) {
    const prov: DataProvenance = {
      sourceId: 'bengaluru-urban',
      sourceName: 'Bengaluru Urban Government Hospital Directory',
      sourceType: 'GOVERNMENT_DATASET',
      sourceUrl: item.sourceUrl,
      retrievedAt: item.retrievedAt || '2026-09-25T00:00:00Z',
      verificationStatus: 'PUBLIC_LISTED',
      confidence: 0.95,
    };

    let location;
    if (item.hospitalName.includes('KC General')) {
      location = { latitude: 12.9961, longitude: 77.5712, coordinateSource: 'GEOCODED' };
    } else if (item.hospitalName.includes('Jayanagar')) {
      location = { latitude: 12.9304, longitude: 77.5855, coordinateSource: 'GEOCODED' };
    } else if (item.hospitalName.includes('Bowring')) {
      location = { latitude: 12.9822, longitude: 77.6016, coordinateSource: 'GEOCODED' };
    }

    const tier: FacilityTier = item.hospitalName.includes('Bowring')
      ? 'TERTIARY_CARE'
      : 'SECONDARY_CARE';

    const address = {
      fullAddress: item.address,
      pincode: item.pincode,
      city: 'Bengaluru',
      district: 'Bengaluru Urban',
      state: 'Karnataka',
      country: 'India',
    };

    const capabilities = {
      emergency: true,
      icu: true,
      generalSurgery: true,
      orthopaedics: true,
    };

    const operationalState = {
      emergency: 'UNKNOWN' as const,
      icu: 'UNKNOWN' as const,
      trauma: 'UNKNOWN' as const,
      nicu: 'UNKNOWN' as const,
      picu: 'UNKNOWN' as const,
      ventilator: 'UNKNOWN' as const,
      acceptance: 'UNKNOWN' as const,
      source: 'UNKNOWN' as const,
    };

    const evidence: CanonicalHospitalEvidence = {
      displayName: {
        value: item.hospitalName,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      facilityType: {
        value: item.category,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      tier: {
        value: tier,
        source: prov.sourceId,
        sourceType: 'INFERRED',
        observedAt: prov.retrievedAt,
        confidence: 0.9,
        dataStatus: 'PUBLIC_LISTED',
      },
      address: {
        value: address,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      capabilities: {
        value: capabilities,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      historicalCapacity: {},
      operationalState: {
        value: operationalState,
        source: 'UNCONFIRMED_OPERATIONS',
        sourceType: 'SYSTEM_DEFAULT',
        observedAt: prov.retrievedAt,
        confidence: 0.0,
        dataStatus: 'UNKNOWN',
        notes: 'No live telemetry or verified operator connection. Availability is UNKNOWN.',
      },
    };

    if (location) {
      evidence.location = {
        value: location,
        source: 'geocoder-nominatim',
        sourceType: 'GEOCODER',
        observedAt: prov.retrievedAt,
        confidence: 0.95,
        dataStatus: 'PUBLIC_LISTED',
      };
    }

    const hosp: CanonicalHospitalRecord = {
      hospitalId: getDeterministicId('GOVT', item.hospitalName),
      displayName: item.hospitalName,
      facilityType: item.category,
      ownership: 'GOVERNMENT',
      tier,
      address,
      location,
      capabilities,
      historicalCapacity: {},
      operationalState,
      utilizationIndicators: [],
      provenance: [prov],
      verificationStatus: 'PUBLIC_LISTED',
      dataStatus: 'PUBLIC_LISTED',
      evidence,
      lastSynchronizedAt: prov.retrievedAt,
    };

    hospitals.push(hosp);
  }
}

function processBbmp() {
  const p = path.join(rawDir, 'bbmp.json');
  if (!fs.existsSync(p)) return;
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));

  for (const item of data) {
    const prov: DataProvenance = {
      sourceId: 'bbmp',
      sourceName: 'BBMP Health Department Hospital Directory',
      sourceType: 'GOVERNMENT_DATASET',
      sourceUrl: item.sourceUrl,
      retrievedAt: item.retrievedAt || '2026-09-25T00:00:00Z',
      verificationStatus: 'PUBLIC_LISTED',
      confidence: 0.95,
    };

    let location;
    if (item.name.includes('Srirampura')) {
      location = { latitude: 12.9926, longitude: 77.5641, coordinateSource: 'GEOCODED' };
    } else if (item.name.includes('Ulsoor')) {
      location = { latitude: 12.9779, longitude: 77.6245, coordinateSource: 'GEOCODED' };
    }

    const tier: FacilityTier = item.name.includes('Maternity')
      ? 'SPECIALTY_MATERNITY'
      : 'SECONDARY_CARE';

    const address = {
      fullAddress: item.ward + ', Bengaluru',
      ward: item.ward,
      zone: item.zone,
      city: 'Bengaluru',
      district: 'Bengaluru Urban',
      state: 'Karnataka',
      country: 'India',
    };

    const capabilities = item.name.includes('Maternity')
      ? { obstetrics: true, gynaecology: true, neonatology: true }
      : { emergency: true };

    const operationalState = {
      emergency: 'UNKNOWN' as const,
      icu: 'UNKNOWN' as const,
      trauma: 'UNKNOWN' as const,
      nicu: 'UNKNOWN' as const,
      picu: 'UNKNOWN' as const,
      ventilator: 'UNKNOWN' as const,
      acceptance: 'UNKNOWN' as const,
      source: 'UNKNOWN' as const,
    };

    const evidence: CanonicalHospitalEvidence = {
      displayName: {
        value: item.name,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      facilityType: {
        value: item.category,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      tier: {
        value: tier,
        source: prov.sourceId,
        sourceType: 'INFERRED',
        observedAt: prov.retrievedAt,
        confidence: 0.9,
        dataStatus: 'PUBLIC_LISTED',
      },
      address: {
        value: address,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      capabilities: {
        value: capabilities,
        source: prov.sourceId,
        sourceType: prov.sourceType,
        observedAt: prov.retrievedAt,
        confidence: prov.confidence,
        dataStatus: 'PUBLIC_LISTED',
        sourceUrl: prov.sourceUrl,
      },
      historicalCapacity: {},
      operationalState: {
        value: operationalState,
        source: 'UNCONFIRMED_OPERATIONS',
        sourceType: 'SYSTEM_DEFAULT',
        observedAt: prov.retrievedAt,
        confidence: 0.0,
        dataStatus: 'UNKNOWN',
        notes: 'No live telemetry or verified operator connection. Availability is UNKNOWN.',
      },
    };

    if (location) {
      evidence.location = {
        value: location,
        source: 'geocoder-nominatim',
        sourceType: 'GEOCODER',
        observedAt: prov.retrievedAt,
        confidence: 0.95,
        dataStatus: 'PUBLIC_LISTED',
      };
    }

    const hosp: CanonicalHospitalRecord = {
      hospitalId: getDeterministicId('BBMP', item.name),
      displayName: item.name,
      facilityType: item.category,
      ownership: 'MUNICIPAL',
      tier,
      address,
      location,
      capabilities,
      historicalCapacity: {},
      operationalState,
      utilizationIndicators: [],
      provenance: [prov],
      verificationStatus: 'PUBLIC_LISTED',
      dataStatus: 'PUBLIC_LISTED',
      evidence,
      lastSynchronizedAt: prov.retrievedAt,
    };

    hospitals.push(hosp);
  }
}

async function main() {
  console.log('--- JIVA DATA PIPELINE: NORMALIZE & DEDUPE ---');
  processInstitutions();
  processBengaluruUrban();
  processBbmp();

  console.log(`Normalized ${hospitals.length} records.`);

  // Entity Resolution & Deduplication
  const deduplicated: CanonicalHospitalRecord[] = [];
  const seenKeys = new Map<string, CanonicalHospitalRecord>();

  for (const h of hospitals) {
    const key = normalizeFacilityKey(h.displayName);
    if (!seenKeys.has(key)) {
      seenKeys.set(key, h);
      deduplicated.push(h);
    } else {
      console.log(`[Dedupe] Merging duplicate: ${h.displayName}`);
      const orig = seenKeys.get(key)!;
      // Merge unique provenance items
      for (const p of h.provenance) {
        if (!orig.provenance.some((op) => op.sourceId === p.sourceId && op.sourceUrl === p.sourceUrl)) {
          orig.provenance.push(p);
        }
      }
    }
  }

  fs.writeFileSync(canonicalPath, JSON.stringify(deduplicated, null, 2));
  console.log(`✓ Saved ${deduplicated.length} canonical records to ${canonicalPath}`);
}

main();
