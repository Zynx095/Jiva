import { useRef, useState } from 'react';
import {
  CardHeader,
  Icon,
  JivaButton,
  JivaCard,
  JivaModal,
  Spinner,
  cx,
  formatClockSeconds,
  jivaAppUrl,
  type JivaApp,
} from '@jiva/ui/src';
import { call, socket } from './api';
import { CaseStrip } from './CaseStrip';
import { DEMO, SCENARIOS, newContext, type Ctx, type Deps, type Scenario } from './workflows';
import type { LiveState } from './useLiveState';

type StepState = { state: 'pending' | 'running' | 'done' | 'failed'; detail?: string; at?: number };

const deps: Deps = {
  call: (persona, method, path, body) => call(persona, method, path, body),
  realtimeConnected: () => socket.connected,
};

const WATCH: Array<{ app: JivaApp; persona: string; label: string }> = [
  { app: 'ambulance', persona: DEMO.crew.persona, label: `Crew ${DEMO.crew.ambulanceId}` },
  { app: 'hospital', persona: 'demo-hosp-1', label: 'Hebbal coordinator' },
  { app: 'doctor', persona: DEMO.doctor.persona, label: DEMO.doctor.name },
  { app: 'patient', persona: DEMO.patient, label: `Patient ${DEMO.caseId}` },
  { app: 'management', persona: DEMO.management, label: 'Network coordination' },
];

/**
 * Scripted scenarios, run one step at a time or all at once. Each step is a real API call as the persona
 * shown next to it, followed by a read-back of the authoritative state; the step list shows the server's
 * answers, never an assumed outcome.
 */
