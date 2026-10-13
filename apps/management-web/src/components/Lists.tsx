import { useMemo, useState } from 'react';
import {
  EmptyState,
  Icon,
  JivaFilter,
  JivaStatus,
  JivaTimeline,
  SkeletonRows,
  StatusDot,
  ToggleChip,
  acceptanceStatus,
  ambulanceStatus,
  capabilityStatus,
  cx,
  dataStatus,
  describeEvent,
  formatClock,
  hospitalShortName,
  patientStatus,
  severityStatus,
  timeAgo,
  timeUntil,
  type EventCategory,
  type TimelineItem,
} from '@jiva/ui/src';
import { gpsFreshness, hospitalFreshness, isAwaiting, isOpenCase } from '../derive';
import { useModel } from '../model';
import type { HospitalState, PatientState } from '../types';
import { CapabilityChips, DestinationAnswer, EventDetails, RouteFacts } from './bits';
import { STATUS_FILTERS, statusBucket } from './NetworkMap';

const rowButton =
  'group w-full rounded-xl bg-white p-3.5 text-left ring-1 ring-ink-200 transition-[box-shadow,background-color] duration-150 hover:shadow-sm hover:ring-ink-300 active:scale-[0.995]';

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/* ------------------------------------------------------------------ incidents */

export function IncidentsList({ loaded }: { loaded: boolean }) {
  const m = useModel();
  const cases = m.patients
    .filter((p) => p.currentStatus !== 'DISCHARGED')
    .sort(
      (a, b) =>
        Number(!isOpenCase(a)) - Number(!isOpenCase(b)) ||
        (SEVERITY_RANK[m.facts.get(a.patientId)?.severity ?? ''] ?? 9) - (SEVERITY_RANK[m.facts.get(b.patientId)?.severity ?? ''] ?? 9) ||
        Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated),
    );
  if (!loaded) return <SkeletonRows rows={2} />;
  return (
    <div className="space-y-6">
      {cases.length === 0 ? (
        <EmptyState
          icon="checkCircle"
          title="No active emergencies"
          description="All emergency cases are currently stable. A new emergency appears here the moment it is reported — in the demo, use “Report emergency + dispatch”."
        />
      ) : (
        <ul className="space-y-2.5">
          {cases.map((p) => (
            <li key={p.patientId}>
              <CaseCard p={p} />
            </li>
          ))}
        </ul>
      )}
      <LatestUpdates />
    </div>
  );
}

/** The few most recent meaningful events, so "what just happened" is visible without switching tabs. */
function LatestUpdates() {
  const m = useModel();
  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [];
    for (const e of m.events) {
      if (e.eventType === 'feasibility.trace.recorded' || e.eventType === 'demo.reset') continue;
      const d = describeEvent(e, m.name, 'ops');
      if (d.quiet) continue;
      out.push({ id: e.eventId, time: e.timestamp, title: d.title, description: d.detail, tone: d.tone, icon: d.icon, meta: d.category === 'ai' ? 'AI-generated · advisory only' : undefined });
      if (out.length === 5) break;
    }
    return out;
  }, [m.events, m.name]);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="latest-updates" className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 id="latest-updates" className="text-[13px] font-semibold text-ink-600">
          Latest updates
        </h3>
        <button type="button" onClick={() => m.openTab('activity')} className="inline-flex items-center gap-0.5 text-xs font-semibold text-brand-700 hover:underline">
          All activity <Icon name="chevronRight" size={13} />
        </button>
      </div>
      <JivaTimeline items={items} dense groupByDay={false} />
    </section>
  );
}

