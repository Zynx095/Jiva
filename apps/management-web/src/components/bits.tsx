import type { ReactNode } from 'react';
import {
  Icon,
  JivaBadge,
  JivaStatus,
  TechnicalDetails,
  acceptanceStatus,
  aiOutputLabel,
  capabilityLabel,
  cx,
  eventCaseId,
  eventHospitalIds,
  eventAmbulanceId,
  eventTechnicalFields,
  formatClock,
  formatCountdown,
  formatKm,
  minutesFromSeconds,
  msUntil,
  type IconName,
  type JivaEvent,
} from '@jiva/ui/src';
import { useModel } from '../model';
import type { AmbulanceState, CandidateSummary, CaseResponse, HospitalState } from '../types';

export function CapabilityChips({ codes, className }: { codes: string[]; className?: string }) {
  if (codes.length === 0) return <span className="text-[13px] text-ink-500">Not assessed yet</span>;
  return (
    <span className={cx('flex flex-wrap gap-1', className)}>
      {codes.map((c) => (
        <span key={c} className="rounded-md bg-ink-50 px-1.5 py-0.5 text-xs font-semibold text-ink-700 ring-1 ring-inset ring-ink-200">
          {capabilityLabel(c)}
        </span>
      ))}
    </span>
  );
}

/** A button that reads like a link, for jumping between related entities. */
export function EntityLink({ children, onClick, icon }: { children: ReactNode; onClick: () => void; icon?: IconName }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex max-w-full items-center gap-1 rounded text-left font-semibold text-brand-700 hover:underline">
      {icon && <Icon name={icon} size={14} className="shrink-0" />}
      <span className="truncate">{children}</span>
    </button>
  );
}

/** Status of one hospital for one case (badge), plus the time context that makes it trustworthy (text). */
export function responseMeta(r: CaseResponse, now: number) {
  const awaiting = r.status === 'PENDING' && (!r.answerBy || Date.parse(r.answerBy) > now);
  const meta =
    r.status === 'CANCELLED'
      ? { label: 'Withdrawn', tone: 'neutral' as const, icon: 'x' as const }
      : r.status === 'PENDING' && !awaiting
        ? { label: 'No answer in time', tone: 'neutral' as const, icon: 'hourglass' as const }
        : acceptanceStatus(r.status);
  const detail = (() => {
    if (r.status === 'CANCELLED') return CANCEL_TEXT[r.cancelReason ?? ''] ?? 'Request withdrawn';
    if (awaiting && r.answerBy) return `Answer due in ${formatCountdown(msUntil(r.answerBy, now))}`;
    if (r.status === 'PENDING') return r.answerBy ? `Deadline was ${formatClock(r.answerBy)}` : undefined;
    const parts = [r.respondedAt && `Answered ${formatClock(r.respondedAt)}`];
    if ((r.status === 'ACCEPTED' || r.status === 'LIMITED') && r.validUntil) parts.push(`valid until ${formatClock(r.validUntil)}`);
    if (r.limitations.length) parts.push(r.limitations.join('; '));
    if (r.cancelReason === 'CASE_CLOSED') parts.push('case closed');
    return parts.filter(Boolean).join(' · ');
  })();
  return { meta, detail };
}

/**
 * The destination hospital's answer FOR THIS CASE. A hospital's operational state holds only its latest
 * answer to any case, so it is used only when it names this case; otherwise the case's own response
 * (from the referral events) is shown, and without either the answer is unknown — never another
 * patient's answer.
 */
export function DestinationAnswer({ caseId, hospital, now }: { caseId?: string; hospital: HospitalState; now: number }) {
  const m = useModel();
  const response = caseId ? m.responses.get(caseId)?.get(hospital.hospitalId) : undefined;
  if (response) return <JivaStatus meta={responseMeta(response, now).meta} />;
  const op = hospital.operationalState;
  return <JivaStatus meta={acceptanceStatus(caseId && op.acceptanceCaseId === caseId ? op.acceptance : 'UNKNOWN')} />;
}

/** One row: who, when asked, their answer — with the answer's context on its own line so nothing collides. */
export function ResponseRow({ title, asked, response, now }: { title: ReactNode; asked?: string; response: CaseResponse; now: number }) {
  const { meta, detail } = responseMeta(response, now);
  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">{title}</div>
        <JivaStatus meta={meta} />
      </div>
      <p className="mt-0.5 text-xs text-ink-500">{[asked, detail].filter(Boolean).join(' · ')}</p>
    </div>
  );
}

const CANCEL_TEXT: Record<string, string> = {
  CASE_CLOSED: 'Case closed',
  DESTINATION_FINALIZED_ELSEWHERE: 'Patient going elsewhere',
  REQUIREMENT_CHANGED: 'Care needs changed',
  OPERATOR_WITHDRAWN: 'Withdrawn by an operator',
};

/** Distance · ETA · provider honesty label for an ambulance's active route. */
export function RouteFacts({ ambulance, className }: { ambulance?: AmbulanceState; className?: string }) {
  const route = ambulance?.activeRoute && ambulance.activeRoute.hospitalId === ambulance.destinationHospital ? ambulance.activeRoute : undefined;
  if (!route) return <span className={cx('text-[13px] text-ink-500', className)}>No route yet</span>;
  return (
    <span className={cx('text-[13px] text-ink-600', className)}>
      <span className="font-semibold tabular-nums text-ink-900">{ambulance?.status === 'ARRIVED' ? 'Arrived' : `${minutesFromSeconds(route.durationSeconds)} min`}</span>
      {' · '}
      {formatKm(route.distanceMeters)}
      {route.synthetic ? ' · synthetic route' : ` · ${route.provider ?? 'road route'}`}
    </span>
  );
}

