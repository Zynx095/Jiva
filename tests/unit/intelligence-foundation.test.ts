import {
  DataStatus,
  EvidenceRecord,
  isValidOperationalEvidence,
  assertNoHistoricalPromotion,
  HospitalDigitalTwin,
  HospitalFinancialProfile,
  HospitalInsuranceProfile,
  DecisionTraceRecord,
} from '../../packages/domain-models/src';
import { assertAdvisoryAuthorityOnly } from '../../packages/intelligence/src';

async function testIntelligenceFoundation() {
  console.log('[Test] Running Intelligence Expansion Foundation Unit Tests...\n');

  // 1. EvidenceRecord representation across all 9 canonical DataStatus values
  console.log('  1. Verifying EvidenceRecord across all 9 DataStatus values...');
  const allStatuses: DataStatus[] = [
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

  for (const status of allStatuses) {
    const record: EvidenceRecord<number> = {
      value: 450,
      source: 'registry-test',
      sourceType: 'GOVERNMENT_REGISTRY',
      observedAt: '2026-09-25T10:00:00Z',
      validUntil: '2026-12-31T23:59:59Z',
      confidence: 0.95,
      dataStatus: status,
      sourceUrl: 'https://registry.karnataka.gov.in',
      notes: `Test record for status ${status}`,
    };

    if (record.dataStatus !== status) {
      throw new Error(`DataStatus mismatch: expected ${status}, got ${record.dataStatus}`);
    }
    if (record.value !== 450 || record.confidence !== 0.95) {
      throw new Error('EvidenceRecord fields corrupted');
    }
  }
  console.log('     ✓ All 9 DataStatus values successfully verified in EvidenceRecord.');

  // 2. Core Invariant: Historical/public cannot become current operational availability
  console.log('  2. Verifying Core Invariant: Historical cannot become current operational availability...');
  
  const historicalRecord: EvidenceRecord<number> = {
    value: 50,
    source: 'bbmp-audit-2021',
    sourceType: 'PUBLIC_AUDIT',
    observedAt: '2021-05-15T00:00:00Z',
    confidence: 0.9,
    dataStatus: 'HISTORICAL',
  };

  const publicRecord: EvidenceRecord<number> = {
    value: 40,
    source: 'opencity-portal',
    sourceType: 'PUBLIC_DATASET',
    observedAt: '2026-01-01T00:00:00Z',
    confidence: 0.8,
    dataStatus: 'PUBLIC_LISTED',
  };

  const confirmedRecord: EvidenceRecord<number> = {
    value: 2,
    source: 'clinician-dr-deshmukh',
    sourceType: 'CLINICIAN_ENTRY',
    observedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 120000).toISOString(),
    confidence: 1.0,
    dataStatus: 'HOSPITAL_CONFIRMED',
  };

  if (isValidOperationalEvidence(historicalRecord)) {
    throw new Error('Invariant Failure: HISTORICAL record must NOT be valid operational evidence');
  }
  if (isValidOperationalEvidence(publicRecord)) {
    throw new Error('Invariant Failure: PUBLIC_LISTED record must NOT be valid operational evidence');
  }
  if (!isValidOperationalEvidence(confirmedRecord)) {
    throw new Error('Invariant Failure: HOSPITAL_CONFIRMED record MUST be valid operational evidence');
  }

  // Verify assertion throws on historical promotion
  let caughtHistorical = false;
  try {
    assertNoHistoricalPromotion(historicalRecord, 'ICU bed intake');
  } catch (err: any) {
    caughtHistorical = true;
    if (!err.message.includes('Architectural Invariant Violation')) {
      throw new Error(`Unexpected error message: ${err.message}`);
    }
  }
  if (!caughtHistorical) {
    throw new Error('assertNoHistoricalPromotion failed to throw on HISTORICAL evidence');
  }

  let caughtPublic = false;
  try {
    assertNoHistoricalPromotion(publicRecord, 'Emergency department intake');
  } catch (err: any) {
    caughtPublic = true;
  }
  if (!caughtPublic) {
    throw new Error('assertNoHistoricalPromotion failed to throw on PUBLIC_LISTED evidence');
  }

  console.log('     ✓ Core Invariant strictly enforced: Historical/public promotion rejected.');

  // 3. Hospital Digital Twin structure and baseline/operational isolation
  console.log('  3. Verifying HospitalDigitalTwin baseline vs live isolation...');
  const twin: HospitalDigitalTwin = {
    hospitalId: 'HOSP-BLR-001',
    displayName: 'Victoria Hospital Trauma Centre',
    tier: {
      value: 'APEX_TRAUMA_CENTER',
      source: 'kpme-registry',
      sourceType: 'GOVERNMENT_REGISTRY',
      observedAt: '2026-01-01T00:00:00Z',
      confidence: 1.0,
      dataStatus: 'PUBLIC_LISTED',
    },
    regulatory: {
      kpmeRegistrationNumber: {
        value: 'KPME-BLR-00142',
        source: 'kpme-portal',
        sourceType: 'GOVERNMENT_REGISTRY',
        observedAt: '2026-01-01T00:00:00Z',
        confidence: 1.0,
        dataStatus: 'PUBLIC_LISTED',
      },
    },
    geography: {
      address: {
        fullAddress: 'Fort Road, Near City Market, Bengaluru',
        city: 'Bengaluru',
        district: 'Bengaluru Urban',
        state: 'Karnataka',
        country: 'India',
      },
      facilityLocation: {
        value: { latitude: 12.9629, longitude: 77.5753, coordinateSource: 'SURVEY_VERIFIED' },
        source: 'nhp-directory',
        sourceType: 'GOVERNMENT_REGISTRY',
        observedAt: '2026-01-01T00:00:00Z',
        confidence: 1.0,
        dataStatus: 'PUBLIC_LISTED',
      },
    },
    contact: {
      phone: '080-26701150',
      emergencyPhone: '080-26701151',
    },
    historicalBaseline: {
      totalBeds: {
        value: 1200,
        source: 'annual-report-2024',
        sourceType: 'PUBLIC_DOCUMENT',
        observedAt: '2024-03-31T00:00:00Z',
        confidence: 0.95,
        dataStatus: 'HISTORICAL',
      },
      historicalIcuBeds: {
        value: 120,
        source: 'annual-report-2024',
        sourceType: 'PUBLIC_DOCUMENT',
        observedAt: '2024-03-31T00:00:00Z',
        confidence: 0.95,
        dataStatus: 'HISTORICAL',
      },
      registeredCapabilities: {
        value: { emergency: true, trauma: true, icu: true, ct: true },
        source: 'facility-declaration',
        sourceType: 'PUBLIC_LISTED',
        observedAt: '2026-01-01T00:00:00Z',
        confidence: 1.0,
        dataStatus: 'PUBLIC_LISTED',
      },
    },
    liveOperations: {
      state: {
        value: {
          emergency: 'UNKNOWN',
          icu: 'UNKNOWN',
          trauma: 'UNKNOWN',
          nicu: 'UNKNOWN',
          picu: 'UNKNOWN',
          ventilator: 'UNKNOWN',
          acceptance: 'UNKNOWN',
          source: 'UNKNOWN',
        },
        source: 'system-initialization',
        sourceType: 'SYSTEM_STATE',
        observedAt: new Date().toISOString(),
        confidence: 1.0,
        dataStatus: 'UNKNOWN',
      },
      emergencyDepartment: {
        intakeStatus: {
          value: 'UNKNOWN',
          source: 'system',
          sourceType: 'DEFAULT',
          observedAt: new Date().toISOString(),
          confidence: 0.0,
          dataStatus: 'UNKNOWN',
        },
      },
      intensiveCare: {
        generalIcu: {
          value: 'UNKNOWN',
          source: 'system',
          sourceType: 'DEFAULT',
          observedAt: new Date().toISOString(),
          confidence: 0.0,
          dataStatus: 'UNKNOWN',
        },
      },
      equipment: [
        {
          equipmentType: 'CT_SCANNER',
          status: {
            value: 'FUNCTIONAL_READY',
            source: 'biomedical-daily-log',
            sourceType: 'HOSPITAL_PORTAL',
            observedAt: new Date().toISOString(),
            confidence: 0.9,
            dataStatus: 'HOSPITAL_CONFIRMED',
          },
        },
      ],
      staffing: {
        emergencyPhysicianOnDuty: {
          value: true,
          source: 'roster-api',
          sourceType: 'AUTHORIZED_FEED',
          observedAt: new Date().toISOString(),
          confidence: 0.99,
          dataStatus: 'AUTHORIZED_FEED',
        },
        interventionalCardiologistOnCall: {
          value: true,
          source: 'roster-api',
          sourceType: 'AUTHORIZED_FEED',
          observedAt: new Date().toISOString(),
          confidence: 0.99,
          dataStatus: 'AUTHORIZED_FEED',
        },
        neurosurgeonOnCall: {
          value: true,
          source: 'roster-api',
          sourceType: 'AUTHORIZED_FEED',
          observedAt: new Date().toISOString(),
          confidence: 0.99,
          dataStatus: 'AUTHORIZED_FEED',
        },
        traumaSurgeonOnCall: {
          value: true,
          source: 'roster-api',
          sourceType: 'AUTHORIZED_FEED',
          observedAt: new Date().toISOString(),
          confidence: 0.99,
          dataStatus: 'AUTHORIZED_FEED',
        },
        intensivistOnDuty: {
          value: true,
          source: 'roster-api',
          sourceType: 'AUTHORIZED_FEED',
          observedAt: new Date().toISOString(),
          confidence: 0.99,
          dataStatus: 'AUTHORIZED_FEED',
        },
      },
    },
    lastSynchronizedAt: new Date().toISOString(),
    rootDataStatus: 'PUBLIC_LISTED',
  };

  if (twin.historicalBaseline.totalBeds.dataStatus !== 'HISTORICAL') {
    throw new Error('Baseline beds must be marked HISTORICAL');
  }
  if (twin.liveOperations.state.value.acceptance !== 'UNKNOWN') {
    throw new Error('Live operational state must initialize to UNKNOWN');
  }
  console.log('     ✓ HospitalDigitalTwin baseline/operational isolation verified.');

  // 4. Financial Profile & Insurance Profile models
  console.log('  4. Verifying Financial and Insurance profile models...');
  const finProfile: HospitalFinancialProfile = {
    hospitalId: 'HOSP-BLR-001',
    pricingCategory: {
      value: 'GOVERNMENT_FREE',
      source: 'karnataka-health-dept',
      sourceType: 'GOVERNMENT_REGISTRY',
      observedAt: '2026-01-01T00:00:00Z',
      confidence: 1.0,
      dataStatus: 'PUBLIC_LISTED',
    },
    depositPolicy: {
      depositRequired: {
        value: false,
        source: 'hospital-charter',
        sourceType: 'PUBLIC_LISTED',
        observedAt: '2026-01-01T00:00:00Z',
        confidence: 1.0,
        dataStatus: 'PUBLIC_LISTED',
      },
      statutoryWaiverApplies: {
        value: true,
        source: 'kpme-act-2007',
        sourceType: 'GOVERNMENT_LEGISLATION',
        observedAt: '2026-01-01T00:00:00Z',
        confidence: 1.0,
        dataStatus: 'PUBLIC_LISTED',
      },
      acceptedPaymentMethods: {
        value: ['UPI', 'CASH', 'DEBIT_CARD'],
        source: 'hospital-intake',
        sourceType: 'PUBLIC_LISTED',
        observedAt: '2026-01-01T00:00:00Z',
        confidence: 1.0,
        dataStatus: 'PUBLIC_LISTED',
      },
    },
    standardEmergencyProcedures: [],
    priceTransparencyStatus: {
      value: 'PUBLIC_LISTED',
      source: 'transparency-audit',
      sourceType: 'PUBLIC_AUDIT',
      observedAt: '2026-01-01T00:00:00Z',
      confidence: 0.9,
      dataStatus: 'PUBLIC_LISTED',
    },
    statutoryComplianceEmergencyStabilization: {
      value: true,
      source: 'legal-audit',
      sourceType: 'PUBLIC_AUDIT',
      observedAt: '2026-01-01T00:00:00Z',
      confidence: 1.0,
      dataStatus: 'PUBLIC_LISTED',
    },
  };

  const insProfile: HospitalInsuranceProfile = {
    hospitalId: 'HOSP-BLR-001',
    governmentSchemes: [
      {
        schemeId: 'PMJAY',
        schemeName: 'Ayushman Bharat PM-JAY',
        isEmpanelled: {
          value: true,
          source: 'pmjay-portal',
          sourceType: 'GOVERNMENT_REGISTRY',
          observedAt: '2026-01-01T00:00:00Z',
          confidence: 1.0,
          dataStatus: 'PUBLIC_LISTED',
        },
        empanelledSpecialties: {
          value: ['CARDIOLOGY', 'NEUROSURGERY', 'POLYTRAUMA'],
          source: 'pmjay-portal',
          sourceType: 'GOVERNMENT_REGISTRY',
          observedAt: '2026-01-01T00:00:00Z',
          confidence: 1.0,
          dataStatus: 'PUBLIC_LISTED',
        },
        preauthMode: {
          value: 'EMERGENCY_PROVISIONAL',
          source: 'sast-guidelines',
          sourceType: 'GOVERNMENT_REGISTRY',
          observedAt: '2026-01-01T00:00:00Z',
          confidence: 1.0,
          dataStatus: 'PUBLIC_LISTED',
        },
      },
    ],
    tpaNetworks: [
      {
        tpaId: 'MEDI_ASSIST',
        tpaName: 'Medi Assist Insurance TPA',
        isCashlessSupported: {
          value: true,
          source: 'tpa-empanelment-list',
          sourceType: 'TPA_PORTAL',
          observedAt: '2026-01-01T00:00:00Z',
          confidence: 0.95,
          dataStatus: 'PUBLIC_LISTED',
        },
        deskOperational24x7: {
          value: true,
          source: 'tpa-empanelment-list',
          sourceType: 'TPA_PORTAL',
          observedAt: '2026-01-01T00:00:00Z',
          confidence: 0.9,
          dataStatus: 'PUBLIC_LISTED',
        },
      },
    ],
    emergencyCashlessDeskAvailable: {
      value: true,
      source: 'hospital-intake-survey',
      sourceType: 'PUBLIC_LISTED',
      observedAt: '2026-01-01T00:00:00Z',
      confidence: 0.9,
      dataStatus: 'PUBLIC_LISTED',
    },
    dataStatus: 'PUBLIC_LISTED',
  };

  if (finProfile.pricingCategory.value !== 'GOVERNMENT_FREE') {
    throw new Error('Financial profile mismatch');
  }
  if (!insProfile.governmentSchemes[0].isEmpanelled.value) {
    throw new Error('Insurance scheme empanelment mismatch');
  }
  console.log('     ✓ Financial and Insurance profile models successfully verified.');

  // 5. DecisionTraceRecord structure
  console.log('  5. Verifying DecisionTraceRecord model...');
  const trace: DecisionTraceRecord = {
    traceId: 'TRC-BLR-0099',
    caseId: 'CASE-BLR-876',
    timestamp: new Date().toISOString(),
    trigger: {
      eventId: 'EVT-TRIG-001',
      eventType: 'patient.emergency.created',
      sourceId: 'system-triage',
    },
    candidates: [
      {
        hospitalId: 'HOSP-BLR-001',
        hospitalName: 'Victoria Hospital',
        overallScore: 92,
        isEligible: true,
        clinical: {
          requiredCapabilitiesMatched: ['EMERGENCY', 'TRAUMA'],
          missingCapabilities: [],
          matchPercentage: 100,
          passed: true,
        },
        operational: {
          acceptanceStatus: 'ACCEPTED',
          confirmedByClinician: true,
          passed: true,
        },
        transit: {
          distanceMeters: 4200,
          durationSeconds: 520,
          distanceKm: 4.2,
          etaMinutes: 9,
          routingProvider: 'valhalla',
          trafficAware: false,
        },
        financial: {
          pricingTier: 'GOVERNMENT_FREE',
          depositRequired: false,
          financialExposureRisk: 'LOW',
        },
        insurance: {
          payerMatched: true,
          cashlessFeasible: true,
          empanelmentType: 'PMJAY',
        },
        ruleEvaluations: [
          {
            ruleId: 'RULE-CLIN-01',
            category: 'CLINICAL_CAPABILITY',
            ruleName: 'Mandatory Emergency Department',
            isHardConstraint: true,
            passed: true,
            rationale: 'Hospital has certified 24x7 ED.',
          },
        ],
      },
    ],
    selectedHospitalId: 'HOSP-BLR-001',
    selectionRationale: 'Clinically capable, confirmed acceptance, shortest ETA (9 min), zero deposit barrier.',
  };

  if (trace.candidates.length !== 1 || !trace.candidates[0].isEligible) {
    throw new Error('DecisionTrace candidate evaluation failed');
  }
  console.log('     ✓ DecisionTraceRecord successfully verified.');

  // 6. Strict Safety Boundary: AI has zero mutation authority
  console.log('  6. Verifying Intelligence Layer safety boundary enforcement...');
  assertAdvisoryAuthorityOnly('generateFamilyAdvisory');
  assertAdvisoryAuthorityOnly('generateDispatcherBrief');

  let caughtIllegalAction = false;
  try {
    assertAdvisoryAuthorityOnly('rerouteAmbulance');
  } catch (err: any) {
    caughtIllegalAction = true;
    if (!err.message.includes('Safety Boundary Violation')) {
      throw new Error(`Unexpected safety error: ${err.message}`);
    }
  }
  if (!caughtIllegalAction) {
    throw new Error('assertAdvisoryAuthorityOnly failed to block mutating action');
  }
  console.log('     ✓ Safety Boundary strictly enforced: AI mutation prohibited.');

  console.log('\n✓ All Intelligence Expansion Foundation Unit Tests PASSED.\n');
}

testIntelligenceFoundation().catch((err) => {
  console.error('✗ Intelligence Expansion Foundation Unit Tests FAILED:', err);
  process.exit(1);
});
