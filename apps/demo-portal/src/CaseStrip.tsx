import type { ReactNode } from 'react';
import { JivaCard, cx, referralStatus, useNow } from '@jiva/ui/src';
import { DEMO } from './workflows';
import type { LiveState } from './useLiveState';

const NAME: Record<string, string> = { 'HOSP-BLR-001': 'Hebbal', 'HOSP-BLR-002': 'Whitefield', 'HOSP-BLR-003': 'Koramangala', 'HOSP-BLR-004': 'Indiranagar' };
const name = (id?: string) => (id ? NAME[id] ?? id : '—');

const TONE: Record<string, string> = {
  ACCEPTED: 'bg-brand-50 text-brand-800 ring-brand-200',
  LIMITED: 'bg-warn-50 text-warn-800 ring-warn-200',
  REJECTED: 'bg-danger-50 text-danger-700 ring-danger-200',
  UNAVAILABLE: 'bg-danger-50 text-danger-700 ring-danger-200',
  EXPIRED: 'bg-ink-100 text-ink-700 ring-ink-200',
  PENDING: 'bg-warn-50 text-warn-900 ring-warn-200',
};

/** The demo case as the server reports it right now (read back after every step and every event). */
export function CaseStrip({ live }: { live: LiveState }) {
  const now = useNow(5000);
  const a = live.ambulance;
  const e = live.encounter;
  return (
    <JivaCard className="bg-surface">
      <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2 xl:grid-cols-4">
        <Fact label={`Case ${DEMO.caseId}`}>{live.caseState ? live.caseState.currentStatus.replace(/_/g, ' ').toLowerCase() : 'no open case'}</Fact>
        <Fact label={`Ambulance ${a?.ambulanceId ?? DEMO.crew.ambulanceId}`}>
          {a ? `${a.status.replace(/_/g, ' ').toLowerCase()}${a.assignedPatient && a.assignedPatient !== DEMO.caseId ? ` · on ${a.assignedPatient}` : ''}${a.destinationHospital ? ` → ${name(a.destinationHospital)}` : ''}` : '—'}
        </Fact>
        <Fact label="Encounter">{e ? `${e.status === 'IN_CARE' ? 'in hospital care' : 'arrived'} at ${name(e.hospitalId)}` : 'none'}</Fact>
        <Fact label="Responsible doctor">{e?.assignedDoctor?.displayName ?? '—'}</Fact>
      </dl>
      {live.referrals && live.referrals.rows.some((r) => r.referral.state !== 'NOT_REQUESTED' || r.answer) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-semibold text-ink-600">Hospital answers:</span>
          {live.referrals.rows
            .filter((r) => r.referral.state !== 'NOT_REQUESTED' || r.answer)
            .map((r) => {
              const s = referralStatus(r, now);
              return (
                <span key={r.hospitalId} className={cx('rounded-full px-2 py-0.5 font-semibold ring-1 ring-inset', TONE[s] ?? 'bg-ink-50 text-ink-700 ring-ink-200')}>
                  {name(r.hospitalId)}: {s.toLowerCase().replace(/_/g, ' ')}
                </span>
              );
            })}
        </div>
      )}
    </JivaCard>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-ink-500">{label}</dt>
      <dd className="font-semibold capitalize text-ink-900">{children}</dd>
    </div>
  );
}
