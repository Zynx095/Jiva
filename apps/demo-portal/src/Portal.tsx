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
    <div className="min-h-dvh bg-amber-50/40">
      <div aria-hidden="true" className="h-2 bg-[repeating-linear-gradient(135deg,#d97706_0_14px,#1f2937_14px_28px)]" />
      <header className="sticky top-0 z-30 border-b border-amber-300 bg-amber-100/95 backdrop-blur">
        <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <JivaLogo />
            <span className="hidden h-6 w-px bg-amber-300 sm:block" aria-hidden="true" />
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[15px] font-bold text-amber-950">Demonstration portal</div>
              <div className="truncate text-xs text-amber-900">Synthetic data only · not an operational interface</div>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-amber-900 px-2.5 text-xs font-bold uppercase tracking-wide text-amber-50">
              <Icon name="alertTriangle" size={13} /> Demo
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
                '-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold',
                view === n.id ? 'border-amber-700 text-amber-950' : 'border-transparent text-amber-900/70 hover:text-amber-950',
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
      <footer className="px-4 pb-8 text-center text-xs text-amber-900/80">
        Every action here is a real API call made as a demo persona and checked by the same rules as the operational apps. Everything shown is synthetic.
      </footer>
    </div>
  );
}