export function ScenarioRunner({ live }: { live: LiveState }) {
  const [selected, setSelected] = useState<Scenario>(SCENARIOS[0]);
  const [states, setStates] = useState<StepState[]>(() => SCENARIOS[0].steps.map(() => ({ state: 'pending' })));
  const [running, setRunning] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const ctx = useRef<Ctx>(newContext());
  const stop = useRef(false);
  const next = states.findIndex((s) => s.state !== 'done');
  const failed = states.some((s) => s.state === 'failed');

  const choose = (s: Scenario) => {
    if (running) return;
    setSelected(s);
    setStates(s.steps.map(() => ({ state: 'pending' })));
    ctx.current = newContext();
  };

  const runOne = async (i: number): Promise<boolean> => {
    setStates((prev) => prev.map((s, j) => (j === i ? { state: 'running' } : s)));
    try {
      const detail = await selected.steps[i].run(ctx.current, deps);
      setStates((prev) => prev.map((s, j) => (j === i ? { state: 'done', detail, at: Date.now() } : s)));
      live.refresh();
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setStates((prev) => prev.map((s, j) => (j === i ? { state: 'failed', detail: detail.includes('fetch') ? 'Cannot reach the JIVA API.' : detail, at: Date.now() } : s)));
      live.refresh();
      return false;
    }
  };

  const runFrom = async (all: boolean) => {
    if (next < 0) return;
    setRunning(true);
    stop.current = false;
    for (let i = next; i < selected.steps.length; i++) {
      if (!(await runOne(i)) || !all || stop.current) break;
    }
    setRunning(false);
  };

  const start = (all: boolean) => {
    // A scenario that resets the demo asks first: everyone watching the demo sees the reset.
    if (next === 0 && selected.resets) setConfirmReset(true);
    else void runFrom(all);
  };
  const [pendingAll, setPendingAll] = useState(true);

  return (
    <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="space-y-2" aria-label="Scenarios">
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink-900">Scenarios</h2>
        <p className="text-xs text-ink-600">Each one drives the real workflows as the demo personas. Steps run only when you ask.</p>
        <ul className="space-y-1.5">
          {SCENARIOS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => choose(s)}
                aria-pressed={selected.id === s.id}
                disabled={running && selected.id !== s.id}
                className={cx('w-full rounded-xl bg-surface p-3 text-left ring-1 transition-shadow hover:shadow-sm disabled:opacity-50', selected.id === s.id ? 'ring-2 ring-brand-500 shadow-e3' : 'ring-ink-200 hover:ring-ink-300')}
              >
                <span className="block text-sm font-semibold text-ink-900">
                  {i + 1}. {s.title}
                </span>
                <span className="block text-xs text-ink-600">{s.steps.length} steps{s.resets ? ' · resets the demo' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="min-w-0 space-y-4">
        <CaseStrip live={live} />
        <JivaCard>
          <CardHeader title={selected.title} icon="activity" subtitle={selected.summary} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <JivaButton
              variant="primary"
              icon="arrowRight"
              disabled={running || next < 0}
              onClick={() => {
                setPendingAll(false);
                start(false);
              }}
            >
              {next === 0 ? 'Run first step' : 'Run next step'}
            </JivaButton>
            <JivaButton
              icon="activity"
              disabled={running || next < 0}
              onClick={() => {
                setPendingAll(true);
                start(true);
              }}
            >
              Run all remaining steps
            </JivaButton>
            {running && (
              <JivaButton variant="ghost" icon="x" onClick={() => (stop.current = true)}>
                Stop after this step
              </JivaButton>
            )}
            {!running && (next < 0 || failed) && (
              <JivaButton variant="ghost" icon="refresh" onClick={() => choose(selected)}>
                Start over
              </JivaButton>
            )}
            {next < 0 && <span className="text-sm font-semibold text-brand-800">✓ Scenario complete — every step confirmed by the server</span>}
          </div>
          <ol className="mt-4 space-y-2">
            {selected.steps.map((s, i) => {
              const st = states[i];
              return (
                <li key={`${s.id}-${i}`} className={cx('rounded-xl p-3 ring-1 ring-inset', st.state === 'failed' ? 'bg-danger-50/60 ring-danger-200' : st.state === 'done' ? 'bg-surface ring-brand-200' : 'bg-surface ring-ink-200')}>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 shrink-0">
                      {st.state === 'running' ? <Spinner size={18} className="text-brand-600" />
                        : st.state === 'done' ? <Icon name="checkCircle" size={18} className="text-brand-700" />
                          : st.state === 'failed' ? <Icon name="xCircle" size={18} className="text-danger-700" />
                            : <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-ink-100 text-[11px] font-bold text-ink-600">{i + 1}</span>}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink-900">{s.title}</p>
                      <p className="text-xs text-ink-600">{s.description}</p>
                      <p className="mt-1 text-[11px] font-semibold text-ink-600">
                        Acts as {s.actor} · persona {s.persona}
                      </p>
                      {st.detail && (
                        <p className={cx('mt-1 text-[13px]', st.state === 'failed' ? 'text-danger-700' : 'text-ink-800')}>
                          {st.at ? `${formatClockSeconds(st.at)} · ` : ''}
                          {st.detail}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </JivaCard>
        <JivaCard>
          <CardHeader title="Watch it in the operational apps" icon="eye" subtitle="Each opens in a new tab as the persona the scenario acts for" />
          <div className="mt-3 flex flex-wrap gap-2">
            {WATCH.map((w) => (
              <a key={w.app} href={jivaAppUrl(w.app, w.persona)} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-surface px-3 text-[13px] font-semibold text-ink-800 ring-1 ring-inset ring-ink-200 hover:bg-ink-50">
                <Icon name="arrowRight" size={13} />
                {w.label}
              </a>
            ))}
          </div>
        </JivaCard>
      </div>

      <JivaModal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset the demo?"
        icon="refresh"
        tone="warn"
        description="This scenario starts by clearing every demo case, encounter and record (synthetic data only). Everyone watching the demo sees the reset. Operational mode has no reset."
        actions={
          <>
            <JivaButton variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </JivaButton>
            <JivaButton
              variant="primary"
              icon="refresh"
              onClick={() => {
                setConfirmReset(false);
                void runFrom(pendingAll);
              }}
            >
              Reset and run
            </JivaButton>
          </>
        }
      />
    </div>
  );
}
