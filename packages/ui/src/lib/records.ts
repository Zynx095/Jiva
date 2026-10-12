import type { StatusMeta } from './status';
import type { EncounterActor } from './encounters';

/**
 * Client-side shapes of the clinical record API (GET /api/encounters/:id/prescriptions | reports).
 * The server decides the view: the assigned clinician gets full records with every version; the patient
 * gets the current version of their own prescriptions and of the reports released to them.
 */

export interface RecordAuthor {
  displayName: string;
  specialty?: string;
}

export interface PrescriptionFields {
  medication: string;
  strength?: string;
  dose: string;
  route: string;
  frequency: string;
  duration?: string;
  instructions?: string;
}

export interface PrescriptionVersionView extends PrescriptionFields {
  version: number;
  status: 'ACTIVE' | 'DISCONTINUED';
  recordedAt: string;
  recordedBy: EncounterActor;
  author: RecordAuthor;
  action: 'CREATED' | 'AMENDED' | 'DISCONTINUED';
  changeReason?: string;
  contentHash: string;
}

/** Clinician view. */
export interface PrescriptionRecord {
  prescriptionId: string;
  encounterId: string;
  current: PrescriptionVersionView;
  history: PrescriptionVersionView[];
  dataStatus: string;
}

/** Patient view: the current medication, who prescribed it and when. */
export interface PatientPrescription extends PrescriptionFields {
  prescriptionId: string;
  encounterId: string;
  status: 'ACTIVE' | 'DISCONTINUED';
  prescribedAt: string;
  prescribedBy: RecordAuthor;
  updatedAt: string;
  changed: boolean;
  discontinuedAt?: string;
  version: number;
  dataStatus: string;
}

export interface ReportFields {
  category: string;
  title: string;
  findings?: string;
  conclusion?: string;
  effectiveAt: string;
  documentIds: string[];
}

export interface ReportVersionView extends ReportFields {
  version: number;
  status: 'PRELIMINARY' | 'FINAL' | 'AMENDED';
  patientVisible: boolean;
  recordedAt: string;
  recordedBy: EncounterActor;
  author: RecordAuthor;
  action: 'CREATED' | 'AMENDED';
  changeReason?: string;
  contentHash: string;
}

export interface ReportRecord {
  reportId: string;
  encounterId: string;
  current: ReportVersionView;
  history: ReportVersionView[];
  dataStatus: string;
}

export interface PatientReport extends ReportFields {
  reportId: string;
  encounterId: string;
  status: 'PRELIMINARY' | 'FINAL' | 'AMENDED';
  reportedAt: string;
  reportedBy: RecordAuthor;
  updatedAt: string;
  version: number;
  dataStatus: string;
}

export const MEDICATION_ROUTES = ['ORAL', 'IV', 'IM', 'SC', 'INHALED', 'TOPICAL', 'SUBLINGUAL', 'RECTAL', 'OTHER'] as const;

export const ROUTE_TEXT: Record<string, string> = {
  ORAL: 'By mouth',
  IV: 'Intravenous (IV)',
  IM: 'Intramuscular (IM)',
  SC: 'Subcutaneous (SC)',
  INHALED: 'Inhaled',
  TOPICAL: 'On the skin',
  SUBLINGUAL: 'Under the tongue',
  RECTAL: 'Rectal',
  OTHER: 'Other route',
};

export const DIAGNOSTIC_CATEGORIES = ['LABORATORY', 'IMAGING', 'ECG', 'PROCEDURE', 'OTHER'] as const;

export const CATEGORY_TEXT: Record<string, string> = {
  LABORATORY: 'Laboratory',
  IMAGING: 'Imaging',
  ECG: 'ECG',
  PROCEDURE: 'Procedure',
  OTHER: 'Other',
};

/** One line for a medication: "Amoxicillin 500 mg — 1 capsule, by mouth, every 8 hours, for 5 days". */
export function medicationLine(p: PrescriptionFields): string {
  const head = [p.medication, p.strength].filter(Boolean).join(' ');
  const how = [p.dose, (ROUTE_TEXT[p.route] ?? p.route).toLowerCase(), p.frequency.toLowerCase(), p.duration && `for ${p.duration}`].filter(Boolean).join(', ');
  return `${head} — ${how}`;
}

export function prescriptionStatus(status?: string): StatusMeta {
  return status === 'ACTIVE'
    ? { label: 'Active', tone: 'ok', icon: 'pill' }
    : status === 'DISCONTINUED'
      ? { label: 'Stopped', tone: 'neutral', icon: 'ban', hint: 'This medication was stopped. Do not take it unless your care team tells you to.' }
      : { label: 'Unknown', tone: 'neutral', icon: 'help' };
}

export function reportStatus(status?: string): StatusMeta {
  switch (status) {
    case 'PRELIMINARY':
      return { label: 'Preliminary', tone: 'warn', icon: 'clock', hint: 'Not yet final: results may still change.' };
    case 'FINAL':
      return { label: 'Final', tone: 'ok', icon: 'checkCircle' };
    case 'AMENDED':
      return { label: 'Amended', tone: 'warn', icon: 'file', hint: 'A final report that was later corrected.' };
    default:
      return { label: 'Unknown', tone: 'neutral', icon: 'help' };
  }
}
