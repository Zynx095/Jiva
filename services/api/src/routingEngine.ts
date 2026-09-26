import { HospitalState, GeoPoint, CareRequirement, CapabilityType } from '@jiva/domain-models';
import { hospitalsStore } from './stateStore';

export interface RouteScore {
  hospitalId: string;
  score: number;
  factors: {
    capabilityMatch: number;
    availability: number;
    distance: number;
  }
}

import { evaluateHospitals } from './eligibilityEngine';

export async function calculateBestHospitals(patientLocation: GeoPoint, careRequirements: string[]) {
  const req: CareRequirement = {
    requirementId: 'sys-req',
    caseId: 'sys-case',
    requiredCapabilities: careRequirements as CapabilityType[],
    optionalCapabilities: [],
    severity: 'HIGH',
    createdAt: new Date().toISOString(),
    source: 'system'
  };

  const candidates = await evaluateHospitals(req, patientLocation);
  
  // Return the first eligible, or if none, we return the first pending?
  // We need to return candidates with scores so the calling engine can decide.
  return candidates.map(c => ({
    hospitalId: c.hospitalId,
    score: c.operationalEligibility === 'ELIGIBLE' ? 100 : c.operationalEligibility === 'PENDING_ACCEPTANCE' ? 50 : 0,
    factors: {
      capabilityMatch: c.capabilityMatch * 100,
      availability: c.operationalEligibility === 'ELIGIBLE' ? 100 : 0,
      distance: c.distanceKm
    }
  }));
}
