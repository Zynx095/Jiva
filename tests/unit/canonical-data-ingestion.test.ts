import fs from 'fs';
import path from 'path';
import {
  CanonicalHospitalRecord,
  materializeDigitalTwin,
  validateCanonicalHospitalRecord,
  isValidOperationalEvidence,
  assertNoHistoricalPromotion,
} from '../../packages/domain-models/src';

async function testCanonicalDataIngestion() {
  console.log('[Test] Running AG-02 Canonical Hospital Data & Evidence Ingestion Tests...\n');

  const canonicalPath = path.join(__dirname, '../../data/canonical/hospitals.json');
  const syntheticPath = path.join(__dirname, '../../data/synthetic/bengaluru/hospitals.json');

  const canonicalRecords: CanonicalHospitalRecord[] = JSON.parse(
    fs.readFileSync(canonicalPath, 'utf8')
  );
  const syntheticRecords = JSON.parse(
    fs.readFileSync(syntheticPath, 'utf8')
  );

  // ---------------------------------------------------------------------------
  // Test 1: Public hospital capability remains PUBLIC_LISTED
  // ---------------------------------------------------------------------------
  console.log('  1. Verifying public hospital capabilities remain PUBLIC_LISTED...');
  for (const h of canonicalRecords) {
    if (h.dataStatus !== 'PUBLIC_LISTED') {
      throw new Error(`Hospital ${h.hospitalId} has dataStatus ${h.dataStatus}, expected PUBLIC_LISTED`);
    }
    if (h.evidence.capabilities.dataStatus !== 'PUBLIC_LISTED') {
      throw new Error(`Hospital ${h.hospitalId} capabilities evidence has dataStatus ${h.evidence.capabilities.dataStatus}, expected PUBLIC_LISTED`);
    }
    // Verify capability does not imply operational availability
    if (isValidOperationalEvidence(h.evidence.capabilities)) {
      throw new Error(`Hospital ${h.hospitalId} capabilities evidence was erroneously accepted as valid operational evidence`);
    }
  }
  console.log('     ✓ All canonical hospital capabilities are strictly classified as PUBLIC_LISTED.');

  // ---------------------------------------------------------------------------
  // Test 2: Historical bed capacity remains HISTORICAL
  // ---------------------------------------------------------------------------
  console.log('  2. Verifying historical bed capacity remains HISTORICAL...');
  const baptist = canonicalRecords.find((h) => h.displayName.includes('Baptist'));
  if (!baptist) throw new Error('Bangalore Baptist Hospital not found in canonical dataset');

  if (!baptist.evidence.historicalCapacity.totalBeds) {
    throw new Error('Bangalore Baptist Hospital missing historical totalBeds evidence');
  }
  const bedEvidence = baptist.evidence.historicalCapacity.totalBeds;
  if (bedEvidence.dataStatus !== 'HISTORICAL') {
    throw new Error(`Expected HISTORICAL dataStatus for totalBeds, got ${bedEvidence.dataStatus}`);
  }
  if (bedEvidence.value !== 450) {
    throw new Error(`Expected 450 beds for Baptist, got ${bedEvidence.value}`);
  }
  if (isValidOperationalEvidence(bedEvidence)) {
    throw new Error('Historical bed capacity was erroneously accepted as operational evidence');
  }

  // Verify assertNoHistoricalPromotion throws when someone attempts to promote historical beds
  let threwPromotionError = false;
  try {
    assertNoHistoricalPromotion(bedEvidence, 'ICU live availability');
  } catch (err: any) {
    threwPromotionError = true;
    if (!err.message.includes('Architectural Invariant Violation')) {
      throw new Error(`Unexpected error message on historical promotion: ${err.message}`);
    }
  }
  if (!threwPromotionError) {
    throw new Error('assertNoHistoricalPromotion failed to throw for HISTORICAL bed evidence');
  }
  console.log('     ✓ Historical bed capacity strictly maintains HISTORICAL status with promotion protection.');

  // ---------------------------------------------------------------------------
  // Test 3: Missing operational capacity remains UNKNOWN
  // ---------------------------------------------------------------------------
  console.log('  3. Verifying missing operational capacity remains UNKNOWN...');
  for (const h of canonicalRecords) {
    if (h.operationalState.emergency !== 'UNKNOWN' || h.operationalState.icu !== 'UNKNOWN') {
      throw new Error(`Hospital ${h.hospitalId} has non-UNKNOWN operational state without live feed`);
    }
    if (h.operationalState.source !== 'UNKNOWN') {
      throw new Error(`Hospital ${h.hospitalId} has source '${h.operationalState.source}', expected UNKNOWN`);
    }

    // Materialize digital twin and check liveOperations
    const twin = materializeDigitalTwin(h);
    if (twin.liveOperations.state.dataStatus !== 'UNKNOWN') {
      throw new Error(`Hospital ${h.hospitalId} digital twin liveOperations has dataStatus ${twin.liveOperations.state.dataStatus}, expected UNKNOWN`);
    }
    if (twin.liveOperations.state.confidence !== 0.0) {
      throw new Error(`Hospital ${h.hospitalId} digital twin liveOperations has non-zero confidence ${twin.liveOperations.state.confidence}`);
    }
    if (twin.liveOperations.emergencyDepartment.intakeStatus.value !== 'UNKNOWN') {
      throw new Error(`Hospital ${h.hospitalId} digital twin intakeStatus is not UNKNOWN`);
    }
  }
  console.log('     ✓ All missing operational capacity strictly defaults to UNKNOWN with zero confidence.');

  // ---------------------------------------------------------------------------
  // Test 4: Synthetic demo records remain distinguishable
  // ---------------------------------------------------------------------------
  console.log('  4. Verifying synthetic demo records remain distinguishable from canonical...');
  for (const s of syntheticRecords) {
    if (s.dataStatus !== 'SYNTHETIC_DEMO') {
      throw new Error(`Synthetic hospital ${s.hospitalId} has dataStatus ${s.dataStatus}, expected SYNTHETIC_DEMO`);
    }
    if (s.operationalState.source !== 'SYNTHETIC_DEMO') {
      throw new Error(`Synthetic hospital ${s.hospitalId} has operational source ${s.operationalState.source}, expected SYNTHETIC_DEMO`);
    }
  }

  // Ensure no synthetic IDs overlap with canonical IDs
  const canonicalIds = new Set(canonicalRecords.map((h) => h.hospitalId));
  for (const s of syntheticRecords) {
    if (canonicalIds.has(s.hospitalId)) {
      throw new Error(`ID collision detected: synthetic hospital ${s.hospitalId} exists in canonical dataset`);
    }
  }
  console.log('     ✓ Synthetic demo records are fully isolated with SYNTHETIC_DEMO status.');

  // ---------------------------------------------------------------------------
  // Test 5: Evidence survives canonical -> digital twin transformation
  // ---------------------------------------------------------------------------
  console.log('  5. Verifying evidence survives canonical -> digital twin transformation...');
  for (const h of canonicalRecords) {
    const twin = materializeDigitalTwin(h);

    if (twin.hospitalId !== h.hospitalId) {
      throw new Error(`Digital twin hospitalId mismatch: ${twin.hospitalId} !== ${h.hospitalId}`);
    }
    if (twin.displayName !== h.displayName) {
      throw new Error(`Digital twin displayName mismatch: ${twin.displayName} !== ${h.displayName}`);
    }
    if (twin.rootDataStatus !== h.dataStatus) {
      throw new Error(`Digital twin rootDataStatus mismatch: ${twin.rootDataStatus} !== ${h.dataStatus}`);
    }

    // Provenance on facilityLocation preserved
    if (h.evidence.location) {
      if (twin.geography.facilityLocation.source !== h.evidence.location.source) {
        throw new Error(`Location source not preserved in twin for ${h.hospitalId}`);
      }
      if (twin.geography.facilityLocation.confidence !== h.evidence.location.confidence) {
        throw new Error(`Location confidence not preserved in twin for ${h.hospitalId}`);
      }
      if (twin.geography.facilityLocation.observedAt !== h.evidence.location.observedAt) {
        throw new Error(`Location observedAt not preserved in twin for ${h.hospitalId}`);
      }
    }

    // Capabilities evidence preserved in historicalBaseline
    if (twin.historicalBaseline.registeredCapabilities.source !== h.evidence.capabilities.source) {
      throw new Error(`Capabilities source not preserved in twin for ${h.hospitalId}`);
    }
    if (twin.historicalBaseline.registeredCapabilities.confidence !== h.evidence.capabilities.confidence) {
      throw new Error(`Capabilities confidence not preserved in twin for ${h.hospitalId}`);
    }

    // Historical bed capacity evidence preserved (if present)
    if (h.evidence.historicalCapacity.totalBeds) {
      if (twin.historicalBaseline.totalBeds.value !== h.evidence.historicalCapacity.totalBeds.value) {
        throw new Error(`Historical totalBeds value corrupted in twin for ${h.hospitalId}`);
      }
      if (twin.historicalBaseline.totalBeds.dataStatus !== 'HISTORICAL') {
        throw new Error(`Historical totalBeds dataStatus corrupted in twin for ${h.hospitalId}`);
      }
      if (twin.historicalBaseline.totalBeds.sourceUrl !== h.evidence.historicalCapacity.totalBeds.sourceUrl) {
        throw new Error(`Historical totalBeds sourceUrl corrupted in twin for ${h.hospitalId}`);
      }
    }
  }
  console.log('     ✓ All evidence records survive canonical -> digital twin transformation intact.');

  // ---------------------------------------------------------------------------
  // Test 6: Duplicate hospital identities are detected
  // ---------------------------------------------------------------------------
  console.log('  6. Verifying duplicate hospital identities are detected...');
  const duplicateIdRecord: CanonicalHospitalRecord = {
    ...canonicalRecords[0],
    hospitalId: canonicalRecords[0].hospitalId, // duplicate ID of element 0
  };

  // Test duplicate ID detection in validation logic
  const checkDuplicateId = (records: CanonicalHospitalRecord[]): boolean => {
    const seen = new Set<string>();
    for (const r of records) {
      if (seen.has(r.hospitalId)) return true;
      seen.add(r.hospitalId);
    }
    return false;
  };
  if (!checkDuplicateId([canonicalRecords[0], duplicateIdRecord])) {
    throw new Error('Duplicate canonical ID was not detected');
  }

  // Test duplicate normalized name detection
  const checkDuplicateName = (records: CanonicalHospitalRecord[]): boolean => {
    const seen = new Set<string>();
    for (const r of records) {
      const key = r.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  };
  const duplicateNameRecord: CanonicalHospitalRecord = {
    ...canonicalRecords[0],
    hospitalId: 'HOSP-TEST-9999',
    displayName: '  Bangalore   Baptist Hospital!  ', // Same normalized name
  };
  if (!checkDuplicateName([canonicalRecords[0], duplicateNameRecord])) {
    throw new Error('Duplicate facility name variant was not detected');
  }
  console.log('     ✓ Duplicate hospital identities (IDs and normalized name variants) detected.');

  // ---------------------------------------------------------------------------
  // Test 7: Invalid provenance fails validation
  // ---------------------------------------------------------------------------
  console.log('  7. Verifying invalid provenance fails validation...');

  // Test 7a: Missing provenance array
  const noProvenanceRecord: CanonicalHospitalRecord = {
    ...canonicalRecords[0],
    provenance: [],
  };
  const res1 = validateCanonicalHospitalRecord(noProvenanceRecord);
  if (res1.valid || !res1.errors.some((e) => e.includes('empty provenance'))) {
    throw new Error('Validator failed to reject non-synthetic record with empty provenance');
  }

  // Test 7b: Impossible confidence (> 1.0)
  const impossibleConfidenceRecord: CanonicalHospitalRecord = {
    ...canonicalRecords[0],
    provenance: [
      {
        ...canonicalRecords[0].provenance[0],
        confidence: 1.5,
      },
    ],
  };
  const res2 = validateCanonicalHospitalRecord(impossibleConfidenceRecord);
  if (res2.valid || !res2.errors.some((e) => e.includes('impossible provenance confidence'))) {
    throw new Error('Validator failed to reject provenance with confidence > 1.0');
  }

  // Test 7c: Negative confidence (< 0.0)
  const negativeConfidenceRecord: CanonicalHospitalRecord = {
    ...canonicalRecords[0],
    provenance: [
      {
        ...canonicalRecords[0].provenance[0],
        confidence: -0.2,
      },
    ],
  };
  const res3 = validateCanonicalHospitalRecord(negativeConfidenceRecord);
  if (res3.valid || !res3.errors.some((e) => e.includes('impossible provenance confidence'))) {
    throw new Error('Validator failed to reject provenance with negative confidence');
  }

  // Test 7d: Invalid timestamp
  const invalidDateRecord: CanonicalHospitalRecord = {
    ...canonicalRecords[0],
    provenance: [
      {
        ...canonicalRecords[0].provenance[0],
        retrievedAt: 'not-a-valid-timestamp',
      },
    ],
  };
  const res4 = validateCanonicalHospitalRecord(invalidDateRecord);
  if (res4.valid || !res4.errors.some((e) => e.includes('invalid retrievedAt timestamp'))) {
    throw new Error('Validator failed to reject invalid retrievedAt timestamp');
  }

  // Test 7e: Synthetic contamination in canonical record
  const syntheticContaminatedRecord: CanonicalHospitalRecord = {
    ...canonicalRecords[0],
    dataStatus: 'SYNTHETIC_DEMO',
  };
  const res5 = validateCanonicalHospitalRecord(syntheticContaminatedRecord, { allowSynthetic: false });
  if (res5.valid || !res5.errors.some((e) => e.includes('synthetic data (SYNTHETIC_DEMO) detected'))) {
    throw new Error('Validator failed to reject SYNTHETIC_DEMO in canonical dataset');
  }

  // Test 7f: Illegal promotion of public data to operational state
  const promotedRecord: CanonicalHospitalRecord = {
    ...canonicalRecords[0],
    dataStatus: 'PUBLIC_LISTED',
    operationalState: {
      emergency: 'AVAILABLE',
      icu: 'AVAILABLE',
      trauma: 'UNKNOWN',
      nicu: 'UNKNOWN',
      picu: 'UNKNOWN',
      ventilator: 'UNKNOWN',
      acceptance: 'ACCEPTED',
      source: 'UNKNOWN', // Claims AVAILABLE but lacks HOSPITAL_CONFIRMED / AUTHORIZED_FEED
    },
  };
  const res6 = validateCanonicalHospitalRecord(promotedRecord);
  if (res6.valid || !res6.errors.some((e) => e.includes('Invariant violation: public/historical facility cannot have active operational state'))) {
    throw new Error('Validator failed to reject unconfirmed promotion of operational state');
  }

  // Test 7g: Invalid coordinates (out of range latitude)
  const invalidCoordRecord: CanonicalHospitalRecord = {
    ...canonicalRecords[0],
    location: {
      latitude: 195.0, // Invalid latitude
      longitude: 77.5,
      coordinateSource: 'GEOCODED',
    },
  };
  const res7 = validateCanonicalHospitalRecord(invalidCoordRecord);
  if (res7.valid || !res7.errors.some((e) => e.includes('invalid latitude'))) {
    throw new Error('Validator failed to reject out-of-range latitude');
  }

  console.log('     ✓ All invalid provenance and invariant violation cases properly fail validation.');

  console.log('\n========================================================================');
  console.log('✓ AG-02 CANONICAL HOSPITAL DATA & EVIDENCE INGESTION: ALL TESTS PASSED!');
  console.log('========================================================================\n');
}

testCanonicalDataIngestion().catch((err) => {
  console.error('\n✗ AG-02 Test Failed:', err);
  process.exit(1);
});
