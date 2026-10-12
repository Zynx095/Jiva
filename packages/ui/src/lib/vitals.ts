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
  source: 'MANUAL_CLINICIAN' | 'DEVICE_SIMULATED' | 'MEDICAL_DEVICE';
  recordedByName?: string;
  deviceId?: string;
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
