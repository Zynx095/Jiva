import type { StatusMeta } from './status';

/**
 * Client-side shapes of GET /api/encounters/:id/vitals and how vital signs are labelled. Source and
 * freshness are always shown next to a value: a simulated reading is never presented as a measurement,
 * and an old value is never presented as current.
 */

export type MeasurementTypeCode = 'HEART_RATE' | 'SPO2' | 'BLOOD_PRESSURE' | 'TEMPERATURE' | 'RESPIRATORY_RATE' | 'BLOOD_GLUCOSE';

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

export const MEASUREMENT_ORDER: MeasurementTypeCode[] = ['HEART_RATE', 'SPO2', 'BLOOD_PRESSURE', 'TEMPERATURE', 'RESPIRATORY_RATE', 'BLOOD_GLUCOSE'];

export const MEASUREMENT_TEXT: Record<MeasurementTypeCode, { label: string; unit: string }> = {
  HEART_RATE: { label: 'Heart rate', unit: 'bpm' },
  SPO2: { label: 'Oxygen saturation (SpO₂)', unit: '%' },
  BLOOD_PRESSURE: { label: 'Blood pressure', unit: 'mmHg' },
  TEMPERATURE: { label: 'Temperature', unit: '°C' },
  RESPIRATORY_RATE: { label: 'Breathing rate', unit: '/min' },
  BLOOD_GLUCOSE: { label: 'Blood glucose', unit: 'mg/dL' },
};

/**
 * Entry-plausibility limits (mirroring the server's MEASUREMENT_RULES): values outside them are typing
 * errors, refused before sending. They are NOT clinical thresholds and nothing is flagged as abnormal.
 * `unit` is the API unit; the label's unit (MEASUREMENT_TEXT) is the display form.
 */
export const MEASUREMENT_LIMITS: Record<MeasurementTypeCode, { unit: string; min: number; max: number; secondaryMin?: number; secondaryMax?: number }> = {
  HEART_RATE: { unit: 'bpm', min: 20, max: 300 },
  SPO2: { unit: '%', min: 50, max: 100 },
  BLOOD_PRESSURE: { unit: 'mmHg', min: 40, max: 300, secondaryMin: 20, secondaryMax: 200 },
  TEMPERATURE: { unit: 'degC', min: 25, max: 45 },
  RESPIRATORY_RATE: { unit: 'breaths/min', min: 2, max: 80 },
  BLOOD_GLUCOSE: { unit: 'mg/dL', min: 10, max: 900 },
};

/** A number typed by a person ("37,2" is accepted as 37.2); empty → undefined; garbage → NaN. */
export const parseEntered = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s.trim().replace(',', '.')));

/** One sentence about a single typed value, or null when it is empty or plausible. */
export function enteredValueProblem(type: MeasurementTypeCode, value: string, secondary?: string): string | null {
  const lim = MEASUREMENT_LIMITS[type];
  const v = parseEntered(value);
  const label = MEASUREMENT_TEXT[type].label;
  if (type === 'BLOOD_PRESSURE') {
    const d = parseEntered(secondary ?? '');
    if (v === undefined && d === undefined) return null;
    if (v === undefined || d === undefined || !Number.isFinite(v) || !Number.isFinite(d)) return 'Blood pressure needs both systolic and diastolic values.';
    if (v < lim.min || v > lim.max || d < (lim.secondaryMin ?? 0) || d > (lim.secondaryMax ?? Infinity)) return `Blood pressure looks like a typing error (systolic ${lim.min}–${lim.max}, diastolic ${lim.secondaryMin}–${lim.secondaryMax}).`;
    if (v <= d) return 'Systolic must be higher than diastolic.';
    return null;
  }
  if (v === undefined) return null;
  if (!Number.isFinite(v)) return `${label}: enter a number.`;
  if (v < lim.min || v > lim.max) return `${label} must be between ${lim.min} and ${lim.max} ${MEASUREMENT_TEXT[type].unit} — check for a typing error.`;
  return null;
}

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
