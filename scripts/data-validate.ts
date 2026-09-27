import fs from 'fs';
import path from 'path';
import {
  CanonicalHospitalRecord,
  validateCanonicalHospitalRecord,
  materializeDigitalTwin,
} from '@jiva/domain-models';

const canonicalPath = path.join(__dirname, '../data/canonical/hospitals.json');
const syntheticPath = path.join(__dirname, '../data/synthetic/bengaluru/hospitals.json');
const reportPath = path.join(__dirname, '../data/validation/reports/data-quality-report.json');

function normalizeFacilityKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
  console.log('--- JIVA DATA PIPELINE: VALIDATE ---');

  if (!fs.existsSync(canonicalPath)) {
    console.error(`Canonical file not found at ${canonicalPath}`);
    process.exit(1);
  }

  const data: CanonicalHospitalRecord[] = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));

  const report = {
    totalFacilities: data.length,
    facilitiesWithCoordinates: 0,
    facilitiesWithPhone: 0,
    facilitiesWithOfficialSource: 0,
    facilitiesWithHistoricalBeds: 0,
    facilitiesWithCurrentOperationalData: 0,
    facilitiesWithUnknownCapacity: 0,
    facilitiesWithEvidenceMapping: 0,
    digitalTwinsMaterialized: 0,
    unverifiedFields: 0,
    historicalFields: 0,
    errors: [] as string[],
  };

  const seenIds = new Set<string>();
  const seenFacilityNames = new Map<string, string>();

  for (const h of data) {
    // 1. Detect duplicate canonical IDs
    if (!h.hospitalId) {
      report.errors.push('Facility found with missing or undefined hospitalId.');
    } else if (seenIds.has(h.hospitalId)) {
      report.errors.push(`Duplicate canonical ID detected: ${h.hospitalId}`);
    } else {
      seenIds.add(h.hospitalId);
    }

    // 2. Detect duplicate facility identities
    if (h.displayName) {
      const key = normalizeFacilityKey(h.displayName);
      if (seenFacilityNames.has(key)) {
        report.errors.push(
          `Duplicate facility detected: '${h.displayName}' duplicates '${seenFacilityNames.get(key)}' under normalized key '${key}'`
        );
      } else {
        seenFacilityNames.set(key, h.displayName);
      }
    }

    // 3. Run model-level validator
    const { valid, errors: modelErrors } = validateCanonicalHospitalRecord(h, { allowSynthetic: false });
    if (!valid) {
      report.errors.push(...modelErrors);
    }

    // 4. Coordinates range & validity
    if (h.location?.latitude && h.location?.longitude) {
      report.facilitiesWithCoordinates++;
      // Bengaluru region boundary check
      if (h.location.latitude < 12.0 || h.location.latitude > 14.5 || h.location.longitude < 77.0 || h.location.longitude > 78.5) {
        report.errors.push(
          `Hospital ${h.hospitalId}: coordinates [${h.location.latitude}, ${h.location.longitude}] are outside expected Bengaluru bounding box.`
        );
      }
    }

    if (h.contact?.phone) report.facilitiesWithPhone++;
    if (h.provenance && h.provenance.length > 0) report.facilitiesWithOfficialSource++;
    if (h.historicalCapacity?.totalBeds) {
      report.facilitiesWithHistoricalBeds++;
      report.historicalFields++;
    }

    // 5. Operational capacity classification
    if (h.operationalState.source === 'HOSPITAL_CONFIRMED' || h.operationalState.source === 'AUTHORIZED_FEED') {
      report.facilitiesWithCurrentOperationalData++;
    } else {
      report.facilitiesWithUnknownCapacity++;
    }

    // 6. Invariant: No promoting historical bed count into operational state
    if (h.historicalCapacity?.totalBeds && h.operationalState.emergency !== 'UNKNOWN') {
      if (h.operationalState.source !== 'HOSPITAL_CONFIRMED' && h.operationalState.source !== 'AUTHORIZED_FEED') {
        report.errors.push(
          `Hospital ${h.hospitalId} has historical bed data (${h.historicalCapacity.totalBeds}) but asserts operational state without confirmed source: '${h.operationalState.source}'.`
        );
      }
    }

    // 7. Verify field-level evidence mapping
    if (h.evidence) {
      report.facilitiesWithEvidenceMapping++;
      if (h.evidence.historicalCapacity?.totalBeds) {
        if (h.evidence.historicalCapacity.totalBeds.dataStatus !== 'HISTORICAL') {
          report.errors.push(
            `Hospital ${h.hospitalId}: historical bed capacity must carry dataStatus 'HISTORICAL', found '${h.evidence.historicalCapacity.totalBeds.dataStatus}'.`
          );
        }
      }
      if (h.evidence.capabilities && h.evidence.capabilities.dataStatus !== 'PUBLIC_LISTED') {
        report.errors.push(
          `Hospital ${h.hospitalId}: public capabilities must carry dataStatus 'PUBLIC_LISTED', found '${h.evidence.capabilities.dataStatus}'.`
        );
      }
    }

    // 8. Test Digital Twin materialization
    try {
      const twin = materializeDigitalTwin(h);
      report.digitalTwinsMaterialized++;

      // Invariant: Digital twin of canonical public hospital must have liveOperations state as UNKNOWN
      if (twin.liveOperations.state.dataStatus !== 'UNKNOWN') {
        report.errors.push(
          `Hospital ${h.hospitalId}: Materialized digital twin liveOperations must have dataStatus 'UNKNOWN' for public canonical records, found '${twin.liveOperations.state.dataStatus}'.`
        );
      }
      if (twin.historicalBaseline.registeredCapabilities.dataStatus !== 'PUBLIC_LISTED') {
        report.errors.push(
          `Hospital ${h.hospitalId}: Digital twin registeredCapabilities must be 'PUBLIC_LISTED'.`
        );
      }
    } catch (err: any) {
      report.errors.push(`Hospital ${h.hospitalId}: Materialization failed: ${err.message}`);
    }
  }

  // 9. Inspect synthetic dataset separation (ensure demo records remain distinguishable)
  if (fs.existsSync(syntheticPath)) {
    const syntheticData = JSON.parse(fs.readFileSync(syntheticPath, 'utf8'));
    for (const sh of syntheticData) {
      if (sh.dataStatus !== 'SYNTHETIC_DEMO') {
        report.errors.push(
          `Synthetic hospital ${sh.hospitalId} must carry dataStatus 'SYNTHETIC_DEMO', found '${sh.dataStatus}'.`
        );
      }
      if (seenIds.has(sh.hospitalId)) {
        report.errors.push(
          `ID collision between synthetic hospital ${sh.hospitalId} and canonical dataset.`
        );
      }
    }
  }

  // Ensure report directory exists
  const reportDir = path.dirname(reportPath);
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`✓ Validation complete. Report saved to ${reportPath}`);

  if (report.errors.length > 0) {
    console.error(`✗ VALIDATION FAILED with ${report.errors.length} error(s):`);
    for (const err of report.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(`✓ All ${report.totalFacilities} canonical facilities passed invariant and evidence validation.`);
  console.log(`✓ Digital twin materialization verified for all ${report.digitalTwinsMaterialized} facilities.`);
}

main();
