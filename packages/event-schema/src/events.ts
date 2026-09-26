import { z } from 'zod';
import { BaseEventSchema } from './base';

// 1. Patient Events
export const PatientEmergencyCreatedSchema = BaseEventSchema.extend({
  eventType: z.literal('patient.emergency.created'),
  payload: z.object({
    condition: z.string(),
    location: z.object({
      latitude: z.number(),
      longitude: z.number(),
      address: z.string().optional()
    }),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  })
});

// 2. Ambulance Events
export const AmbulanceDispatchedSchema = BaseEventSchema.extend({
  eventType: z.literal('ambulance.dispatched'),
  payload: z.object({
    ambulanceId: z.string(),
    caseId: z.string().optional(),
    destination: z.object({
      latitude: z.number(),
      longitude: z.number(),
      address: z.string().optional()
    }),
    estimatedEtaMinutes: z.number()
  })
});

export const AmbulanceLocationUpdatedSchema = BaseEventSchema.extend({
  eventType: z.literal('ambulance.location.updated'),
  payload: z.object({
    ambulanceId: z.string(),
    city: z.string().optional(),
    state: z.string().optional(),
    coordinates: z.object({
      latitude: z.number(),
      longitude: z.number()
    }),
    speedKmh: z.number().optional(),
    heading: z.number().optional()
  })
});

export const AmbulanceArrivedSchema = BaseEventSchema.extend({
  eventType: z.literal('ambulance.arrived'),
  payload: z.object({
    ambulanceId: z.string(),
    hospitalId: z.string(),
    caseId: z.string().optional()
  })
});