/** Legacy candidate evaluation: who was considered, who was asked and why. */
export function CandidateTrace({ candidates }: { candidates: CandidateSummary[] }) {
  const order: Record<string, number> = { ELIGIBLE: 0, PENDING_ACCEPTANCE: 1, INELIGIBLE: 2 };
  const sorted = [...candidates].sort((a, b) => (order[a.operationalEligibility] ?? 3) - (order[b.operationalEligibility] ?? 3) || (a.etaMinutes ?? 0) - (b.etaMinutes ?? 0));
  return (
    <ul className="divide-y divide-ink-100">
      {sorted.map((c) => {
        const tone = c.operationalEligibility === 'ELIGIBLE' ? 'ok' : c.operationalEligibility === 'PENDING_ACCEPTANCE' ? 'warn' : 'danger';
        const label = c.operationalEligibility === 'ELIGIBLE' ? 'Eligible' : c.operationalEligibility === 'PENDING_ACCEPTANCE' ? 'Needs acceptance' : 'Not suitable';
        const icon: IconName = tone === 'ok' ? 'checkCircle' : tone === 'warn' ? 'clock' : 'xCircle';
        return (
          <li key={c.hospitalId} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-ink-900">{c.hospitalName}</p>
              <p className="text-xs text-ink-500">
                {c.distanceKm !== undefined && `${c.distanceKm} km`}
                {c.etaMinutes !== undefined && ` · ETA ${c.etaMinutes} min`}
                {c.missingCapabilities.length > 0 && ` · missing ${c.missingCapabilities.map((m) => capabilityLabel(m)).join(', ')}`}
              </p>
              {c.reason && <p className="mt-0.5 text-xs text-ink-600">{c.reason}</p>}
            </div>
            <JivaBadge tone={tone} icon={icon}>
              {label}
            </JivaBadge>
          </li>
        );
      })}
    </ul>
  );
}

/** Advisory automatic output (template or AI), always labelled by what produced it. */
export function AiContent({ event }: { event: JivaEvent }) {
  const p = event.payload;
  const list = (k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-500" title={aiOutputLabel(p.generator).hint}>
        <Icon name="brief" size={13} />
        {aiOutputLabel(p.generator).label} · cannot change routing
      </p>
      {typeof p.summary === 'string' && <p className="text-[13px] text-ink-800">{p.summary}</p>}
      {typeof p.explanation === 'string' && <p className="text-[13px] text-ink-800">{p.explanation}</p>}
      {typeof p.briefSummary === 'string' && <p className="text-[13px] text-ink-800">{p.briefSummary}</p>}
      <BulletList title="Alerts" items={list('criticalAlerts')} />
      <BulletList title="Suggested preparations" items={list('recommendedPreparations')} />
      <BulletList title="Suggested follow-up" items={list('suggestedActions')} />
      <BulletList title="Highlights" items={list('timelineHighlights')} />
    </div>
  );
}

function BulletList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-ink-600">{title}</p>
      <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-[13px] text-ink-700">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

/** Expanded content for any event: the "why", links to what it touches, then the audit evidence. */
export function EventDetails({ event }: { event: JivaEvent }) {
  const m = useModel();
  const caseId = eventCaseId(event);
  const hospitalIds = eventHospitalIds(event);
  const ambulanceId = eventAmbulanceId(event);
  const candidates =
    event.eventType === 'hospital.candidate.generated' && Array.isArray(event.payload.candidates)
      ? (event.payload.candidates as Array<Record<string, unknown>>).map((c) => ({
          hospitalId: String(c.hospitalId),
          hospitalName: String(c.hospitalName),
          operationalEligibility: String(c.operationalEligibility),
          distanceKm: typeof c.distanceKm === 'number' ? c.distanceKm : undefined,
          etaMinutes: typeof c.etaMinutes === 'number' ? c.etaMinutes : undefined,
          reason: typeof c.reason === 'string' ? c.reason : undefined,
          missingCapabilities: Array.isArray(c.missingCapabilities) ? c.missingCapabilities.map(String) : [],
        }))
      : null;
  return (
    <div className="space-y-3">
      {event.eventType.startsWith('ai.') && <AiContent event={event} />}
      {candidates && <CandidateTrace candidates={candidates} />}
      {(caseId || hospitalIds.length > 0 || ambulanceId) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
          {caseId && m.patientById.has(caseId) && (
            <EntityLink icon="siren" onClick={() => m.select({ kind: 'case', id: caseId })}>
              {caseId}
            </EntityLink>
          )}
          {hospitalIds.map((id) =>
            m.hospitalById.has(id) ? (
              <EntityLink key={id} icon="hospital" onClick={() => m.select({ kind: 'hospital', id })}>
                {m.name(id) ?? id}
              </EntityLink>
            ) : null,
          )}
          {ambulanceId && m.ambulanceById.has(ambulanceId) && (
            <EntityLink icon="ambulance" onClick={() => m.select({ kind: 'ambulance', id: ambulanceId })}>
              {ambulanceId}
            </EntityLink>
          )}
        </div>
      )}
      <TechnicalDetails fields={eventTechnicalFields(event)} data={event.payload} />
    </div>
  );
}
