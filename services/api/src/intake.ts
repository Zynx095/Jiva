import type { CapabilityType, EmergencyIntake, PatientState } from '@jiva/domain-models';
import type { PatientEmergencyCreated } from '@jiva/event-schema';
import { assessRequiredCapabilities } from './stateTransitions';

/**
 * Emergency intake rules shared by the LOCAL state engine and the AWS emergency lambda (one
 * implementation, so both environments derive the same requirement and patient state).
 *
 * Nothing here diagnoses: symptoms and the suspected cause are stored as reported, separately, and the
 * care requirement is the frozen rule-based assessment PLUS anything the reporter asked for.
 */

export interface DerivedRequirement {
  /** What the case requires: rule-derived first, then reporter-requested additions. */
  required: CapabilityType[];
  ruleDerived: CapabilityType[];
  reporterRequested: CapabilityType[];
}

/**
 * Rule-based assessment (frozen legacy `assessRequiredCapabilities`) unioned with the capabilities the
 * reporter asked for. A reporter can add care needs but can never remove a rule-derived one.
 */
export function deriveCareRequirement(input: { condition: string; severity: string; requestedCapabilities?: string[] }): DerivedRequirement {
  const ruleDerived = assessRequiredCapabilities(input.condition, input.severity);
  const reporterRequested = [...new Set(input.requestedCapabilities ?? [])] as CapabilityType[];
  const required = [...new Set<CapabilityType>([...ruleDerived, ...reporterRequested])];
  return { required, ruleDerived, reporterRequested };
}

/**
 * The legacy one-line `condition` for a structured intake. The suspected cause is always prefixed
 * "Suspected:" so no consumer can mistake it for a confirmed diagnosis.
 */
export function composeCondition(reportedSymptoms: string[], suspectedCause?: string): string {
  const parts: string[] = [];
  if (suspectedCause) parts.push(`Suspected: ${suspectedCause}`);
  parts.push(`Reported: ${reportedSymptoms.join(', ')}`);
  return parts.join(' · ');
}

/** Intake channel recorded on the case: the event's (policy-checked) claim, else derived from the source. */
function intakeOf(event: PatientEmergencyCreated): EmergencyIntake | undefined {
  const p = event.payload;
  const channel = p.intake?.channel ?? (event.source.type === 'ambulance' ? 'AMBULANCE_CREW' : event.source.type === 'patient' ? 'PATIENT_APP' : undefined);
  if (!channel && !p.notes) return undefined;
  const intake: EmergencyIntake = { channel: channel ?? 'DISPATCH' };
  if (channel === 'AMBULANCE_CREW' && event.source.type === 'ambulance') intake.reportedByAmbulanceId = event.source.id;
  if (p.intake?.locationMethod) intake.locationMethod = p.intake.locationMethod;
  if (p.intake?.locationAccuracyMeters !== undefined) intake.locationAccuracyMeters = p.intake.locationAccuracyMeters;
  if (p.notes) intake.notes = p.notes;
  return intake;
}

/** Patient state projected from an emergency report (identical locally and in AWS). */
export function patientFromEmergency(event: PatientEmergencyCreated, patientId: string, requirement: DerivedRequirement): PatientState {
  const { condition, location, reportedSymptoms, suspectedCause } = event.payload;
  const patient: PatientState = {
    patientId,
    currentStatus: 'ASSESSED',
    currentLocation: { latitude: location.latitude, longitude: location.longitude },
    careRequirements: requirement.required,
    activeConditions: [condition],
    lastUpdated: event.timestamp,
    provenance: [{
      sourceType: event.source.type,
      sourceId: event.source.id,
      eventId: event.eventId,
      timestamp: event.timestamp,
      confidence: event.metadata?.confidence ?? 1.0,
    }],
  };
  if (reportedSymptoms?.length) patient.reportedSymptoms = [...reportedSymptoms];
  if (suspectedCause) patient.suspectedCause = suspectedCause;
  if (requirement.reporterRequested.length) patient.requestedCapabilities = [...requirement.reporterRequested];
  const intake = intakeOf(event);
  if (intake) patient.intake = intake;
  return patient;
}

/** Is this an emergency reported by an ambulance crew about the patient it is attending? */
export function reportingAmbulanceOf(event: PatientEmergencyCreated): string | undefined {
  return event.source.type === 'ambulance' ? event.source.id : undefined;
}

/**
 * Can this ambulance take on a new case it reported? Out-of-service units cannot; a unit with an active
 * assignment (anything but AVAILABLE) cannot either — the handover releases it.
 */
export function ambulanceCanAttend(amb: { status: string; assignedPatient?: string } | undefined): boolean {
  if (!amb || amb.status === 'UNAVAILABLE') return false;
  return !amb.assignedPatient || amb.status === 'AVAILABLE';
}