function CaseCard({ p }: { p: PatientState }) {
  const m = useModel();
  const facts = m.facts.get(p.patientId);
  const amb = m.ambulanceForCase(p.patientId);
  const dest = amb?.destinationHospital ? m.hospitalById.get(amb.destinationHospital) : undefined;
  const responses = [...(m.responses.get(p.patientId)?.values() ?? [])];
  const count = (s: string) => responses.filter((r) => r.status === s).length;
  const awaiting = responses.filter((r) => isAwaiting(r, m.now)).length;
  const sev = severityStatus(facts?.severity);
  const open = isOpenCase(p);
  return (
    <button type="button" onClick={() => m.select({ kind: 'case', id: p.patientId })} className={cx(rowButton, open && sev.tone === 'danger' && 'shadow-[inset_3px_0_0_var(--color-danger-500)]')}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 font-semibold text-ink-900">{p.patientId}</span>
        {facts?.severity && <JivaStatus meta={sev} />}
        <JivaStatus meta={patientStatus(p.currentStatus)} />
        <span className="ml-auto text-xs text-ink-500">{timeAgo(facts?.reportedAt ?? p.lastUpdated, m.now)}</span>
      </div>
      <p className="mt-1.5 text-sm text-ink-800">{p.activeConditions.join(', ') || 'Condition not reported'}</p>
      <CapabilityChips codes={p.careRequirements} className="mt-1.5" />
      <div className="mt-3 flex items-center gap-2 border-t border-ink-100 pt-2.5 text-[13px]">
        <Icon name="ambulance" size={15} className="shrink-0 text-ink-500" />
        {amb ? (
          <span className="min-w-0 flex-1 truncate">
            <span className="font-semibold text-ink-900">{amb.ambulanceId}</span>
            <span className="text-ink-500"> → </span>
            {dest ? <span className="text-ink-800">{hospitalShortName(dest.displayName, dest.address?.locality)}</span> : <span className="font-medium text-warn-700">awaiting a hospital</span>}
          </span>
        ) : (
          <span className="flex-1 text-warn-700">No ambulance assigned</span>
        )}
        {dest && <DestinationAnswer caseId={p.patientId} hospital={dest} now={m.now} />}
      </div>
      {amb && <RouteFacts ambulance={amb} className="mt-1 block pl-6" />}
      {responses.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-ink-600">
          <span>{responses.length} asked</span>
          {count('ACCEPTED') > 0 && (
            <span className="inline-flex items-center gap-1">
              <StatusDot tone="ok" />
              {count('ACCEPTED')} accepted
            </span>
          )}
          {count('LIMITED') > 0 && (
            <span className="inline-flex items-center gap-1">
              <StatusDot tone="warn" />
              {count('LIMITED')} limited
            </span>
          )}
          {count('REJECTED') + count('UNAVAILABLE') > 0 && (
            <span className="inline-flex items-center gap-1">
              <StatusDot tone="danger" />
              {count('REJECTED') + count('UNAVAILABLE')} declined
            </span>
          )}
          {awaiting > 0 && (
            <span className="inline-flex items-center gap-1 font-semibold text-warn-700">
              <StatusDot tone="warn" pulse />
              {awaiting} awaiting
            </span>
          )}
        </div>
      )}
      <span className="mt-2 flex items-center justify-end gap-0.5 text-xs font-semibold text-brand-700 opacity-80 group-hover:opacity-100">
        View case <Icon name="chevronRight" size={14} />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ hospitals */

export function HospitalsList({ statuses, onStatuses, staleOnly, loaded }: { statuses: string[]; onStatuses: (s: string[]) => void; staleOnly: boolean; loaded: boolean }) {
  const m = useModel();
  const counts: Record<string, number> = {};
  for (const h of m.hospitals) counts[statusBucket(m.hospitalStatus(h))] = (counts[statusBucket(m.hospitalStatus(h))] ?? 0) + 1;
  const rank: Record<string, number> = { PENDING: 0, ACCEPTED: 1, LIMITED: 2, UNAVAILABLE: 3, REJECTED: 3, UNKNOWN: 4, EXPIRED: 4 };
  const list = m.hospitals
    .filter((h) => !statuses.length || statuses.includes(statusBucket(m.hospitalStatus(h))))
    .filter((h) => !staleOnly || hospitalFreshness(h, m.now).stale)
    .sort((a, b) => (rank[m.hospitalStatus(a)] ?? 9) - (rank[m.hospitalStatus(b)] ?? 9) || a.displayName.localeCompare(b.displayName));

  return (
    <div className="space-y-3">
      <JivaFilter
        className="flex-wrap"
        label="Filter hospitals by status"
        value={statuses}
        onChange={onStatuses}
        options={STATUS_FILTERS.map((s) => ({ value: s, label: acceptanceStatus(s).label.replace('No current response', 'Unknown'), tone: acceptanceStatus(s).tone, count: counts[s] ?? 0 }))}
      />
      {staleOnly && <p className="text-xs text-warn-700">Showing hospitals whose operational data is stale or seed-only (map filter “Stale data”).</p>}
      {!loaded ? (
        <SkeletonRows rows={4} />
      ) : list.length === 0 ? (
        <EmptyState
          compact
          icon="filter"
          title="No hospitals match these filters"
          description="Every hospital is still on the map; the filter only narrows this list."
          action={
            <button type="button" onClick={() => onStatuses([])} className="text-sm font-semibold text-brand-700 hover:underline">
              Clear filters
            </button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {list.map((h) => (
            <li key={h.hospitalId}>
              <HospitalRow h={h} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HospitalRow({ h }: { h: HospitalState }) {
  const m = useModel();
  const status = m.hospitalStatus(h);
  const meta = acceptanceStatus(status);
  const op = h.operationalState;
  const fresh = hospitalFreshness(h, m.now);
  const answered = op.lastConfirmedAt && (status === 'ACCEPTED' || status === 'LIMITED' || status === 'REJECTED');
  return (
    <button type="button" onClick={() => m.select({ kind: 'hospital', id: h.hospitalId })} className={rowButton}>
      <div className="flex items-start gap-3">
        <span className={cx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', meta.tone === 'ok' ? 'bg-brand-600 text-white' : meta.tone === 'warn' ? 'bg-warn-600 text-white' : meta.tone === 'danger' ? 'bg-danger-600 text-white' : 'bg-white text-ink-600 ring-1 ring-ink-300')}>
          <span className="text-sm font-extrabold leading-none" aria-hidden="true">H</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 text-sm font-semibold leading-5 text-ink-900">{h.displayName}</p>
            <JivaStatus meta={meta} />
          </div>
          <p className="mt-0.5 text-xs text-ink-500">
            {h.address?.locality ?? h.address?.city}
            {' · '}
            <span className={h.dataStatus === 'SYNTHETIC_DEMO' ? 'text-warn-700' : undefined}>{dataStatus(h.dataStatus).label}</span>
            {op.acceptanceCaseId && (status === 'ACCEPTED' || status === 'LIMITED' || status === 'REJECTED') && ` · for ${op.acceptanceCaseId}`}
          </p>
          <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-600">
            {(['emergency', 'icu', 'trauma'] as const).map((k) => {
              const s = capabilityStatus(op[k]);
              return (
                <span key={k} className="inline-flex items-center gap-1">
                  <StatusDot tone={s.tone} />
                  {k === 'emergency' ? 'ED' : k === 'icu' ? 'ICU' : 'Trauma'} {s.label.toLowerCase()}
                </span>
              );
            })}
          </p>
          <p className={cx('mt-1 text-xs', fresh.stale ? 'text-warn-700' : 'text-ink-500')}>
            {answered ? `Answered ${timeAgo(op.lastConfirmedAt, m.now)}` : status === 'PENDING' ? 'Request open — waiting for an answer' : fresh.text || 'No answer yet'}
            {answered && op.expiresAt && (status === 'ACCEPTED' || status === 'LIMITED') ? ` · expires ${timeUntil(op.expiresAt, m.now)}` : ''}
          </p>
        </div>
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ ambulances */

export function AmbulancesList({ loaded }: { loaded: boolean }) {
  const m = useModel();
  const rank = (s: string) => (s === 'AVAILABLE' ? 2 : s === 'UNAVAILABLE' ? 3 : s === 'ARRIVED' ? 1 : 0);
  const list = [...m.ambulances].sort((a, b) => rank(a.status) - rank(b.status) || a.ambulanceId.localeCompare(b.ambulanceId));
  if (!loaded) return <SkeletonRows rows={3} />;
  if (!list.length) return <EmptyState icon="ambulance" title="No ambulances registered" description="Ambulances appear here once their crews connect to JIVA." />;
  return (
    <ul className="space-y-2">
      {list.map((a) => {
        const dest = a.destinationHospital ? m.hospitalById.get(a.destinationHospital) : undefined;
        const gps = gpsFreshness(a, m.now);
        return (
          <li key={a.ambulanceId}>
            <button type="button" onClick={() => m.select({ kind: 'ambulance', id: a.ambulanceId })} className={rowButton}>
              <div className="flex items-center gap-3">
                <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', a.status === 'AVAILABLE' ? 'bg-white text-ink-600 ring-1 ring-ink-300' : 'bg-ink-900 text-white')}>
                  <Icon name="ambulance" size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-ink-900">{a.ambulanceId}</p>
                    <JivaStatus meta={ambulanceStatus(a.status)} />
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-600">
                    {a.assignedPatient ? (
                      <>
                        {a.assignedPatient} → {dest ? hospitalShortName(dest.displayName, dest.address?.locality) : <span className="text-warn-700">awaiting a hospital</span>}
                      </>
                    ) : (
                      'No case assigned'
                    )}
                  </p>
                  {a.assignedPatient && <RouteFacts ambulance={a} className="mt-0.5 block text-xs" />}
                  <p className={cx('mt-0.5 text-xs', gps.stale ? 'text-warn-700' : 'text-ink-500')}>{a.locationAsOf ? `GPS ${timeAgo(a.locationAsOf, m.now)}${gps.stale ? ' — stale' : ''}` : gps.text}</p>
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ activity */

type ActivityFilter = Exclude<EventCategory, 'system' | 'case'>;
const CATEGORY_LABEL: Record<ActivityFilter, string> = { decision: 'Decisions', hospital: 'Hospitals', ambulance: 'Ambulances', routing: 'Routing', ai: 'AI briefs' };

export function ActivityFeed({ loaded }: { loaded: boolean }) {
  const m = useModel();
  const [cats, setCats] = useState<ActivityFilter[]>([]);
  const [showGps, setShowGps] = useState(false);

  const items = useMemo<TimelineItem[]>(() => {
    const out: TimelineItem[] = [];
    let last: { item: TimelineItem; ambulanceId?: string } | null = null;
    const traces = cats.includes('decision');
    for (const e of m.events) {
      // Shadow-engine audit traces are decision evidence: listed only when "Decisions" is selected.
      if (e.eventType === 'feasibility.trace.recorded' && !traces) continue;
      const d = describeEvent(e, m.name, 'ops');
      if (d.quiet && e.eventType !== 'feasibility.trace.recorded' && !showGps) continue;
      if (cats.length && !cats.includes(d.category as ActivityFilter)) continue;
      // Merge consecutive GPS fixes from one ambulance into a single row.
      if (e.eventType === 'ambulance.location.updated' && last && last.ambulanceId === d.ambulanceId && last.item.icon === 'pin' && last.item.title === d.title) {
        last.item.count = (last.item.count ?? 1) + 1;
        continue;
      }
      const item: TimelineItem = {
        id: e.eventId,
        time: e.timestamp,
        title: d.title,
        description: d.detail,
        tone: d.tone,
        icon: d.icon,
        meta: d.category === 'ai' ? 'Advisory' : e.source.type === 'system' ? `JIVA ${e.source.id.replace(/-/g, ' ')}` : `${e.source.type} ${e.source.id}`,
        details: <EventDetails event={e} />,
      };
      out.push(item);
      last = { item, ambulanceId: e.eventType === 'ambulance.location.updated' ? d.ambulanceId : undefined };
      if (out.length >= 150) break;
    }
    return out;
  }, [m.events, m.name, cats, showGps]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <JivaFilter
          className="flex-wrap"
          label="Filter activity"
          value={cats}
          onChange={setCats}
          options={(Object.keys(CATEGORY_LABEL) as ActivityFilter[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
        />
        <ToggleChip icon="pin" pressed={showGps} onChange={setShowGps}>
          GPS updates
        </ToggleChip>
      </div>
      {!loaded ? (
        <SkeletonRows rows={5} />
      ) : (
        <JivaTimeline
          dense
          items={items}
          detailsLabel="Why & evidence"
          empty={
            <EmptyState
              compact
              icon="activity"
              title={cats.length ? 'Nothing in this category yet' : 'No activity yet'}
              description={cats.length ? 'Try another filter or clear it.' : `Every decision JIVA makes is listed here as it happens. Last checked ${formatClock(m.now)}.`}
            />
          }
        />
      )}
    </div>
  );
}
