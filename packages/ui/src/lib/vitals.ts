import type { StatusMeta } from './status';

/**
 * Client-side shapes of GET /api/encounters/:id/vitals and how vital signs are labelled. Source and
 * freshness are always shown next to a value: a simulated reading is never presented as a measurement,
 * and an old value is never presented as current.
 */

export type MeasurementTypeCode = 'HEART_RATE' | 'SPO2' | 'BLOOD_PRESSURE' | 'TEMPERATURE' | 'RESPIRATORY_RATE';

export interface MeasurementView {
  measurementId: string;
  batchId: string;
  encounterId: string;
  type: MeasurementTypeCode;
  value: number;
  secondaryValue?: number;
  unit: string;
  observedAt: string;
  recordedAt: string;
  source: 'MANUAL_CLINICIAN' | 'MANUAL_CREW' | 'DEVICE_SIMULATED' | 'MEDICAL_DEVICE';
  recordedByName?: string;
  deviceId?: string;
  /** Flagged by whoever measured it. */
  quality?: 'RELIABLE' | 'QUESTIONABLE';
  dataStatus: string;
}

export interface VitalsResponse {
  encounterId: string;
  latest: Partial<Record<MeasurementTypeCode, MeasurementView & { ageSeconds: number; freshness: 'FRESH' | 'RECENT' | 'OLD' }>>;
  measurements: MeasurementView[];
  sources: { medicalDeviceIntegrated: boolean; simulationAvailable: boolean };
}

export const MEASUREMENT_ORDER: MeasurementTypeCode[] = ['HEART_RATE', 'SPO2', 'BLOOD_PRESSURE', 'TEMPERATURE', 'RESPIRATORY_RATE'];

export const MEASUREMENT_TEXT: Record<MeasurementTypeCode, { label: string; unit: string }> = {
  HEART_RATE: { label: 'Heart rate', unit: 'bpm' },
  SPO2: { label: 'Oxygen saturation (SpO₂)', unit: '%' },
  BLOOD_PRESSURE: { label: 'Blood pressure', unit: 'mmHg' },
  TEMPERATURE: { label: 'Temperature', unit: '°C' },
  RESPIRATORY_RATE: { label: 'Breathing rate', unit: '/min' },
};

/** "128/84", "96", "37.2". */
export function formatMeasurementValue(m: Pick<MeasurementView, 'type' | 'value' | 'secondaryValue'>): string {
  if (m.type === 'BLOOD_PRESSURE' && m.secondaryValue !== undefined) return `${m.value}/${m.secondaryValue}`;
  if (m.type === 'TEMPERATURE') return m.value.toFixed(1);
  return String(m.value);
}

export function measurementSource(source?: string): StatusMeta {
  switch (source) {
    case 'MANUAL_CLINICIAN':
      return { label: 'Entered by clinician', tone: 'ok', icon: 'user', hint: 'Measured and entered by a member of the care team.' };
    case 'MANUAL_CREW':
      return { label: 'Entered by ambulance crew', tone: 'ok', icon: 'ambulance', hint: 'Measured and entered by the attending ambulance crew before the handover.' };
    case 'DEVICE_SIMULATED':
      return { label: 'Simulated (demo)', tone: 'warn', icon: 'alertTriangle', hint: 'Generated for the demonstration. Not a real measurement.' };
    case 'MEDICAL_DEVICE':
      return { label: 'Medical device', tone: 'ok', icon: 'activity' };
    default:
      return { label: 'Unknown source', tone: 'neutral', icon: 'help' };
  }
}

export function measurementFreshness(freshness?: string): StatusMeta {
  switch (freshness) {
    case 'FRESH':
      return { label: 'Current', tone: 'ok', icon: 'clock', hint: 'Measured within the last 15 minutes.' };
    case 'RECENT':
      return { label: 'Recent', tone: 'neutral', icon: 'clock', hint: 'Measured within the last 2 hours.' };
    default:
      return { label: 'Older reading', tone: 'warn', icon: 'hourglass', hint: 'More than 2 hours old. It may no longer reflect the current state.' };
  }
}

/** A value the person measuring flagged as doubtful (movement, poor signal, poor perfusion …). */
export function measurementQuality(quality?: string): StatusMeta | undefined {
  return quality === 'QUESTIONABLE'
    ? { label: 'Questionable reading', tone: 'warn', icon: 'alertTriangle', hint: 'Flagged by the person who measured it, e.g. movement or a poor signal.' }
    : undefined;
}

export const UNAVAILABLE_REASONS = ['NOT_MEASURED', 'EQUIPMENT_UNAVAILABLE', 'UNABLE_TO_OBTAIN'] as const;

export const UNAVAILABLE_REASON_TEXT: Record<string, string> = {
  NOT_MEASURED: 'Not measured',
  EQUIPMENT_UNAVAILABLE: 'Equipment unavailable',
  UNABLE_TO_OBTAIN: 'Could not be obtained',
};

// ------------------------------------------------------------------ pre-hospital record (ambulance crew)

/** One crew observation: a measured value, or a vital sign recorded as not available (with the reason). */
export interface PrehospitalObservationView {
  type: MeasurementTypeCode;
  status: 'MEASURED' | 'NOT_AVAILABLE';
  value?: number;
  secondaryValue?: number;
  unit?: string;
  observedAt: string;
  quality?: 'RELIABLE' | 'QUESTIONABLE';
  unavailableReason?: string;
}

export interface PrehospitalEntryView {
  entryId: string;
  caseId: string;
  ambulanceId: string;
  recordedAt: string;
  recordedBy: { role: string; ambulanceId?: string };
  source: 'MANUAL_CREW' | 'DEVICE_SIMULATED';
  deviceId?: string;
  observations: PrehospitalObservationView[];
  symptomDescription?: string;
  symptomOnsetAt?: string;
  dataStatus: string;
}

/** GET /api/cases/:id/prehospital and GET /api/encounters/:id/prehospital. */
export interface PrehospitalResponse {
  caseId: string;
  latest: Partial<Record<MeasurementTypeCode, PrehospitalObservationView & { source: string; entryId: string; ageSeconds: number; freshness: 'FRESH' | 'RECENT' | 'OLD' }>>;
  entries: PrehospitalEntryView[];
  sources: { medicalDeviceIntegrated: boolean; simulationAvailable: boolean };
}
