import {
  CardHeader,
  Icon,
  JivaCard,
  JivaStatus,
  MEASUREMENT_ORDER,
  MEASUREMENT_TEXT,
  SkeletonRows,
  UNAVAILABLE_REASON_TEXT,
  cx,
  formatDateTime,
  formatMeasurementValue,
  measurementFreshness,
  measurementQuality,
  measurementSource,
  timeAgo,
  type PrehospitalResponse,
} from '@jiva/ui/src';

/**
 * What the ambulance crew recorded before the handover: vital signs with their time, source and quality
 * flags, vital signs that could not be taken (and why), and the crew's description of the symptoms.
 * Read-only here — only the attending crew writes it — and never a diagnosis.
 */
export function PrehospitalPanel({ data, now, compact }: { data: PrehospitalResponse | null | undefined; now: number; compact?: boolean }) {
  return (
    <JivaCard>
      <CardHeader title="From the ambulance crew" icon="ambulance" subtitle="Recorded before the handover · as reported and measured at the scene and en route" />
      {data === undefined ? (
        <SkeletonRows rows={2} className="mt-3" />
      ) : data === null ? (
        <p className="mt-3 text-sm text-danger-700">The pre-hospital record could not be loaded. It will be retried automatically.</p>
      ) : data.entries.length === 0 ? (
        <p className="mt-3 text-sm text-ink-500">The crew recorded no vital signs or symptom notes for this patient.</p>
      ) : (
        <Body data={data} now={now} compact={compact} />
      )}
    </JivaCard>
  );
}

function Body({ data, now, compact }: { data: PrehospitalResponse; now: number; compact?: boolean }) {
  const narrative = data.entries.filter((e) => e.symptomDescription || e.symptomOnsetAt);
  const onset = data.entries.find((e) => e.symptomOnsetAt)?.symptomOnsetAt;
  const missing = data.entries.flatMap((e) => e.observations.filter((o) => o.status === 'NOT_AVAILABLE').map((o) => ({ ...o, at: e.recordedAt })));
  const latestMissing = MEASUREMENT_ORDER.map((t) => missing.find((m) => m.type === t)).filter((m): m is NonNullable<typeof m> => !!m && !data.latest[m.type]);
  return (
    <div className="mt-3 space-y-3">
      {(narrative.length > 0 || onset) && (
        <div className="space-y-1.5 rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
          {onset && (
            <p className="text-[13px] text-ink-800">
              <span className="font-semibold">Symptom onset (reported): </span>
              {formatDateTime(onset)} ({timeAgo(onset, now)})
            </p>
          )}
          {narrative
            .filter((e) => e.symptomDescription)
            .map((e) => (
              <p key={e.entryId} className="whitespace-pre-line text-[13px] text-ink-800">
                <span className="text-xs font-semibold text-ink-500">{formatDateTime(e.recordedAt)} · </span>
                {e.symptomDescription}
              </p>
            ))}
        </div>
      )}
      {Object.keys(data.latest).length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Latest crew vital signs">
          {MEASUREMENT_ORDER.filter((t) => data.latest[t]).map((t) => {
            const m = data.latest[t]!;
            const q = measurementQuality(m.quality);
            return (
              <li key={t} className={cx('rounded-xl p-3 ring-1 ring-inset', m.source === 'DEVICE_SIMULATED' ? 'bg-warn-50/40 ring-warn-200' : 'bg-white ring-ink-200')}>
                <p className="text-xs font-semibold text-ink-500">{MEASUREMENT_TEXT[t].label}</p>
                <p className="text-xl font-semibold tabular-nums text-ink-900">
                  {m.value !== undefined ? formatMeasurementValue({ type: t, value: m.value, secondaryValue: m.secondaryValue }) : '—'} <span className="text-sm font-medium text-ink-500">{MEASUREMENT_TEXT[t].unit}</span>
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <JivaStatus meta={measurementSource(m.source)} />
                  <JivaStatus meta={measurementFreshness(m.freshness)} />
                  {q && <JivaStatus meta={q} />}
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {formatDateTime(m.observedAt)} ({timeAgo(m.observedAt, now)})
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {latestMissing.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-600">
          <Icon name="alertCircle" size={13} />
          Not available from the crew:
          {latestMissing.map((m) => (
            <span key={m.type} className="rounded-full bg-ink-100 px-2 py-0.5 font-semibold text-ink-700">
              {MEASUREMENT_TEXT[m.type].label} — {UNAVAILABLE_REASON_TEXT[m.unavailableReason ?? ''] ?? 'not recorded'}
            </span>
          ))}
        </p>
      )}
      {!compact && (
        <details className="text-xs text-ink-600">
          <summary className="cursor-pointer select-none font-semibold text-ink-500 hover:text-ink-700">All crew entries ({data.entries.length})</summary>
          <ul className="mt-1.5 space-y-1.5">
            {data.entries.map((e) => (
              <li key={e.entryId} className="rounded-lg bg-ink-25 px-2.5 py-1.5 ring-1 ring-inset ring-ink-100">
                <p className="font-semibold text-ink-800">
                  {formatDateTime(e.recordedAt)} · {measurementSource(e.source).label} · {e.ambulanceId}
                  {e.dataStatus === 'SYNTHETIC_DEMO' ? ' · synthetic demo data' : ''}
                </p>
                {e.observations.map((o, i) => (
                  <p key={i}>
                    {MEASUREMENT_TEXT[o.type].label}:{' '}
                    {o.status === 'MEASURED' && o.value !== undefined
                      ? `${formatMeasurementValue({ type: o.type, value: o.value, secondaryValue: o.secondaryValue })} ${MEASUREMENT_TEXT[o.type].unit} at ${formatDateTime(o.observedAt)}${o.quality === 'QUESTIONABLE' ? ' (questionable)' : ''}`
                      : `not available — ${UNAVAILABLE_REASON_TEXT[o.unavailableReason ?? ''] ?? 'no reason given'}`}
                  </p>
                ))}
                {e.symptomDescription && <p className="text-ink-700">“{e.symptomDescription}”</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-[11px] text-ink-500">{data.sources.medicalDeviceIntegrated ? 'Device data is labelled per value.' : 'No ambulance monitor is connected to JIVA: values were entered by the crew (or simulated for the demo and labelled so).'}</p>
    </div>
  );
}
