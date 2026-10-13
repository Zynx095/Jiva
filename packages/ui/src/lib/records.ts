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
  /** Dosage form (TABLET, INJECTION …). */
  formulation?: string;
  dose: string;
  route: string;
  frequency: string;
  duration?: string;
  instructions?: string;
}

export type PrescriptionStatusCode = 'DRAFT' | 'ACTIVE' | 'DISCONTINUED' | 'CANCELLED';

export interface PrescriptionVersionView extends PrescriptionFields {
  version: number;
  status: PrescriptionStatusCode;
  recordedAt: string;
  recordedBy: EncounterActor;
  author: RecordAuthor;
  action: 'CREATED' | 'AMENDED' | 'AUTHORISED' | 'DISCONTINUED' | 'CANCELLED';
  changeReason?: string;
  contentHash: string;
  /** The catalogue entry (and its revision) the medication was chosen from, if any. */
  catalogueRef?: { medicationId: string; revision: number; catalogueVersion: number };
}

/** Clinician view. */
export interface PrescriptionRecord {
  prescriptionId: string;
  encounterId: string;
  current: PrescriptionVersionView;
  history: PrescriptionVersionView[];
  /** Latest authorisation (absent while the prescription is a draft that was never authorised). */
  authorisation?: { authorisedAt: string; authorisedBy: EncounterActor; version: number };
  dataStatus: string;
}

/** Patient view: the current medication, who prescribed it and when (authorised prescriptions only). */
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

export const MEDICATION_FORMULATIONS = [
  'TABLET', 'CAPSULE', 'ORAL_SOLUTION', 'ORAL_SUSPENSION', 'INJECTION', 'INFUSION', 'INHALER', 'NEBULISER_SOLUTION',
  'SPRAY', 'CREAM', 'OINTMENT', 'PATCH', 'SUPPOSITORY', 'DROPS', 'OTHER',
] as const;

export const FORMULATION_TEXT: Record<string, string> = {
  TABLET: 'Tablet',
  CAPSULE: 'Capsule',
  ORAL_SOLUTION: 'Oral solution',
  ORAL_SUSPENSION: 'Oral suspension',
  INJECTION: 'Injection',
  INFUSION: 'Infusion',
  INHALER: 'Inhaler',
  NEBULISER_SOLUTION: 'Nebuliser solution',
  SPRAY: 'Spray',
  CREAM: 'Cream',
  OINTMENT: 'Ointment',
  PATCH: 'Patch',
  SUPPOSITORY: 'Suppository',
  DROPS: 'Drops',
  OTHER: 'Other form',
};

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

/** One line for a medication: "Amoxicillin 500 mg capsule — 1 capsule, by mouth, every 8 hours, for 5 days". */
export function medicationLine(p: PrescriptionFields): string {
  const head = [p.medication, p.strength, p.formulation && (FORMULATION_TEXT[p.formulation] ?? p.formulation).toLowerCase()].filter(Boolean).join(' ');
  const how = [p.dose, (ROUTE_TEXT[p.route] ?? p.route).toLowerCase(), p.frequency.toLowerCase(), p.duration && `for ${p.duration}`].filter(Boolean).join(', ');
  return `${head} — ${how}`;
}

export function prescriptionStatus(status?: string): StatusMeta {
  switch (status) {
    case 'ACTIVE':
      return { label: 'Active', tone: 'ok', icon: 'pill' };
    case 'DISCONTINUED':
      return { label: 'Stopped', tone: 'neutral', icon: 'ban', hint: 'This medication was stopped. Do not take it unless your care team tells you to.' };
    case 'DRAFT':
      return { label: 'Draft · not authorised', tone: 'warn', icon: 'clock', hint: 'Not in force and not visible to the patient until a clinician authorises it.' };
    case 'CANCELLED':
      return { label: 'Discarded draft', tone: 'neutral', icon: 'xCircle', hint: 'Never authorised; kept in the history only.' };
    default:
      return { label: 'Unknown', tone: 'neutral', icon: 'help' };
  }
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

/** A diagnostic document as the API lists it (clinician view adds status, hash and uploader identity). */
export interface DocumentRecord {
  documentId: string;
  encounterId: string;
  category: string;
  title: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status?: 'PENDING_UPLOAD' | 'AVAILABLE' | 'REJECTED';
  rejectionReason?: string;
  patientVisible?: boolean;
  sha256?: string;
  createdAt?: string;
  uploadedAt?: string;
  uploader?: RecordAuthor;
  uploadedBy?: RecordAuthor | EncounterActor;
  dataStatus: string;
}

export const DOCUMENT_TYPES: Record<string, { label: string; extensions: string[] }> = {
  'application/pdf': { label: 'PDF', extensions: ['.pdf'] },
  'image/png': { label: 'PNG image', extensions: ['.png'] },
  'image/jpeg': { label: 'JPEG image', extensions: ['.jpg', '.jpeg'] },
  'application/dicom': { label: 'DICOM', extensions: ['.dcm'] },
};

/** Largest file the upload workflow accepts (mirrors MAX_DOCUMENT_BYTES on the server). */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** The accepted content type of a picked file (browsers report nothing for DICOM), or undefined. */
export function documentTypeOf(file: { name: string; type: string }): string | undefined {
  if (file.type && DOCUMENT_TYPES[file.type]) return file.type;
  const lower = file.name.toLowerCase();
  return Object.entries(DOCUMENT_TYPES).find(([, t]) => t.extensions.some((x) => lower.endsWith(x)))?.[0];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const REJECTION_TEXT: Record<string, string> = {
  HASH_MISMATCH: 'the file changed during upload',
  SIZE_MISMATCH: 'the file size did not match',
  CONTENT_TYPE_MISMATCH: 'the file is not the type it claims to be',
  UPLOAD_EXPIRED: 'the upload was not completed in time',
};

export function documentStatus(d: Pick<DocumentRecord, 'status' | 'rejectionReason'>): StatusMeta {
  switch (d.status) {
    case 'AVAILABLE':
      return { label: 'Verified', tone: 'ok', icon: 'shield', hint: 'Size, checksum and file type were verified on upload.' };
    case 'PENDING_UPLOAD':
      return { label: 'Awaiting upload', tone: 'warn', icon: 'clock' };
    case 'REJECTED':
      return { label: 'Not stored', tone: 'danger', icon: 'xCircle', hint: `Rejected: ${REJECTION_TEXT[d.rejectionReason ?? ''] ?? 'the upload failed'}.` };
    default:
      return { label: 'Available', tone: 'ok', icon: 'file' };
  }
}
