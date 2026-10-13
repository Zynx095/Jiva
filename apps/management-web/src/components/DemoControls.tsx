import { useState, type ReactNode } from 'react';
import { AsyncButton, Icon, type ActionResult } from '@jiva/ui/src';
import { DemoSimulator } from '../lib/simulator';

const STORAGE_KEY = 'jiva.mgmt.demoControls.open';
const readOpen = () => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
};

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-xs font-semibold text-warn-900/80">{title}</span>
      {children}
    </div>
  );
}

/**
 * Demo controls. Each one acts AS THE REAL ACTOR (demo persona) through the normal event API,
 * so it passes the same validation and authorization as any client — nothing here fabricates
 * routing, destinations or AI output. Labels match docs/demo-runbook.md.
 */
export function DemoControls({ advanceAmbulance }: { advanceAmbulance: () => Promise<ActionResult> }) {
  const [open, setOpen] = useState(readOpen);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setOpen((v) => {
      try {
        window.localStorage.setItem(STORAGE_KEY, String(!v));
      } catch {
        /* per-viewer convenience only */
      }
      return !v;
    });
  };

  return (
    <section aria-labelledby="demo-controls-title" className="border-t border-warn-200 bg-warn-50/70 px-4 py-2">
      <div className="flex items-center gap-2">
        <Icon name="info" size={15} className="shrink-0 text-warn-700" />
        <h2 id="demo-controls-title" className="text-[13px] font-semibold text-warn-900">
          Demo controls
        </h2>
        <span className="hidden truncate text-xs text-warn-800 md:inline">Each button acts as the real actor through the event API · synthetic data</span>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls="demo-controls-body"
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-warn-900 hover:bg-warn-100"
        >
          {open ? 'Hide' : 'Show'}
          <Icon name={open ? 'chevronDown' : 'chevronUp'} size={14} />
        </button>
      </div>
      {open && (
        <div id="demo-controls-body" className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-2 pb-1">
          <Group title="Scenario">
            <AsyncButton size="sm" icon="refresh" onAction={DemoSimulator.resetScenario} pendingText="Resetting…" onSettled={setError}>
              Reset demo
            </AsyncButton>
            <AsyncButton size="sm" variant="primary" icon="siren" onAction={DemoSimulator.startEmergency} pendingText="Reporting…" onSettled={setError}>
              Report emergency + dispatch
            </AsyncButton>
          </Group>
          <Group title="Hospital answers">
            <AsyncButton size="sm" variant="ok-soft" icon="checkCircle" onAction={() => DemoSimulator.accept('HOSP-BLR-001')} onSettled={setError}>
              Hebbal (001) accepts
            </AsyncButton>
            <AsyncButton size="sm" variant="ok-soft" icon="checkCircle" onAction={() => DemoSimulator.accept('HOSP-BLR-004')} onSettled={setError}>
              Indiranagar (004) accepts
            </AsyncButton>
            <AsyncButton size="sm" variant="warn-soft" icon="half" onAction={() => DemoSimulator.limited('HOSP-BLR-002')} onSettled={setError}>
              Whitefield (002) limited
            </AsyncButton>
            <AsyncButton size="sm" variant="danger-soft" icon="xCircle" onAction={() => DemoSimulator.reject('HOSP-BLR-002')} onSettled={setError}>
              Whitefield (002) rejects
            </AsyncButton>
          </Group>
          <Group title="Disruption">
            <AsyncButton size="sm" variant="danger-soft" icon="ban" onAction={() => DemoSimulator.hospitalUnavailable('HOSP-BLR-001')} onSettled={setError}>
              Hebbal (001) ED unavailable
            </AsyncButton>
          </Group>
          <Group title="Simulated position">
            <AsyncButton size="sm" icon="navigation" onAction={advanceAmbulance} onSettled={setError}>
              Advance ambulance (simulated)
            </AsyncButton>
          </Group>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 flex items-center gap-1.5 text-[13px] text-danger-700">
          <Icon name="alertCircle" size={14} />
          Control rejected by API: {error}
        </p>
      )}
    </section>
  );
}
