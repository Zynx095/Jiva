import { createHash, randomBytes } from 'crypto';
import type { ActorRef, DataStatus, MeasurementType, TelemetryMeasurement, TelemetrySource } from '@jiva/domain-models';
import type { DeviceObservationBatch, MeasurementInput } from '@jiva/event-schema';
import type { EvidenceEnvironment } from '@jiva/feasibility';
import { evidenceEnvironment } from '../evidenceTrust';

/**
 * Medical telemetry (Phase 10): vital-sign measurements with their source, time and freshness.
 *
 * Sources
 *   MANUAL_CLINICIAN — entered by the assigned clinician through the API (the only source in use).
 *   DEVICE_SIMULATED — a synthetic bedside monitor, available in DEMO mode only, always labelled; never
 *                      presented as a real measurement. Operational mode cannot generate values at all.
 *   MEDICAL_DEVICE   — reserved for a future, registered device integration (contract below). None exists,
 *                      so nothing can currently be recorded with this source.
 * The source is always decided by the server from the route used — never taken from a request body.
 */

export type Freshness = 'FRESH' | 'RECENT' | 'OLD';

/** Up to 15 minutes old: current. Up to 2 hours: recent. Older: shown as old, never as current. */
export const FRESH_MS = 15 * 60_000;
export const RECENT_MS = 2 * 3600_000;

export function freshnessOf(observedAt: string, now: number): { ageSeconds: number; freshness: Freshness } {
  const age = Math.max(0, now - Date.parse(observedAt));
  return { ageSeconds: Math.round(age / 1000), freshness: age <= FRESH_MS ? 'FRESH' : age <= RECENT_MS ? 'RECENT' : 'OLD' };
}

export const newBatchId = () => `VB-${randomBytes(6).toString('hex').toUpperCase()}`;

export interface BatchContext {
  batchId: string;
  encounterId: string;
  caseId: string;
  hospitalId: string;
  source: TelemetrySource;
  recordedAt: string;
  recordedBy?: ActorRef;
  deviceId?: string;
  dataStatus: DataStatus;
}

/** Validated inputs → stored measurements (units and ranges were checked by the schema). */
export function measurementsFromInputs(inputs: MeasurementInput[], ctx: BatchContext): TelemetryMeasurement[] {
  return inputs.map((m, i) => ({
    measurementId: `${ctx.batchId}-${i + 1}`,
    batchId: ctx.batchId,
    encounterId: ctx.encounterId,
    caseId: ctx.caseId,
    hospitalId: ctx.hospitalId,
    type: m.type,
    value: m.value,
    ...('secondaryValue' in m ? { secondaryValue: m.secondaryValue } : {}),
    unit: m.unit,
    observedAt: m.observedAt,
    recordedAt: ctx.recordedAt,
    source: ctx.source,
    ...(ctx.recordedBy ? { recordedBy: ctx.recordedBy } : {}),
    ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {}),
    dataStatus: ctx.dataStatus,
  }));
}

/** The most recent observation of each type, with its age. */
export function latestByType(list: TelemetryMeasurement[], now: number): Partial<Record<MeasurementType, TelemetryMeasurement & { ageSeconds: number; freshness: Freshness }>> {
  const out: Partial<Record<MeasurementType, TelemetryMeasurement & { ageSeconds: number; freshness: Freshness }>> = {};
  for (const m of list) {
    const cur = out[m.type];
    if (!cur || Date.parse(m.observedAt) > Date.parse(cur.observedAt)) out[m.type] = { ...m, ...freshnessOf(m.observedAt, now) };
  }
  return out;
}

/** Observation times must be plausible: not in the future, not more than a day old. */
export function observationTimeProblem(inputs: MeasurementInput[], now: number): string | undefined {
  for (const m of inputs) {
    const t = Date.parse(m.observedAt);
    if (t > now + 60_000) return 'observedAt is in the future';
    if (t < now - 24 * 3600_000) return 'observedAt is more than 24 hours ago';
  }
  return undefined;
}

// ------------------------------------------------------------------ demo simulation

/** Small deterministic PRNG (mulberry32), so a simulated reading is reproducible from its seed. */
function prng(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SIMULATED_DEVICE_ID = 'SIM-BEDSIDE-MONITOR';

/** Simulated readings exist in DEMO mode only; operational mode never generates a measurement. */
export const simulationAllowed = (environment: EvidenceEnvironment = evidenceEnvironment()) => environment === 'DEMO';

/**
 * DEMO ONLY. A synthetic bedside-monitor reading within ordinary adult ranges, deterministic for a seed.
 * The caller must refuse outside DEMO mode and label the result DEVICE_SIMULATED / SYNTHETIC_DEMO.
 */
export function simulatedReading(seed: string, at: Date): MeasurementInput[] {
  const r = prng(seed);
  const between = (lo: number, hi: number, step = 1) => Number((Math.round((lo + r() * (hi - lo)) / step) * step).toFixed(step < 1 ? 1 : 0));
  const observedAt = at.toISOString();
  const systolic = between(112, 138);
  return [
    { type: 'HEART_RATE', value: between(72, 108), unit: 'bpm', observedAt },
    { type: 'SPO2', value: between(94, 99), unit: '%', observedAt },
    { type: 'BLOOD_PRESSURE', value: systolic, secondaryValue: Math.min(systolic - 30, between(70, 88)), unit: 'mmHg', observedAt },
    { type: 'TEMPERATURE', value: between(36.6, 37.6, 0.1), unit: 'degC', observedAt },
    { type: 'RESPIRATORY_RATE', value: between(14, 20), unit: 'breaths/min', observedAt },
  ];
}

// ------------------------------------------------------------------ future device integration

/** Device binding as a registry would provide it (no registry exists yet). */
export interface DeviceBinding {
  deviceId: string;
  hospitalId: string;
  encounterId: string;
  lastSequence: number;
}

export interface DeviceRegistry {
  binding(deviceId: string): DeviceBinding | undefined;
}

/** The registry in use today: no device is integrated, so every device batch is refused. */
export const NO_DEVICE_REGISTRY: DeviceRegistry = { binding: () => undefined };

export type DeviceBatchCheck = { ok: true } | { ok: false; code: 'NO_DEVICE_INTEGRATION' | 'NOT_BOUND_TO_ENCOUNTER' | 'REPLAYED_OR_OUT_OF_ORDER' | 'DEVICE_CLOCK_SKEW' };

/**
 * Checks a future MEDICAL_DEVICE batch must pass before anything is stored: a registered device, bound
 * to this encounter, a strictly increasing sequence, and a sane device clock. Device authentication
 * (e.g. mutual TLS or signed device tokens) comes before this and is not built.
 */
export function checkDeviceBatch(batch: DeviceObservationBatch, registry: DeviceRegistry, now: number): DeviceBatchCheck {
  const binding = registry.binding(batch.deviceId);
  if (!binding) return { ok: false, code: 'NO_DEVICE_INTEGRATION' };
  if (binding.encounterId !== batch.encounterId) return { ok: false, code: 'NOT_BOUND_TO_ENCOUNTER' };
  if (batch.sequence <= binding.lastSequence) return { ok: false, code: 'REPLAYED_OR_OUT_OF_ORDER' };
  if (Math.abs(Date.parse(batch.sentAt) - now) > 5 * 60_000) return { ok: false, code: 'DEVICE_CLOCK_SKEW' };
  return { ok: true };
}
