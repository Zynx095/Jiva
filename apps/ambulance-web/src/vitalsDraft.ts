import {
  MEASUREMENT_ORDER,
  MEASUREMENT_TEXT,
  UNAVAILABLE_REASONS,
  UNAVAILABLE_REASON_TEXT,
  fromDateTimeLocal,
  toDateTimeLocal,
  type MeasurementTypeCode,
} from '@jiva/ui/src';

/**
 * The crew's vital-signs form state and how it becomes an API body: measured values with their time and an
 * optional "questionable" flag, and vital signs that could not be taken with the reason.
 */

export type Reason = '' | (typeof UNAVAILABLE_REASONS)[number];
export interface VitalRow {
  value: string;
  secondary: string;
  questionable: boolean;
  unavailable: Reason;
}
export interface VitalsDraft {
  at: string;
  rows: Record<MeasurementTypeCode, VitalRow>;
}

const UNIT: Record<MeasurementTypeCode, string> = { HEART_RATE: 'bpm', SPO2: '%', BLOOD_PRESSURE: 'mmHg', TEMPERATURE: 'degC', RESPIRATORY_RATE: 'breaths/min', BLOOD_GLUCOSE: 'mg/dL' };
// Plausibility bounds (mirroring the server's input checks — entry errors, not clinical thresholds).
const RANGE: Record<MeasurementTypeCode, [number, number]> = { HEART_RATE: [20, 300], SPO2: [50, 100], BLOOD_PRESSURE: [40, 300], TEMPERATURE: [25, 45], RESPIRATORY_RATE: [2, 80], BLOOD_GLUCOSE: [10, 900] };

const row = (): VitalRow => ({ value: '', secondary: '', questionable: false, unavailable: '' });
export const emptyVitals = (): VitalsDraft => ({ at: toDateTimeLocal(Date.now()), rows: { HEART_RATE: row(), SPO2: row(), BLOOD_PRESSURE: row(), TEMPERATURE: row(), RESPIRATORY_RATE: row(), BLOOD_GLUCOSE: row() } });

const num = (s: string) => (s.trim() === '' ? undefined : Number(s.replace(',', '.')));

/** Problems a crew member can fix before sending (the server checks everything again). */
export function vitalsProblems(d: VitalsDraft): string[] {
  const out: string[] = [];
  const any = MEASUREMENT_ORDER.some((t) => d.rows[t].value.trim() || d.rows[t].secondary.trim());
  if (any && !fromDateTimeLocal(d.at)) out.push('Set the time the vital signs were measured.');
  for (const t of MEASUREMENT_ORDER) {
    const r = d.rows[t];
    const v = num(r.value);
    const [lo, hi] = RANGE[t];
    if (t === 'BLOOD_PRESSURE') {
      const dia = num(r.secondary);
      if (r.value.trim() || r.secondary.trim()) {
        if (v === undefined || dia === undefined || !Number.isFinite(v) || !Number.isFinite(dia)) out.push('Blood pressure needs both systolic and diastolic values.');
        else if (v < lo || v > hi || dia < 20 || dia > 200 || v <= dia) out.push('Blood pressure looks implausible (systolic 40–300 above diastolic 20–200).');
      }
      continue;
    }
    if (r.value.trim() && (v === undefined || !Number.isFinite(v) || v < lo || v > hi)) out.push(`${MEASUREMENT_TEXT[t].label} must be between ${lo} and ${hi}.`);
  }
  return out;
}

/** The API body part: measured values with time and quality flag, unavailable vital signs with the reason. */
export function vitalsPayload(d: VitalsDraft) {
  const observedAt = fromDateTimeLocal(d.at) ?? new Date().toISOString();
  const measurements: Array<Record<string, unknown>> = [];
  const unavailable: Array<{ type: MeasurementTypeCode; reason: string }> = [];
  for (const t of MEASUREMENT_ORDER) {
    const r = d.rows[t];
    const v = num(r.value);
    const quality = r.questionable ? { quality: 'QUESTIONABLE' } : {};
    if (t === 'BLOOD_PRESSURE' && v !== undefined && num(r.secondary) !== undefined) measurements.push({ type: t, value: v, secondaryValue: num(r.secondary), unit: UNIT[t], observedAt, ...quality });
    else if (t !== 'BLOOD_PRESSURE' && v !== undefined) measurements.push({ type: t, value: v, unit: UNIT[t], observedAt, ...quality });
    else if (r.unavailable) unavailable.push({ type: t, reason: r.unavailable });
  }
  return { measurements, unavailable };
}

/** "HR 118 · SpO₂ 91 (questionable) · BP not available" for the review step. */
export function vitalsSummary(d: VitalsDraft): string {
  const parts: string[] = [];
  for (const t of MEASUREMENT_ORDER) {
    const r = d.rows[t];
    const label = MEASUREMENT_TEXT[t].label.replace(' (SpO₂)', '');
    if (r.value.trim()) parts.push(`${label} ${r.value}${t === 'BLOOD_PRESSURE' ? `/${r.secondary}` : ''}${r.questionable ? ' (questionable)' : ''}`);
    else if (r.unavailable) parts.push(`${label}: ${UNAVAILABLE_REASON_TEXT[r.unavailable].toLowerCase()}`);
  }
  return parts.join(' · ');
}
