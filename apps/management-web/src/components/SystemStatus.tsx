import { useEffect, useState } from 'react';
import { DataRow, Icon, JivaDrawer, JivaStatus, SectionLabel, StatusDot, TechnicalDetails, cx, timeAgo, type StatusMeta } from '@jiva/ui/src';
import { apiGet } from '../api';
import type { Health, ProvenanceReport } from '../types';

interface ShadowSummary {
  mode: string;
  policy?: { version?: string; hash?: string; label?: string; evidenceEnvironment?: string };
  authority?: {
    mode?: string;
    killSwitch?: boolean;
    circuitBreaker?: string;
    metrics?: { evaluationsTotal?: number; agreedCount?: number; disagreedCount?: number; fallbacksTriggered?: number };
  };
  failures?: unknown[];
}

const ok = (label: string): StatusMeta => ({ label, tone: 'ok', icon: 'checkCircle' });
const warn = (label: string): StatusMeta => ({ label, tone: 'warn', icon: 'info' });
const bad = (label: string): StatusMeta => ({ label, tone: 'danger', icon: 'alertCircle' });

/** One summary pill in the header; everything else lives in the drawer (progressive disclosure). */
export function SystemStatus({ health }: { health: Health | null }) {
  const [open, setOpen] = useState(false);
  const [shadow, setShadow] = useState<ShadowSummary | null>(null);
  const [shadowError, setShadowError] = useState(false);

  useEffect(() => {
    if (!open) return;
    apiGet<ShadowSummary>('/api/feasibility/shadow')
      .then((s) => {
        setShadow(s);
        setShadowError(false);
      })
      .catch(() => setShadowError(true));
  }, [open]);

  const c = health?.components;
  const healthy = health?.status === 'HEALTHY';
  const mapping = c?.mapping;
  const mappingProvider = mapping?.activeProvider ?? mapping?.provider;
  const noRouteYet = !mappingProvider || mappingProvider === 'none-yet';

  const rows: Array<{ label: string; value: string; meta: StatusMeta; note?: string }> = health
    ? [
        {
          label: 'Event bus',
          value: c?.eventBus?.provider === 'AwsEventBridgeBus' ? 'Amazon EventBridge' : 'Local event bus',
          meta: c?.eventBus?.status === 'HEALTHY' ? ok('Healthy') : bad('Unavailable'),
        },
        {
          label: 'State store',
          value: c?.database?.provider === 'DynamoStateStore' ? 'DynamoDB' : 'Local in-memory store',
          meta: c?.database?.status === 'HEALTHY' ? ok('Healthy') : bad('Unavailable'),
        },
        {
          label: 'Realtime',
          value: `Socket.IO · ${c?.realtime?.activeConnections ?? 0} connected screens`,
          meta: c?.realtime?.status === 'CONNECTED' ? ok('Connected') : bad('Disconnected'),
        },
        {
          label: 'Routing',
          value: noRouteYet ? `No route computed yet · chain ${(mapping?.chain ?? []).join(' → ')}` : `${String(mappingProvider).toUpperCase()}${mapping?.synthetic ? ' — synthetic, not road-network' : ''}`,
          meta: noRouteYet ? { label: 'Idle', tone: 'neutral', icon: 'help' } : mapping?.synthetic ? warn('Synthetic') : ok('Road network'),
          note: mapping?.lastFallbackReason ? `Last fallback: ${mapping.lastFallbackReason}` : undefined,
        },
        {
          label: 'AI sidecar',
          value: `${c?.ai?.provider === 'BedrockAIProvider' ? 'Amazon Bedrock' : 'Mock templates'} · advisory only${c?.ai?.failures ? ` · ${c.ai.failures} failures` : ''}`,
          meta: c?.ai?.provider === 'BedrockAIProvider' ? ok('Live model') : warn('Mock'),
        },
        {
          label: 'Infrastructure',
          value: health.environment === 'aws-demo' ? 'AWS mesh' : 'Local demo (not deployed)',
          meta: health.environment === 'aws-demo' ? ok('AWS') : warn('Local'),
        },
        health.demoAuth === false
          ? { label: 'Sign-in', value: 'Cognito (JWT)', meta: ok('Production auth') }
          : { label: 'Sign-in', value: 'Demo personas — not production authentication', meta: warn('Demo auth') },
      ]
    : [];

  const summary = !health ? 'Status unknown' : healthy ? 'Systems normal' : 'Degraded';
  const tone = !health ? 'neutral' : healthy ? 'ok' : 'danger';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx(
          'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold ring-1 ring-inset transition-colors',
          tone === 'ok' ? 'bg-white text-ink-800 ring-ink-200 hover:bg-ink-50' : tone === 'danger' ? 'bg-danger-50 text-danger-700 ring-danger-200' : 'bg-ink-50 text-ink-700 ring-ink-200',
        )}
        aria-haspopup="dialog"
      >
        <StatusDot tone={tone} />
        {summary}
        <Icon name="chevronDown" size={13} className="text-ink-500" />
      </button>

      <JivaDrawer open={open} onClose={() => setOpen(false)} title="System status" subtitle={health ? `Checked ${timeAgo(health.timestamp)} · refreshes every 5 s` : 'The API did not answer the last health check'}>
        <div className="space-y-6">
          <section className="space-y-2">
            <SectionLabel>Components</SectionLabel>
            {rows.length === 0 ? (
              <p className="text-sm text-danger-700">The JIVA API is not reachable. Screens keep showing the last known state.</p>
            ) : (
              <ul className="divide-y divide-ink-100 rounded-xl ring-1 ring-ink-200">
                {rows.map((r) => (
                  <li key={r.label} className="flex items-start justify-between gap-3 px-3.5 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-ink-900">{r.label}</p>
                      <p className="text-xs text-ink-600">{r.value}</p>
                      {r.note && <p className="mt-0.5 text-xs text-warn-700">{r.note}</p>}
                    </div>
                    <JivaStatus meta={r.meta} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {health?.provenance && <DataProvenance p={health.provenance} />}

          <section className="space-y-2">
            <SectionLabel>Decision authority</SectionLabel>
            {shadowError ? (
              <p className="text-sm text-ink-600">Could not load the feasibility engine status.</p>
            ) : !shadow ? (
              <p className="text-sm text-ink-500">Loading…</p>
            ) : (
              <div className="space-y-2 rounded-xl px-3.5 py-3 ring-1 ring-ink-200">
                <p className="text-[13px] text-ink-800">
                  <span className="font-semibold">Legacy rules make every routing decision.</span> The Care Feasibility Engine runs in{' '}
                  <span className="font-semibold">{(shadow.authority?.mode ?? shadow.mode).toLowerCase()}</span> mode: it observes and is compared, but has no authority.
                </p>
                <dl className="divide-y divide-ink-100">
                  <DataRow label="Agreement">
                    {shadow.authority?.metrics?.evaluationsTotal
                      ? `${shadow.authority.metrics.agreedCount ?? 0} of ${shadow.authority.metrics.evaluationsTotal} evaluations agree`
                      : 'No evaluations yet'}
                  </DataRow>
                  <DataRow label="Kill switch">{shadow.authority?.killSwitch ? 'Active' : 'Off'}</DataRow>
                  <DataRow label="Circuit breaker">{shadow.authority?.circuitBreaker ?? '—'}</DataRow>
                  <DataRow label="Shadow failures">{shadow.failures?.length ?? 0}</DataRow>
                </dl>
                <TechnicalDetails
                  summary="Policy & hashes"
                  fields={[
                    ['Policy', shadow.policy?.label],
                    ['Version', shadow.policy?.version],
                    ['Policy hash', shadow.policy?.hash],
                    ['Evidence env', shadow.policy?.evidenceEnvironment],
                  ]}
                />
              </div>
            )}
          </section>
        </div>
      </JivaDrawer>
    </>
  );
}

const INTEGRATION_TEXT: Record<string, string> = {
  hospitalCapacityFeeds: 'Hospital capacity feeds',
  hospitalStaffDirectory: 'Hospital staff directory',
  medicalDevices: 'Medical devices',
  ambulanceGps: 'Ambulance GPS',
  documentObjectStorage: 'Production document storage',
};

/** Mode and provenance: what is synthetic, what is public, and which live integrations exist (none). */
function DataProvenance({ p }: { p: ProvenanceReport }) {
  const n = p.datasets.network;
  return (
    <section className="space-y-2">
      <SectionLabel>Mode and data</SectionLabel>
      <div className="space-y-2 rounded-xl px-3.5 py-3 ring-1 ring-ink-200">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-semibold text-ink-900">{p.mode === 'DEMO' ? 'Demo mode' : 'Operational mode'}</p>
          <JivaStatus meta={p.mode === 'DEMO' ? warn('Synthetic data') : ok('Operational')} />
        </div>
        <p className="text-xs text-ink-600">{p.statement}</p>
        <dl className="divide-y divide-ink-100">
          <DataRow label="Network">
            {n.hospitals} hospitals ({n.syntheticHospitals} synthetic) · {n.ambulances} ambulances ({n.syntheticAmbulances} synthetic)
          </DataRow>
          <DataRow label="Directory">Public listings · not connected to JIVA</DataRow>
          <DataRow label="Clinicians">{p.datasets.clinicians.count ? `${p.datasets.clinicians.count} · ${p.datasets.clinicians.dataStatus === 'SYNTHETIC_DEMO' ? 'synthetic roster' : p.datasets.clinicians.dataStatus}` : 'None loaded'}</DataRow>
          <DataRow label="Vital signs">{p.providers.telemetry.simulator ? 'Entered by care team and crew + labelled simulator' : 'Entered by care team and crew'} · no medical devices</DataRow>
          {p.providers.positions && (
            <DataRow label="Ambulance positions">{p.providers.positions.simulator ? 'Set by the crew + labelled simulator' : 'Set by the crew'} · no GPS feed</DataRow>
          )}
        </dl>
        <ul className="flex flex-wrap gap-1.5 pt-1">
          {Object.entries(p.liveIntegrations).map(([k, v]) => (
            <li key={k}>
              <JivaStatus meta={v ? ok(INTEGRATION_TEXT[k] ?? k) : { label: `${INTEGRATION_TEXT[k] ?? k}: not integrated`, tone: 'neutral', icon: 'minus' }} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
