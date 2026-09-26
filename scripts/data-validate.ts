import fs from 'fs';
import path from 'path';
import { HospitalState } from '@jiva/domain-models';

const canonicalPath = path.join(__dirname, '../data/canonical/hospitals.json');
const reportPath = path.join(__dirname, '../data/validation/reports/data-quality-report.json');

async function main() {
  console.log('--- JIVA DATA PIPELINE: VALIDATE ---');
  
  if (!fs.existsSync(canonicalPath)) {
    console.error('Canonical file not found.');
    return;
  }
  
  const data: HospitalState[] = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
  
  const report = {
    totalFacilities: data.length,
    facilitiesWithCoordinates: 0,
    facilitiesWithPhone: 0,
    facilitiesWithOfficialSource: 0,
    facilitiesWithHistoricalBeds: 0,
    facilitiesWithCurrentOperationalData: 0,
    facilitiesWithUnknownCapacity: 0,
    unverifiedFields: 0,
    historicalFields: 0,
    errors: [] as string[]
  };

  for (const h of data) {
    if (h.location?.latitude && h.location?.longitude) report.facilitiesWithCoordinates++;
    if (h.contact?.phone) report.facilitiesWithPhone++;
    
    if (h.provenance.length > 0) report.facilitiesWithOfficialSource++;
    
    if (h.historicalCapacity.totalBeds) report.facilitiesWithHistoricalBeds++;
    
    if (h.operationalState.source === 'HOSPITAL_CONFIRMED' || h.operationalState.source === 'AUTHORIZED_FEED') {
      report.facilitiesWithCurrentOperationalData++;
    } else {
      report.facilitiesWithUnknownCapacity++;
    }

    // Check strict rule: no current capacity inferred from historical data
    if (h.historicalCapacity.totalBeds && (h.operationalState.emergency !== 'UNKNOWN' && h.operationalState.source !== 'SYNTHETIC_DEMO')) {
       // if we have historical data but also claim emergency availability without proper source
       if (h.operationalState.source !== 'HOSPITAL_CONFIRMED' && h.operationalState.source !== 'AUTHORIZED_FEED') {
          report.errors.push(`Hospital ${h.hospitalId} has operational data but lacks a confirmed source.`);
       }
    }
  }

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`✓ Validation complete. Report saved to ${reportPath}`);
  
  if (report.errors.length > 0) {
    console.error('VALIDATION ERRORS:', report.errors);
    process.exit(1);
  }
}

main();