// 3. Hospital Events
export const HospitalCapacityUpdatedSchema = BaseEventSchema.extend({
  eventType: z.literal('hospital.capacity.updated'),
  payload: z.object({
    hospitalId: z.string(),
    emergencyStatus: z.enum(['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'UNKNOWN']),
    traumaStatus: z.enum(['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'UNKNOWN']),
    icuStatus: z.enum(['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'UNKNOWN']),
    ventilatorStatus: z.enum(['AVAILABLE', 'LIMITED', 'UNAVAILABLE', 'UNKNOWN'])
  })
});

export const CareRequirementCreatedSchema = BaseEventSchema.extend({
  eventType: z.literal('care.requirement.created'),
  payload: z.object({
    requirementId: z.string(),
    caseId: z.string(),
    requiredCapabilities: z.array(z.string()),
    optionalCapabilities: z.array(z.string()),
    severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
    createdAt: z.string(),
    expiresAt: z.string().optional()
  })
});

export const HospitalCandidateGeneratedSchema = BaseEventSchema.extend({
  eventType: z.literal('hospital.candidate.generated'),
  payload: z.object({
    caseId: z.string(),
    candidates: z.array(z.object({
      hospitalId: z.string(),
      hospitalName: z.string(),
      capabilityMatch: z.number(),
      missingCapabilities: z.array(z.string()),
      operationalEligibility: z.enum(['ELIGIBLE', 'PENDING_ACCEPTANCE', 'INELIGIBLE']),
      distanceKm: z.number(),
      etaMinutes: z.number(),
      reason: z.string()
    }))
  })
});

export const HospitalAcceptanceRequestedSchema = BaseEventSchema.extend({
  eventType: z.literal('hospital.acceptance.requested'),
  payload: z.object({
    requestId: z.string(),
    caseId: z.string(),
    hospitalId: z.string(),
    requiredCapabilities: z.array(z.string()),
    optionalCapabilities: z.array(z.string()),
    ambulanceEtaMinutes: z.number().optional(),
    requestedAt: z.string(),
    expiresAt: z.string()
  })
});

export const HospitalAcceptanceReceivedSchema = BaseEventSchema.extend({
  eventType: z.literal('hospital.acceptance.received'),
  payload: z.object({
    responseId: z.string(),
    requestId: z.string(),
    caseId: z.string(),
    hospitalId: z.string(),
    status: z.enum(['ACCEPTED', 'LIMITED', 'REJECTED', 'UNAVAILABLE']),
    acceptedCapabilities: z.array(z.string()),
    limitations: z.array(z.string()),
    respondedAt: z.string(),
    validUntil: z.string(),
    responderRole: z.string(),
    source: z.enum(['HOSPITAL_CONFIRMED', 'AUTHORIZED_FEED', 'SYNTHETIC_DEMO'])
  })
});

export const HospitalAcceptanceExpiredSchema = BaseEventSchema.extend({
  eventType: z.literal('hospital.acceptance.expired'),
  payload: z.object({
    requestId: z.string(),
    hospitalId: z.string()
  })
});

// 4. Routing Events
export const RouteCalculatedSchema = BaseEventSchema.extend({
  eventType: z.literal('route.calculated'),
  payload: z.object({
    ambulanceId: z.string(),
    hospitalId: z.string(),
    distanceMeters: z.number(),
    durationSeconds: z.number(),
    polyline: z.string().optional(),
    coordinates: z.array(z.tuple([z.number(), z.number()])).optional(),
    provider: z.string().optional(),
    sourceType: z.string().optional(),
    synthetic: z.boolean().optional(),
    trafficAware: z.boolean().optional(),
  })
});

export const RouteRecalculatedSchema = BaseEventSchema.extend({
  eventType: z.literal('route.recalculated'),
  payload: z.object({
    ambulanceId: z.string(),
    oldHospitalId: z.string(),
    newHospitalId: z.string(),
    distanceMeters: z.number(),
    durationSeconds: z.number(),
    polyline: z.string().optional(),
    coordinates: z.array(z.tuple([z.number(), z.number()])).optional(),
    provider: z.string().optional(),
    sourceType: z.string().optional(),
    synthetic: z.boolean().optional(),
    trafficAware: z.boolean().optional(),
    reason: z.string()
  })
});

export const DestinationChangedSchema = BaseEventSchema.extend({
  eventType: z.literal('destination.changed'),
  payload: z.object({
    ambulanceId: z.string(),
    hospitalId: z.string(),
    reason: z.string()
  })
});

// 5. AI Intelligence Events
export const AiHandoffGeneratedSchema = BaseEventSchema.extend({
  eventType: z.literal('ai.handoff.generated'),
  payload: z.object({
    patientId: z.string(),
    hospitalId: z.string().optional(),
    summary: z.string(),
    criticalAlerts: z.array(z.string()),
    recommendedPreparations: z.array(z.string())
  })
});

export const AiAnomalyExplainedSchema = BaseEventSchema.extend({
  eventType: z.literal('ai.anomaly.explained'),
  payload: z.object({
    patientId: z.string(),
    anomalies: z.array(z.string()),
    explanation: z.string(),
    severityAssessment: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    suggestedActions: z.array(z.string())
  })
});

export const AiSummaryGeneratedSchema = BaseEventSchema.extend({
  eventType: z.literal('ai.summary.generated'),
  payload: z.object({
    patientId: z.string(),
    briefSummary: z.string(),
    timelineHighlights: z.array(z.string())
  })
});

// 6. Demo / operations events
export const DemoResetSchema = BaseEventSchema.extend({
  eventType: z.literal('demo.reset'),
  payload: z.object({
    resetBy: z.string(),
    epoch: z.number()
  })
});

// Union of all events
export const AnyEventSchema = z.discriminatedUnion('eventType', [
  PatientEmergencyCreatedSchema,
  AmbulanceDispatchedSchema,
  AmbulanceLocationUpdatedSchema,
  AmbulanceArrivedSchema,
  HospitalCapacityUpdatedSchema,
  CareRequirementCreatedSchema,
  HospitalCandidateGeneratedSchema,
  HospitalAcceptanceRequestedSchema,
  HospitalAcceptanceReceivedSchema,
  HospitalAcceptanceExpiredSchema,
  RouteCalculatedSchema,
  RouteRecalculatedSchema,
  DestinationChangedSchema,
  AiHandoffGeneratedSchema,
  AiAnomalyExplainedSchema,
  AiSummaryGeneratedSchema,
  DemoResetSchema
]);

export type PatientEmergencyCreated = z.infer<typeof PatientEmergencyCreatedSchema>;
export type AmbulanceDispatched = z.infer<typeof AmbulanceDispatchedSchema>;
export type AmbulanceLocationUpdated = z.infer<typeof AmbulanceLocationUpdatedSchema>;
export type HospitalCapacityUpdated = z.infer<typeof HospitalCapacityUpdatedSchema>;
export type CareRequirementCreated = z.infer<typeof CareRequirementCreatedSchema>;
export type HospitalCandidateGenerated = z.infer<typeof HospitalCandidateGeneratedSchema>;
export type HospitalAcceptanceRequested = z.infer<typeof HospitalAcceptanceRequestedSchema>;
export type HospitalAcceptanceReceived = z.infer<typeof HospitalAcceptanceReceivedSchema>;
export type HospitalAcceptanceExpired = z.infer<typeof HospitalAcceptanceExpiredSchema>;
export type RouteCalculated = z.infer<typeof RouteCalculatedSchema>;
export type RouteRecalculated = z.infer<typeof RouteRecalculatedSchema>;
export type DestinationChanged = z.infer<typeof DestinationChangedSchema>;
export type AiHandoffGenerated = z.infer<typeof AiHandoffGeneratedSchema>;
export type AiAnomalyExplained = z.infer<typeof AiAnomalyExplainedSchema>;
export type AiSummaryGenerated = z.infer<typeof AiSummaryGeneratedSchema>;
export type AmbulanceArrived = z.infer<typeof AmbulanceArrivedSchema>;
export type DemoReset = z.infer<typeof DemoResetSchema>;
export type AnyEvent = z.infer<typeof AnyEventSchema>;
