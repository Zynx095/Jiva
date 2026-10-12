import { JivaMetric } from '@jiva/ui/src';
import type { PanelTab } from '../types';

export interface KpiValues {
  open: number;
  arrived: number;
  onJob: number;
  idle: number;
  awaiting: number;
  accepted: number;
  limited: number;
  requests: number;
}

/** Headline numbers. Each one is a shortcut into the list that explains it. */
export function Kpis({ v, tab, statusFilter, onOpen }: {
  v: KpiValues;
  tab: PanelTab | null;
  statusFilter: string[];
  onOpen: (tab: PanelTab, status?: string) => void;
}) {
  const only = (s: string) => statusFilter.length === 1 && statusFilter[0] === s;
  return (
    <section aria-label="Network summary" className="border-b border-ink-200 bg-white">
      <div className="jiva-scroll grid grid-flow-col auto-cols-[minmax(150px,1fr)] gap-1 overflow-x-auto px-2 py-2 lg:px-4">
        <JivaMetric
          label="Active emergencies"
          icon="siren"
          value={v.open}
          tone={v.open > 0 ? 'danger' : undefined}
          hint={v.arrived ? `${v.arrived} handed over at hospital` : 'Cases still being coordinated'}
          onClick={() => onOpen('incidents')}
          active={tab === 'incidents'}
        />
        <JivaMetric
          label="Ambulances on a job"
          icon="ambulance"
          value={v.onJob}
          hint={`${v.idle} available`}
          onClick={() => onOpen('ambulances')}
          active={tab === 'ambulances'}
        />
        <JivaMetric
          label="Awaiting hospital answer"
          icon="clock"
          value={v.awaiting}
          tone={v.awaiting > 0 ? 'warn' : undefined}
          hint={v.awaiting > 0 ? 'Requests still open' : 'No open requests'}
          onClick={() => onOpen('hospitals', 'PENDING')}
          active={tab === 'hospitals' && only('PENDING')}
        />
        <JivaMetric
          label="Hospitals accepting"
          icon="checkCircle"
          value={v.accepted}
          tone={v.accepted > 0 ? 'ok' : undefined}
          hint={v.limited ? `+${v.limited} with limits` : 'Current, unexpired answers'}
          onClick={() => onOpen('hospitals', 'ACCEPTED')}
          active={tab === 'hospitals' && only('ACCEPTED')}
        />
        <JivaMetric
          label="Requests sent"
          icon="send"
          value={v.requests}
          hint="Acceptance requests this session"
          onClick={() => onOpen('activity')}
          active={tab === 'activity'}
        />
      </div>
    </section>
  );
}
