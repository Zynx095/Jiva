import type { ReactNode } from 'react';
import { CardHeader, ConnectionPill, Icon, JivaCard, jivaAppUrl, type JivaApp } from '@jiva/ui/src';
import { API_URL } from './api';
import { DEMO } from './workflows';
import type { LiveState } from './useLiveState';

const APPS: Array<{ app: JivaApp; title: string; personas: Array<[string, string]> }> = [
  { app: 'ambulance', title: 'Ambulance', personas: [[DEMO.crew.persona, `Crew ${DEMO.crew.ambulanceId}`], ['demo-amb-1', 'Crew AMB-BLR-001']] },
  { app: 'hospital', title: 'Hospital console', personas: [['demo-hosp-1', 'Hebbal coordinator'], ['demo-hosp-4', 'Indiranagar coordinator']] },
  { app: 'doctor', title: 'Doctor workspace', personas: [[DEMO.doctor.persona, DEMO.doctor.name], ['demo-doc-1', 'Dr. Kavya Rao']] },
  { app: 'patient', title: 'Patient', personas: [[DEMO.patient, `Patient ${DEMO.caseId}`]] },
  { app: 'management', title: 'Management', personas: [[DEMO.management, 'Network coordination']] },
];

/** The running system as the API reports it, the portal's own live connection, and the operational apps. */
export function SystemView({ live }: { live: LiveState }) {
  const h = live.health;
  const integrations = Object.entries(h?.provenance?.liveIntegrations ?? {});
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <JivaCard>
        <CardHeader title="Mode and data" icon="shield" subtitle={`API ${API_URL}`} />
        <dl className="mt-3 space-y-2 text-[13px]">
          <Row label="Mode">{h?.mode ?? 'unknown'} (demo personas only work in DEMO mode, and only from this machine)</Row>
          <Row label="Statement">{h?.provenance?.statement ?? '—'}</Row>
          <Row label="Routing provider">{h?.components?.mapping?.provider ?? '—'}{h?.components?.mapping?.synthetic ? ' (synthetic routes, labelled)' : ''}</Row>
          <Row label="Live connections">{h?.components?.realtime?.activeConnections ?? '—'}</Row>
          <Row label="Live integrations">
            {integrations.length ? integrations.map(([k, v]) => `${k}: ${v ? 'yes' : 'no'}`).join(' · ') : '—'}
          </Row>
        </dl>
      </JivaCard>
      <JivaCard>
        <CardHeader title="This portal's live connection" icon="activity" subtitle="Socket.IO, as the demo administrator (operational events only, never clinical content)" />
        <div className="mt-3 flex items-center gap-2">
          <ConnectionPill state={live.connection} />
          <span className="text-xs text-ink-600">Use the outage scenario or Controls → Faults to see it drop and recover.</span>
        </div>
      </JivaCard>
      <JivaCard className="lg:col-span-2">
        <CardHeader title="The operational apps" icon="eye" subtitle="Each opens in a new tab as a demo persona; they show the same server state the scenarios change" />
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {APPS.map((a) => (
            <li key={a.app} className="rounded-xl bg-surface p-3 ring-1 ring-inset ring-ink-200">
              <p className="text-sm font-semibold text-ink-900">{a.title}</p>
              <ul className="mt-1 space-y-1">
                {a.personas.map(([persona, label]) => (
                  <li key={persona}>
                    <a className="inline-flex items-center gap-1 text-[13px] font-semibold text-brand-800 underline-offset-2 hover:underline" href={jivaAppUrl(a.app, persona)} target="_blank" rel="noreferrer">
                      <Icon name="arrowRight" size={12} />
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </JivaCard>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-ink-500">{label}</dt>
      <dd className="text-ink-900">{children}</dd>
    </div>
  );
}
