import { randomBytes } from 'crypto';
import type { ActorRef, DataStatus, MeasurementType, PrehospitalEntry, PrehospitalObservation } from '@jiva/domain-models';
import type { PrehospitalClinical } from '@jiva/event-schema';
import { freshnessOf, type Freshness } from './telemetry';

/**
 * Pre-hospital record (ambulance intake, Journey A): what the attending crew measured and observed before
 * the hospital took over — vital signs with their time, source and quality (or the reason one could not
 * be taken), and the symptom narrative with its onset time.
 *
 * The record belongs to the case, not to an encounter (none exists before arrival). The crew attending the
 * case writes it; the clinician later assigned to the case's encounter, and the patient, read it. It never
 * travels on the operational event bus: the canonical event carries counts, types and times only.
 *
 * Sources are decided by the server from the route used: MANUAL_CREW (typed in by the crew) or
 * DEVICE_SIMULATED (demo only, labelled SYNTHETIC_DEMO). No ambulance monitor is integrated.
 */

export const newPrehospitalId = () => `PH-${randomBytes(6).toString('hex').toUpperCase()}`;
export const SIMULATED_AMBULANCE_MONITOR_ID = 'SIM-AMBULANCE-MONITOR';

/** Symptoms reported as starting more than this long ago are refused as an entry error. */
const MAX_ONSET_AGE_MS = 30 * 24 * 3600_000;

export interface EntryContext {
  entryId: string;
  caseId: string;
  ambulanceId: string;
  recordedAt: string;
  recordedBy: ActorRef;
  source: PrehospitalEntry['source'];
  deviceId?: string;
  dataStatus: DataStatus;
  eventId: string;
}

/** Validated input → a stored entry (units and ranges were checked by the schema). */
export function prehospitalEntry(input: PrehospitalClinical, ctx: EntryContext): PrehospitalEntry {
  const measured: PrehospitalObservation[] = input.measurements.map(m => ({
    type: m.type,
    status: 'MEASURED',
    value: m.value,
    ...('secondaryValue' in m ? { secondaryValue: m.secondaryValue } : {}),
    unit: m.unit,
    observedAt: m.observedAt,
    ...(m.quality ? { quality: m.quality } : {}),
  }));
  const missing: PrehospitalObservation[] = input.unavailable.map(u => ({ type: u.type, status: 'NOT_AVAILABLE', observedAt: ctx.recordedAt, unavailableReason: u.reason }));
  return {
    ...ctx,
    observations: [...measured, ...missing],
    ...(input.symptomDescription ? { symptomDescription: input.symptomDescription } : {}),
    ...(input.symptomOnsetAt ? { symptomOnsetAt: input.symptomOnsetAt } : {}),
  };
}

/** Times must be plausible: observations not in the future nor older than a day; onset not in the future. */
export function prehospitalTimeProblem(input: PrehospitalClinical, now: number): string | undefined {
  for (const m of input.measurements) {
    const t = Date.parse(m.observedAt);
    if (t > now + 60_000) return 'observedAt is in the future';
    if (t < now - 24 * 3600_000) return 'observedAt is more than 24 hours ago';
  }
  if (input.symptomOnsetAt) {
    const t = Date.parse(input.symptomOnsetAt);
    if (t > now + 60_000) return 'symptomOnsetAt is in the future';
    if (t < now - MAX_ONSET_AGE_MS) return 'symptomOnsetAt is more than 30 days ago';
  }
  return undefined;
}

export type LatestObservation = PrehospitalObservation & { source: PrehospitalEntry['source']; entryId: string; ageSeconds: number; freshness: Freshness };

/** The most recent MEASURED value of each type across all entries (a later "not available" does not hide it). */
export function latestPrehospital(entries: PrehospitalEntry[], now: number): Partial<Record<MeasurementType, LatestObservation>> {
  const out: Partial<Record<MeasurementType, LatestObservation>> = {};
  for (const e of entries) {
    for (const o of e.observations) {
      if (o.status !== 'MEASURED') continue;
      const cur = out[o.type];
      if (!cur || Date.parse(o.observedAt) > Date.parse(cur.observedAt)) out[o.type] = { ...o, source: e.source, entryId: e.entryId, ...freshnessOf(o.observedAt, now) };
    }
  }
  return out;
}

/** The crew is identified by its unit; the crew member's user id is internal and never shown. */
export function projectPrehospitalEntry(e: PrehospitalEntry) {
  const { recordedBy, eventId: _event, ...rest } = e;
  return { ...rest, recordedBy: { role: recordedBy.role, ...(recordedBy.ambulanceId ? { ambulanceId: recordedBy.ambulanceId } : {}) } };
}

/** The canonical event's payload: counts, types and times only. */
export function prehospitalEventPayload(e: PrehospitalEntry) {
  const measured = e.observations.filter(o => o.status === 'MEASURED');
  const times = measured.map(o => Date.parse(o.observedAt));
  return {
    entryId: e.entryId, caseId: e.caseId, ambulanceId: e.ambulanceId, recordedAt: e.recordedAt, recordedBy: e.recordedBy, dataStatus: e.dataStatus,
    source: e.source,
    measurementCount: measured.length,
    measurementTypes: [...new Set(measured.map(o => o.type))],
    unavailableCount: e.observations.length - measured.length,
    narrative: !!(e.symptomDescription || e.symptomOnsetAt),
    ...(times.length ? { observedFrom: new Date(Math.min(...times)).toISOString(), observedTo: new Date(Math.max(...times)).toISOString() } : {}),
    ...(e.deviceId ? { deviceId: e.deviceId } : {}),
  };
}
