import { useEffect, useState } from 'react';
import { ConnectionPill, EmptyState, Icon, JivaCard, JivaLogo, JivaSkeleton, cx, type IconName } from '@jiva/ui/src';
import { AssetLibrary } from './AssetLibrary';
import { Controls } from './Controls';
import { ScenarioRunner } from './ScenarioRunner';
import { SystemView } from './SystemView';
import { TimelineView } from './TimelineView';
import { useLiveState } from './useLiveState';

type View = 'scenarios' | 'controls' | 'timeline' | 'assets' | 'system';

const NAV: Array<{ id: View; label: string; icon: IconName; hint: string }> = [
  { id: 'scenarios', label: 'Scenarios', icon: 'activity', hint: 'Run scripted journeys step by step' },
  { id: 'controls', label: 'Controls', icon: 'panel', hint: 'Drive the demo case by hand' },
  { id: 'timeline', label: 'Timeline', icon: 'clock', hint: 'What was actually recorded' },
  { id: 'assets', label: 'Asset library', icon: 'layers', hint: 'Synthetic sample documents' },
  { id: 'system', label: 'System', icon: 'gauge', hint: 'Mode, connections, the other apps' },
];

const readView = (): View => {
  const v = new URLSearchParams(window.location.search).get('view');
  return NAV.some((n) => n.id === v) ? (v as View) : 'scenarios';
};

/**
 * The demonstration portal: its own app, layout and navigation, visually set apart from every operational
 * interface. It drives the real backend workflows as the demo personas would and shows what the server
 * recorded. It refuses to run against an API in operational mode, and the API only serves demo personas to
 * this machine.
 */
export default function Portal() {
  const live = useLiveState();
  const [view, setView] = useState<View>(readView);
  useEffect(() => {
    document.title = 'JIVA · Demo portal';
  }, []);
  const go = (v: View) => {
    setView(v);
    const url = new URL(window.location.href);
    url.searchParams.set('view', v);
    window.history.replaceState(null, '', url.toString());
  };

  return (
    <div className="min-h-dvh bg-canvas">
      {/* A quiet but unmistakable edge: this is the demonstration portal, not an operational screen. */}
      <div aria-hidden="true" className="h-1.5 bg-[repeating-linear-gradient(135deg,var(--color-warn-400)_0_12px,var(--color-warn-100)_12px_24px)]" />
      <header className="sticky top-0 z-30 border-b border-warn-200 bg-warn-50">
        <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <JivaLogo />
            <span className="hidden h-6 w-px bg-warn-200 sm:block" aria-hidden="true" />
            <div className="min-w-0 leading-tight">
              <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink-900">Demonstration portal</h1>
              <div className="truncate text-xs text-warn-800">Synthetic data only · not an operational interface</div>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-warn-700 px-2.5 text-xs font-semibold text-white">
              <Icon name="info" size={13} /> Demo mode · synthetic data
            </span>
            <ConnectionPill state={live.connection} />
          </div>
        </div>
        <nav aria-label="Demo portal" className="jiva-scroll flex gap-1 overflow-x-auto overflow-y-hidden px-3 lg:px-5">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              aria-current={view === n.id ? 'page' : undefined}
              title={n.hint}
              onClick={() => go(n.id)}
              className={cx(
                '-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold transition-colors duration-150',
                view === n.id ? 'border-warn-700 text-ink-900' : 'border-transparent text-ink-600 hover:border-warn-300 hover:text-ink-900',
              )}
            >
              <Icon name={n.icon} size={15} />
              {n.label}
            </button>
          ))}
        </nav>
      </header>

      <main id="main" className="mx-auto max-w-[1400px] px-4 py-6 lg:px-6">
        {live.apiReachable === null ? (
          <div className="space-y-3">
            <JivaSkeleton className="h-6 w-1/3" />
            <JivaSkeleton className="h-4 w-1/2" />
          </div>
        ) : live.apiReachable === false && !live.health ? (
          <JivaCard>
            <EmptyState icon="wifiOff" title="Cannot reach the JIVA API" description="Start it with npm run dev (or npm run dev:api). The portal retries automatically." />
          </JivaCard>
        ) : live.health?.mode !== 'DEMO' ? (
          <JivaCard accent="danger">
            <EmptyState
              icon="shield"
              title="The demo portal is disabled"
              description="This JIVA API runs in operational mode. Demo personas, synthetic samples, scenario resets and fault injection do not exist there, so nothing in this portal can run — by design."
            />
          </JivaCard>
        ) : (
          <>
            {live.apiReachable === false && (
              <div role="alert" className="mb-4 flex items-center gap-2 rounded-xl bg-danger-50 px-4 py-2 text-sm text-danger-700 ring-1 ring-inset ring-danger-200">
                <Icon name="wifiOff" size={16} />
                The JIVA API stopped answering. The portal keeps the last known state and retries automatically.
              </div>
            )}
            {view === 'scenarios' && <ScenarioRunner live={live} />}
            {view === 'controls' && <Controls live={live} />}
            {view === 'timeline' && <TimelineView live={live} />}
            {view === 'assets' && <AssetLibrary live={live} />}
            {view === 'system' && <SystemView live={live} />}
          </>
        )}
      </main>
      <footer className="px-4 pb-8 text-center text-xs text-ink-500">
        Every action here is a real API call made as a demo persona and checked by the same rules as the operational apps. Everything shown is synthetic.
      </footer>
    </div>
  );
}
