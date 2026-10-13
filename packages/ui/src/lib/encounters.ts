import type { StatusMeta } from './status';

/**
 * Client-side shapes of the encounter API (GET /api/encounters…). The server decides the view:
 * hospital staff and the assigned clinician get the full record; the patient gets their own encounter
 * without staff identities; crews and network coordination get a summary.
 */
export interface EncounterActor {
  userId?: string;
  role: string;
  hospitalId?: string;
  practitionerId?: string;
}

export interface EncounterDoctor {
  practitionerId?: string;
  displayName: string;
  specialty?: string;
  assignedAt: string;
  assignedBy?: EncounterActor;
  reason?: string;
  endedAt?: string;
}

export interface EncounterRecord {
  encounterId: string;
  caseId: string;
  hospitalId: string;
  hospitalName?: string;
  status: 'ARRIVED' | 'IN_CARE';
  dataStatus: string;
  ambulanceId?: string;
  /** Summary and patient views. */
  arrivedAt?: string;
  handedOverAt?: string;
  /** Full view only. */
  arrival?: { arrivedAt: string; recordedBy: EncounterActor; gpsArrivalAt?: string };
  handover?: { handedOverAt: string; recordedBy: EncounterActor; fromAmbulanceId?: string; notes?: string };
  referral?: { requestId: string; responseStatus?: string; respondedAt?: string };
  assignedDoctor?: EncounterDoctor;
  assignmentHistory?: EncounterDoctor[];
  version?: number;
}

/** A clinician on a hospital's roster (GET /api/hospitals/:id/clinicians, hospital staff only). */
export interface RosterEntry {
  practitionerId: string;
  hospitalId: string;
  displayName: string;
  specialty: string;
  active: boolean;
  dataStatus: string;
  activeEncounters: number;
}

export const encounterArrivedAt = (e: EncounterRecord): string => e.arrival?.arrivedAt ?? e.arrivedAt ?? '';
export const encounterHandedOverAt = (e: EncounterRecord): string | undefined => e.handover?.handedOverAt ?? e.handedOverAt;

export function encounterStatus(status?: string): StatusMeta {
  switch (status) {
    case 'ARRIVED':
      return { label: 'Arrived · awaiting handover', tone: 'warn', icon: 'clock', hint: 'The hospital recorded the arrival. The crew has not handed the patient over yet.' };
    case 'IN_CARE':
      return { label: 'In hospital care', tone: 'ok', icon: 'stethoscope', hint: 'The hospital recorded the handover from the ambulance crew.' };
    default:
      return { label: 'Not at a hospital', tone: 'neutral', icon: 'help' };
  }
}

export const ASSIGNMENT_REASON_TEXT: Record<string, string> = {
  INITIAL_ASSIGNMENT: 'First assignment',
  REASSIGNMENT: 'Reassigned',
  SHIFT_HANDOVER: 'Shift handover',
  SPECIALTY_REFERRAL: 'Specialty referral',
};

/** Reasons a coordinator may give when changing the assigned doctor. */
export const REASSIGNMENT_REASONS = ['REASSIGNMENT', 'SHIFT_HANDOVER', 'SPECIALTY_REFERRAL'] as const;
