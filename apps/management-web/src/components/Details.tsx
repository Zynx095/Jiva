import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CardHeader,
  DataRow,
  EmptyState,
  Icon,
  JivaButton,
  JivaCard,
  JivaStatus,
  JivaTimeline,
  SectionLabel,
  TechnicalDetails,
  acceptanceStatus,
  ambulanceStatus,
  capabilityLabel,
  capabilityStatus,
  dataStatus,
  describeEvent,
  formatClock,
  formatKm,
  minutesFromSeconds,
  patientStatus,
  severityStatus,
  timeAgo,
  timeUntil,
  capacityLine,
  encounterArrivedAt,
  encounterHandedOverAt,
  encounterStatus,
  referralDetail,
  referralStatus,
  type EncounterRecord,
  type ReferralOverview,
  type TimelineItem,
} from '@jiva/ui/src';
import { apiGet } from '../api';
import { eventsForCase, gpsFreshness, hospitalFreshness } from '../derive';
import { useModel } from '../model';
import { CandidateTrace, CapabilityChips, DestinationAnswer, EntityLink, EventDetails, ResponseRow, RouteFacts } from './bits';

function Block({ title, children, count, action }: { title: string; children: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel count={count}>{title}</SectionLabel>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ case */

export function CaseDetail({ id }: { id: string }) {
  const m = useModel();
  const p = m.patientById.get(id);
  const facts = m.facts.get(id);
  const amb = m.ambulanceForCase(id);
  const dest = amb?.destinationHospital ? m.hospitalById.get(amb.destinationHospital) : undefined;
  const responses = [...(m.responses.get(id)?.values() ?? [])];
  const candidates = m.candidates.get(id) ?? [];
  const notAsked = candidates.filter((c) => c.operationalEligibility === 'INELIGIBLE' && !responses.some((r) => r.hospitalId === c.hospitalId));

  const timeline = useMemo<TimelineItem[]>(() => {
    const list = eventsForCase(m.events, id, amb?.ambulanceId, facts?.reportedAt).filter((e) => e.eventType !== 'ambulance.location.updated' && e.eventType !== 'feasibility.trace.recorded');
    return list.map((e) => {
      const d = describeEvent(e, m.name, 'ops');
      return { id: e.eventId, time: e.timestamp, title: d.title, description: d.detail, tone: d.tone, icon: d.icon, details: <EventDetails event={e} /> };
    });
  }, [m.events, m.name, id, amb?.ambulanceId, facts?.reportedAt]);

  if (!p) return <Missing what="case" />;
  const route = amb?.activeRoute && amb.activeRoute.hospitalId === amb.destinationHospital ? amb.activeRoute : undefined;

  return (
    <div className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink-900">{p.patientId}</h2>
          <JivaStatus meta={severityStatus(facts?.severity)} />
          <JivaStatus meta={patientStatus(p.currentStatus)} />
          {p.dataStatus === 'SYNTHETIC_DEMO' && <JivaStatus meta={{ label: 'Demo case', tone: 'warn', icon: 'info', hint: 'Created in demo mode with synthetic data.' }} />}
        </div>
        <p className="mt-1 text-sm text-ink-800">{p.activeConditions.join(', ') || 'Condition not reported'}</p>
        <p className="mt-0.5 text-xs text-ink-500">{facts?.reportedAt ? `Reported ${formatClock(facts.reportedAt)} · ${timeAgo(facts.reportedAt, m.now)}` : `Updated ${timeAgo(p.lastUpdated, m.now)}`}</p>
        <div className="mt-2.5">
          <CapabilityChips codes={p.careRequirements} />
        </div>
      </header>

      <JivaCard padded className="space-y-1">
        <dl className="divide-y divide-ink-100">
          <DataRow label="Ambulance">
            {amb ? (
              <EntityLink icon="ambulance" onClick={() => m.select({ kind: 'ambulance', id: amb.ambulanceId })}>
                {amb.ambulanceId} · {ambulanceStatus(amb.status).label}
              </EntityLink>
            ) : p.currentStatus === 'HANDED_OVER' ? (
              <span className="text-ink-600">Released after handover</span>
            ) : (
              <span className="text-warn-700">Not assigned</span>
            )}
          </DataRow>
          <DataRow label="Destination">
            {dest ? (
              <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                <EntityLink onClick={() => m.select({ kind: 'hospital', id: dest.hospitalId })}>{m.name(dest.hospitalId) ?? dest.displayName}</EntityLink>
                <DestinationAnswer caseId={id} hospital={dest} now={m.now} />
              </span>
            ) : (
              <span className="text-warn-700">{amb ? 'Waiting for a hospital to accept' : '—'}</span>
            )}
          </DataRow>
          <DataRow label="Arrival">
            <RouteFacts ambulance={amb} />
          </DataRow>
        </dl>
        {route && amb && (
          <div className="flex flex-wrap gap-2 pt-2">
            <JivaButton size="sm" icon="route" onClick={() => m.fitRoute(amb.ambulanceId)}>
              View route
            </JivaButton>
          </div>
        )}
      </JivaCard>

      <Block title="Hospital answers" count={responses.length}>
        {responses.length === 0 ? (
          <p className="text-[13px] text-ink-500">No hospital has been asked yet. JIVA asks only hospitals that list the required care and have not reported their emergency department unavailable.</p>
        ) : (
          <ul className="divide-y divide-ink-100 rounded-xl bg-white ring-1 ring-ink-200">
            {responses.map((r) => (
              <li key={r.hospitalId}>
                <ResponseRow
                  response={r}
                  now={m.now}
                  asked={`Asked ${r.requestedAt ? formatClock(r.requestedAt) : '—'}${r.etaMinutes !== undefined ? ` (ETA then ${r.etaMinutes} min)` : ''}`}
                  title={<EntityLink onClick={() => m.select({ kind: 'hospital', id: r.hospitalId })}>{m.name(r.hospitalId) ?? r.hospitalId}</EntityLink>}
                />
              </li>
            ))}
          </ul>
        )}
        {notAsked.length > 0 && (
          <p className="text-xs text-ink-500">
            Not asked: {notAsked.map((c) => `${m.name(c.hospitalId) ?? c.hospitalName} (missing ${c.missingCapabilities.map((x) => capabilityLabel(x)).join(', ') || 'requirements'})`).join('; ')}.
          </p>
        )}
      </Block>

      <EncounterSummary caseId={id} />

      <ReferralEvidence caseId={id} />

      {candidates.length > 0 && (
        <details className="group rounded-xl bg-white ring-1 ring-ink-200">
          <summary className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-[13px] font-semibold text-ink-700">
            <span className="inline-flex items-center gap-1.5">
              <Icon name="list" size={15} />
              Why these hospitals — decision trace
            </span>
            <Icon name="chevronDown" size={15} className="transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-ink-100 px-3.5 pb-2">
            <p className="pt-2 text-xs text-ink-500">Mapping only orders eligible hospitals by ETA; it never decides eligibility.</p>
            <CandidateTrace candidates={candidates} />
          </div>
        </details>
      )}

      <Block title="Case timeline" count={timeline.length}>
        <JivaTimeline items={timeline} dense detailsLabel="Why & evidence" empty={<p className="text-[13px] text-ink-500">No events recorded for this case yet.</p>} />
      </Block>
    </div>
  );
}

/* ------------------------------------------------------------------ hospital */

const SERVICES = [
  { key: 'emergency', cap: 'emergency', label: 'Emergency department' },
  { key: 'icu', cap: 'icu', label: 'Intensive care (ICU)' },
  { key: 'trauma', cap: 'trauma', label: 'Trauma' },
  { key: 'nicu', cap: 'nicu', label: 'Newborn ICU' },
  { key: 'picu', cap: 'picu', label: "Children's ICU" },
  { key: 'ventilator', cap: 'ventilator', label: 'Ventilators' },
] as const;

export function HospitalDetail({ id }: { id: string }) {
  const m = useModel();
  const h = m.hospitalById.get(id);
  if (!h) return <Missing what="hospital" />;
  const op = h.operationalState;
  const status = m.hospitalStatus(h);
  const fresh = hospitalFreshness(h, m.now);
  const incoming = m.ambulances.filter((a) => a.destinationHospital === id);
  const cases = [...m.responses.entries()].flatMap(([caseId, mm]) => (mm.has(id) ? [{ caseId, r: mm.get(id)! }] : []));

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-lg font-semibold leading-6 tracking-[-0.01em] text-ink-900">{h.displayName}</h2>
        <p className="mt-0.5 text-[13px] text-ink-500">
          {[h.address?.locality, h.address?.city].filter(Boolean).join(', ')}
          {h.facilityType ? ` · ${h.facilityType}` : ''}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <JivaStatus meta={acceptanceStatus(status)} size="md" />
          <JivaStatus meta={dataStatus(h.dataStatus)} size="md" />
        </div>
      </header>

      <JivaCard>
        <CardHeader title="Current answer" subtitle={acceptanceStatus(status).hint} level={3} />
        <dl className="mt-2 divide-y divide-ink-100">
          <DataRow label="For case">
            {op.acceptanceCaseId ? <EntityLink onClick={() => m.select({ kind: 'case', id: op.acceptanceCaseId! })}>{op.acceptanceCaseId}</EntityLink> : '—'}
          </DataRow>
          <DataRow label="Answered">{op.lastConfirmedAt ? `${formatClock(op.lastConfirmedAt)} · ${timeAgo(op.lastConfirmedAt, m.now)}` : 'No answer yet'}</DataRow>
          <DataRow label="Valid">{op.expiresAt && (op.acceptance === 'ACCEPTED' || op.acceptance === 'LIMITED') ? `until ${formatClock(op.expiresAt)} (${timeUntil(op.expiresAt, m.now)})` : '—'}</DataRow>
          <DataRow label="Source">{op.source === 'SYNTHETIC_DEMO' ? 'Simulated demo response' : op.source === 'UNKNOWN' ? 'No report' : op.source}</DataRow>
        </dl>
        {fresh.stale && fresh.text && (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-warn-700">
            <Icon name="clock" size={13} />
            {fresh.text}
          </p>
        )}
      </JivaCard>

      <Block title="Services">
        <ul className="divide-y divide-ink-100 rounded-xl bg-white ring-1 ring-ink-200">
          {SERVICES.map((s) => {
            const listed = h.capabilities?.[s.cap];
            const st = capabilityStatus(op[s.key]);
            return (
              <li key={s.key} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-ink-900">{s.label}</p>
                  <p className="text-xs text-ink-500">{listed ? 'Listed in directory' : listed === false ? 'Not offered' : 'Not listed'}</p>
                </div>
                <JivaStatus meta={st} />
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-ink-500">
          {op.capacityAsOf ? `Status reported ${timeAgo(op.capacityAsOf, m.now)}.` : 'Statuses are seed values, not a live report.'} Ward, room and bed-level data stay inside the hospital — JIVA only receives answers and capacity flags.
        </p>
      </Block>

      <Block title="Ambulances heading here" count={incoming.length}>
        {incoming.length === 0 ? (
          <p className="text-[13px] text-ink-500">No ambulance is currently routed to this hospital.</p>
        ) : (
          <ul className="space-y-1.5">
            {incoming.map((a) => (
              <li key={a.ambulanceId} className="flex items-center justify-between gap-3 rounded-xl bg-white px-3.5 py-2.5 ring-1 ring-ink-200">
                <EntityLink icon="ambulance" onClick={() => m.select({ kind: 'ambulance', id: a.ambulanceId })}>
                  {a.ambulanceId}
                  {a.assignedPatient ? ` · ${a.assignedPatient}` : ''}
                </EntityLink>
                <RouteFacts ambulance={a} />
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block title="Requests for this hospital" count={cases.length}>
        {cases.length === 0 ? (
          <p className="text-[13px] text-ink-500">JIVA has not asked this hospital about any case in this session.</p>
        ) : (
          <ul className="divide-y divide-ink-100 rounded-xl bg-white ring-1 ring-ink-200">
            {cases.map(({ caseId, r }) => (
              <li key={caseId}>
                <ResponseRow
                  response={r}
                  now={m.now}
                  asked={r.requestedAt ? `Asked ${formatClock(r.requestedAt)}` : undefined}
                  title={
                    <EntityLink icon="siren" onClick={() => m.select({ kind: 'case', id: caseId })}>
                      {caseId}
                    </EntityLink>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Block>

      <TechnicalDetails
        summary="Provenance & identifiers"
        fields={[
          ['Hospital id', h.hospitalId],
          ['Record status', h.dataStatus],
          ['Verification', h.verificationStatus],
          ['Coordinates', h.location ? `${h.location.latitude}, ${h.location.longitude} (${h.location.coordinateSource})` : '—'],
          ['Acceptance as of', op.acceptanceAsOf ?? '—'],
          ['Capacity as of', op.capacityAsOf ?? '—'],
        ]}
        data={h.provenance}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ ambulance */

export function AmbulanceDetail({ id }: { id: string }) {
  const m = useModel();
  const a = m.ambulanceById.get(id);
  const recent = useMemo<TimelineItem[]>(
    () =>
      m.events
        .filter((e) => e.payload.ambulanceId === id && e.eventType !== 'ambulance.location.updated')
        .slice(0, 12)
        .map((e) => {
          const d = describeEvent(e, m.name, 'ops');
          return { id: e.eventId, time: e.timestamp, title: d.title, description: d.detail, tone: d.tone, icon: d.icon, details: <EventDetails event={e} /> };
        }),
    [m.events, m.name, id],
  );
  if (!a) return <Missing what="ambulance" />;
  const dest = a.destinationHospital ? m.hospitalById.get(a.destinationHospital) : undefined;
  const route = a.activeRoute && a.activeRoute.hospitalId === a.destinationHospital ? a.activeRoute : undefined;
  const gps = gpsFreshness(a, m.now);

  return (
    <div className="space-y-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink-900">Ambulance {a.ambulanceId}</h2>
          <JivaStatus meta={ambulanceStatus(a.status)} size="md" />
        </div>
        <p className="mt-0.5 text-xs text-ink-500">{a.dataStatus === 'SYNTHETIC_DEMO' ? 'Demo unit · synthetic GPS telemetry' : 'Position as reported by the unit'}</p>
      </header>

      <JivaCard>
        <dl className="divide-y divide-ink-100">
          <DataRow label="Case">
            {a.assignedPatient ? <EntityLink icon="siren" onClick={() => m.select({ kind: 'case', id: a.assignedPatient! })}>{a.assignedPatient}</EntityLink> : 'None'}
          </DataRow>
          <DataRow label="Destination">
            {dest ? (
              <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
                <EntityLink onClick={() => m.select({ kind: 'hospital', id: dest.hospitalId })}>{m.name(dest.hospitalId) ?? dest.displayName}</EntityLink>
                <DestinationAnswer caseId={a.assignedPatient} hospital={dest} now={m.now} />
              </span>
            ) : a.assignedPatient ? (
              <span className="text-warn-700">Waiting for a hospital to accept</span>
            ) : (
              '—'
            )}
          </DataRow>
          <DataRow label="Arrival">{route ? (a.status === 'ARRIVED' ? 'Arrived' : `${minutesFromSeconds(route.durationSeconds)} min · ${formatKm(route.distanceMeters)}`) : '—'}</DataRow>
          <DataRow label="Route">{route ? `${route.synthetic ? 'Synthetic (mock provider)' : route.provider ?? 'Road route'}${route.trafficAware ? '' : ', no live traffic'} · calculated ${formatClock(route.calculatedAt)}` : '—'}</DataRow>
          <DataRow label="GPS">
            <span className={gps.stale ? 'text-warn-700' : undefined}>
              {a.locationAsOf ? `${timeAgo(a.locationAsOf, m.now)}${a.speedKmh !== undefined ? ` · ${Math.round(a.speedKmh)} km/h` : ''}` : gps.text}
            </span>
          </DataRow>
        </dl>
        {route && (
          <div className="pt-3">
            <JivaButton size="sm" icon="route" onClick={() => m.fitRoute(a.ambulanceId)}>
              View route
            </JivaButton>
          </div>
        )}
      </JivaCard>

      <Block title="Recent activity" count={recent.length}>
        <JivaTimeline items={recent} dense detailsLabel="Why & evidence" empty={<p className="text-[13px] text-ink-500">No activity for this ambulance yet.</p>} />
      </Block>

      <TechnicalDetails
        summary="Telemetry & identifiers"
        fields={[
          ['Ambulance id', a.ambulanceId],
          ['Position', a.currentLocation ? `${a.currentLocation.latitude.toFixed(5)}, ${a.currentLocation.longitude.toFixed(5)}` : '—'],
          ['GPS fix time', a.locationAsOf ?? '—'],
          ['Heading', a.heading !== undefined ? `${a.heading}°` : '—'],
          ['Last updated', a.lastUpdated],
        ]}
      />
    </div>
  );
}

function Missing({ what }: { what: string }) {
  return <EmptyState icon="help" title={`This ${what} is no longer listed`} description="It may have been cleared by a demo reset. Go back to the network overview." />;
}


/* ------------------------------------------------------------------ encounter */

/**
 * Where the patient is in hospital care, as recorded by the hospital (GET /api/encounters, summary view
 * for network coordination: no clinical content, no doctor, no staff identities).
 */
function EncounterSummary({ caseId }: { caseId: string }) {
  const m = useModel();
  const [list, setList] = useState<EncounterRecord[] | null>(null);
  const caseEvents = m.events.filter((e) => e.patientId === caseId || e.payload.caseId === caseId).length;
  useEffect(() => {
    let live = true;
    apiGet<EncounterRecord[]>(`/api/encounters?caseId=${encodeURIComponent(caseId)}`)
      .then((l) => live && setList(l))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [caseId, caseEvents]);

  const e = list?.[0];
  if (!e) return null;
  const handedOverAt = encounterHandedOverAt(e);
  return (
    <Block title="At the hospital">
      <JivaCard padded className="space-y-1">
        <dl className="divide-y divide-ink-100">
          <DataRow label="Hospital">
            <EntityLink onClick={() => m.select({ kind: 'hospital', id: e.hospitalId })}>{m.name(e.hospitalId) ?? e.hospitalName ?? e.hospitalId}</EntityLink>
          </DataRow>
          <DataRow label="Status">
            <JivaStatus meta={encounterStatus(e.status)} />
          </DataRow>
          <DataRow label="Arrival recorded">{formatClock(encounterArrivedAt(e))}</DataRow>
          <DataRow label="Handover">{handedOverAt ? formatClock(handedOverAt) : <span className="text-warn-700">Not recorded yet</span>}</DataRow>
          <DataRow label="Record">
            <JivaStatus meta={dataStatus(e.dataStatus)} />
          </DataRow>
        </dl>
        <p className="text-xs text-ink-500">Recorded by the hospital. Clinical details stay with the hospital's care team.</p>
      </JivaCard>
    </Block>
  );
}

/* ------------------------------------------------------------------ referral evidence */

/**
 * The four kinds of information JIVA holds per connected hospital for this case, kept apart: what it
 * lists, what JIVA assessed, what it answered (the only thing that makes it a destination), and its last
 * capacity report with who reported it. Server read model (GET /api/cases/:id/referrals).
 */
function ReferralEvidence({ caseId }: { caseId: string }) {
  const m = useModel();
  const [overview, setOverview] = useState<ReferralOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const caseEvents = m.events.filter((e) => e.patientId === caseId || e.payload.caseId === caseId).length;
  useEffect(() => {
    let live = true;
    apiGet<ReferralOverview>(`/api/cases/${encodeURIComponent(caseId)}/referrals`)
      .then((o) => {
        if (!live) return;
        setOverview(o);
        setFailed(false);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [caseId, caseEvents]);

  if (failed && !overview) return <p className="text-xs text-ink-500">Referral evidence is unavailable right now.</p>;
  if (!overview) return null;
  return (
    <Block title="Referral evidence" count={overview.rows.length}>
      <p className="text-xs text-ink-500">Listed care and reported capacity never make a hospital a destination — only its explicit, current answer for this case does.</p>
      <ul className="divide-y divide-ink-100 rounded-xl bg-white ring-1 ring-ink-200">
        {overview.rows.map((r) => (
          <li key={r.hospitalId} className="space-y-1 px-3 py-2.5 text-xs">
            <div className="flex items-start justify-between gap-2">
              <EntityLink onClick={() => m.select({ kind: 'hospital', id: r.hospitalId })}>{m.name(r.hospitalId) ?? r.name}</EntityLink>
              <JivaStatus meta={acceptanceStatus(referralStatus(r, m.now))} />
            </div>
            <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-0.5 text-ink-600">
              <dt className="text-ink-500">Lists</dt>
              <dd>{r.listed.missingRequired.length ? `not ${r.listed.missingRequired.map((c) => capabilityLabel(c)).join(', ')}` : 'all required care'}</dd>
              <dt className="text-ink-500">Assessed</dt>
              <dd>{r.assessment ? `at referral: ${r.assessment.eligibility === 'INELIGIBLE' ? 'not suitable' : r.assessment.eligibility === 'ELIGIBLE' ? 'eligible' : 'capable, answer needed'}${r.assessment.etaMinutes ? ` · ≈ ${r.assessment.etaMinutes} min estimate` : ''}` : 'not evaluated'}</dd>
              <dt className="text-ink-500">Answer</dt>
              <dd>{referralDetail(r, m.now)}{r.answer ? ` · ${dataStatus(r.answer.provenance).label.toLowerCase()} · ref ${r.answer.requestId}` : ''}</dd>
              <dt className="text-ink-500">Capacity</dt>
              <dd>{capacityLine(r, m.now)}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </Block>
  );
}
