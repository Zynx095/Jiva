import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { HospitalState, DataProvenance, Address } from '@jiva/domain-models';

const rawDir = path.join(__dirname, '../data/raw');
const canonicalPath = path.join(__dirname, '../data/canonical/hospitals.json');

const hospitals: HospitalState[] = [];

function generateId(prefix: string) {
  return `HOSP-${prefix}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;
}

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
      retrievedAt: item.retrievedAt,
      verificationStatus: 'PUBLIC_LISTED',
      confidence: 0.9
    };
    
    const hosp: HospitalState = {
      hospitalId: generateId('INST'),
      displayName: item.name,
      facilityType: item.type,
      address: {
        fullAddress: item.address,
        city: 'Bengaluru',
        district: 'Bengaluru Urban',
        state: 'Karnataka',
        country: 'India'
      },
      contact: {
        phone: item.phone,
        website: item.website
      },
      capabilities: {},
      historicalCapacity: {
        totalBeds: item.totalBeds
      },
      operationalState: {
        emergency: 'UNKNOWN',
        icu: 'UNKNOWN',
        trauma: 'UNKNOWN',
        nicu: 'UNKNOWN',
        picu: 'UNKNOWN',
        ventilator: 'UNKNOWN',
        acceptance: 'UNKNOWN',
        source: 'UNKNOWN'
      },
      utilizationIndicators: [],
      provenance: [prov],
      verificationStatus: 'PUBLIC_LISTED',
      dataStatus: 'PUBLIC_LISTED'
    };
    
    // Add coordinates via a mock geocoder or hardcoded
    if (item.name.includes('Baptist')) {
      hosp.location = { latitude: 13.0334, longitude: 77.5925, coordinateSource: 'GEOCODED' };
    } else if (item.name.includes('Manipal')) {
      hosp.location = { latitude: 12.9592, longitude: 77.6485, coordinateSource: 'GEOCODED' };
    }

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
      retrievedAt: item.retrievedAt,
      verificationStatus: 'PUBLIC_LISTED',
      confidence: 0.95
    };
    
    const hosp: HospitalState = {
      hospitalId: generateId('GOVT'),
      displayName: item.hospitalName,
      facilityType: item.category,
      address: {
        fullAddress: item.address,
        pincode: item.pincode,
        city: 'Bengaluru',
        district: 'Bengaluru Urban',
        state: 'Karnataka',
        country: 'India'
      },
      capabilities: {},
      historicalCapacity: {},
      operationalState: {
        emergency: 'UNKNOWN',
        icu: 'UNKNOWN',
        trauma: 'UNKNOWN',
        nicu: 'UNKNOWN',
        picu: 'UNKNOWN',
        ventilator: 'UNKNOWN',
        acceptance: 'UNKNOWN',
        source: 'UNKNOWN'
      },
      utilizationIndicators: [],
      provenance: [prov],
      verificationStatus: 'PUBLIC_LISTED',
      dataStatus: 'PUBLIC_LISTED'
    };

    if (item.hospitalName.includes('KC General')) {
      hosp.location = { latitude: 12.9961, longitude: 77.5712, coordinateSource: 'GEOCODED' };
    } else if (item.hospitalName.includes('Jayanagar')) {
      hosp.location = { latitude: 12.9304, longitude: 77.5855, coordinateSource: 'GEOCODED' };
    } else if (item.hospitalName.includes('Bowring')) {
      hosp.location = { latitude: 12.9822, longitude: 77.6016, coordinateSource: 'GEOCODED' };
    }

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
      retrievedAt: item.retrievedAt,
      verificationStatus: 'PUBLIC_LISTED',
      confidence: 0.95
    };
    
    const hosp: HospitalState = {
      hospitalId: generateId('BBMP'),
      displayName: item.name,
      facilityType: item.category,
      address: {
        fullAddress: item.ward + ', Bengaluru',
        ward: item.ward,
        zone: item.zone,
        city: 'Bengaluru',
        district: 'Bengaluru Urban',
        state: 'Karnataka',
        country: 'India'
      },
      capabilities: {},
      historicalCapacity: {},
      operationalState: {
        emergency: 'UNKNOWN',
        icu: 'UNKNOWN',
        trauma: 'UNKNOWN',
        nicu: 'UNKNOWN',
        picu: 'UNKNOWN',
        ventilator: 'UNKNOWN',
        acceptance: 'UNKNOWN',
        source: 'UNKNOWN'
      },
      utilizationIndicators: [],
      provenance: [prov],
      verificationStatus: 'PUBLIC_LISTED',
      dataStatus: 'PUBLIC_LISTED'
    };
    
    if (item.name.includes('Srirampura')) {
       hosp.location = { latitude: 12.9926, longitude: 77.5641, coordinateSource: 'GEOCODED' };
    } else if (item.name.includes('Ulsoor')) {
       hosp.location = { latitude: 12.9779, longitude: 77.6245, coordinateSource: 'GEOCODED' };
    }

    hospitals.push(hosp);
  }
}

async function main() {
  console.log('--- JIVA DATA PIPELINE: NORMALIZE & DEDUPE ---');
  processInstitutions();
  processBengaluruUrban();
  processBbmp();
  
  console.log(`Normalized ${hospitals.length} records.`);
  
  // Basic Deduplication Logic (Entity Resolution)
  // For this mock, we just assume names are unique enough. In production, use Jaro-Winkler + coordinates.
  const deduplicated = [];
  const seenNames = new Set<string>();
  
  for (const h of hospitals) {
    const canonicalName = h.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!seenNames.has(canonicalName)) {
      seenNames.add(canonicalName);
      deduplicated.push(h);
    } else {
      console.log(`[Dedupe] Merging duplicate: ${h.displayName}`);
      // Find original and merge provenance
      const orig = deduplicated.find(o => o.displayName.toLowerCase().replace(/[^a-z0-9]/g, '') === canonicalName);
      if (orig) {
        orig.provenance.push(...h.provenance);
      }
    }
  }
  
  fs.writeFileSync(canonicalPath, JSON.stringify(deduplicated, null, 2));
  console.log(`✓ Saved ${deduplicated.length} canonical records to ${canonicalPath}`);
}

main();
