import { useEffect, useState } from 'react';
import { AsyncButton, Icon, JivaButton, JivaModal, useToast, type IconName } from '@jiva/ui/src';
import { call, failure } from './api';
import { DEMO } from './workflows';
import type { LiveState } from './useLiveState';
import { RoleCards } from './RoleCards';

interface NetworkNow {
  emergencies: number;
  inCare: number;
  unitsOnJob: number;
}

/**
 * The portal's landing page: what JIVA is (and is not, in this demo), what is happening in the demo right
 * now, and a way into each role interface and the guided scenarios.
 */
export function Home({ live, onOpenScenarios }: { live: LiveState; onOpenScenarios: () => void }) {
  const h = live.health;
  const [now, setNow] = useState<NetworkNow | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([
      call<Array<{ currentStatus: string }>>(DEMO.management, 'GET', '/api/patients'),
      call<Array<{ status: string }>>(DEMO.management, 'GET', '/api/encounters'),
      call<Array<{ status: string }>>(DEMO.management, 'GET', '/api/ambulances'),
    ])
      .then(([p, e, a]) => {
        if (!alive) return;
        const pats = Array.isArray(p.body) ? p.body : [];
        const encs = Array.isArray(e.body) ? e.body : [];
        const ambs = Array.isArray(a.body) ? a.body : [];
        setNow({
          emergencies: pats.filter((x) => ['EMERGENCY_REPORTED', 'ASSESSED', 'IN_TRANSIT'].includes(x.currentStatus)).length,
          inCare: encs.filter((x) => x.status === 'IN_CARE').length,
          unitsOnJob: ambs.filter((x) => x.status !== 'AVAILABLE' && x.status !== 'UNAVAILABLE').length,
        });
      })
      .catch(() => alive && setNow(null));
    return () => {
      alive = false;
    };
  }, [live.version]);

  const routing = h?.components?.mapping;
  const ai = h?.components?.ai;
  const facts: Array<{ icon: IconName; label: string; tone: 'info' | 'warn' }> = [
    { icon: 'info', label: 'Demo mode — synthetic patients, hospitals and clinicians', tone: 'info' },
    { icon: 'activity', label: 'No hardware connected — vital signs are entered manually or simulated (labelled)', tone: 'warn' },
    { icon: 'navigation', label: 'No GPS — ambulance positions are set by the crew or simulated', tone: 'warn' },
    {
      icon: 'route',
      label:
        routing?.synthetic || routing?.provider === 'mock'
          ? 'Routes are synthetic (mock provider, no live traffic)'
          : routing?.provider === 'none-yet' || !routing?.provider
            ? 'No route computed yet — without a routing server, routes are synthetic'
            : `Routing: ${routing.provider}`,
      tone: 'info',
    },
    { icon: 'brief', label: ai?.generator === 'LLM' ? 'Summaries by an AI service (advisory)' : 'Summaries are template text — no AI service connected', tone: 'info' },
    { icon: 'database', label: 'Kept in memory — an API restart clears the demo', tone: 'info' },
  ];

  return (
    <div className="space-y-10">
      <section aria-labelledby="hero-title" className="relative overflow-hidden rounded-3xl bg-surface px-6 py-10 ring-1 ring-ink-200 sm:px-10 sm:py-14">
        {/* A single, quiet glow behind the title — the only decorative element on the page. */}
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full opacity-25 blur-3xl jiva-gradient-brand" />
        <p className="text-sm font-semibold text-brand-700">Demonstration portal</p>
        <h2 id="hero-title" className="mt-2 text-5xl font-bold tracking-[-0.03em] text-ink-950 sm:text-6xl">
          JIVA
        </h2>
        <p className="mt-1 bg-clip-text text-2xl font-semibold tracking-[-0.015em] text-transparent jiva-gradient-brand sm:text-3xl">Real-time healthcare coordination</p>
        <p className="mt-4 max-w-3xl text-[15px] leading-7 text-ink-700">
          JIVA connects ambulance crews, hospital emergency departments, doctors and patients around each emergency. The crew reports from the scene, each capable
          hospital answers its own referral, the ambulance is routed only to a hospital that accepted, and the receiving team records the arrival, the handover and
          the care. This portal runs the real software — the same API, rules and permissions — with synthetic data.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={onOpenScenarios} className="inline-flex h-12 items-center gap-2 rounded-xl px-5 text-[15px] font-semibold jiva-fill-primary shadow-e3 transition-transform duration-150 active:scale-[0.98] hover:jiva-fill-primary-hover">
            <Icon name="activity" size={18} />
            Start a guided demo
          </button>
          <a href="#roles" className="inline-flex h-12 items-center gap-2 rounded-xl bg-surface-raised px-5 text-[15px] font-semibold text-ink-900 ring-1 ring-inset ring-ink-300 transition-colors duration-150 hover:ring-ink-400">
            <Icon name="users" size={18} />
            Open a role interface
          </a>
        </div>
        <ul className="mt-8 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-label="What is real and what is simulated in this demo">
          {facts.map((f) => (
            <li key={f.label} className={f.tone === 'warn' ? 'flex items-start gap-2 rounded-xl bg-warn-50 px-3 py-2 text-[13px] text-warn-800 ring-1 ring-inset ring-warn-200' : 'flex items-start gap-2 rounded-xl bg-info-50 px-3 py-2 text-[13px] text-info-800 ring-1 ring-inset ring-info-200'}>
              <Icon name={f.icon} size={15} className="mt-0.5 shrink-0" />
              {f.label}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="now-title" className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-2xl bg-surface px-6 py-4 ring-1 ring-ink-200">
        <h2 id="now-title" className="text-sm font-semibold text-ink-700">
          In the demo right now
        </h2>
        {now ? (
          <dl className="flex flex-wrap gap-x-8 gap-y-2">
            <Stat label="Active emergencies" value={now.emergencies} />
            <Stat label="Patients in hospital care" value={now.inCare} />
            <Stat label="Ambulances on a job" value={now.unitsOnJob} />
          </dl>
        ) : (
          <p className="text-[13px] text-ink-500">Counts unavailable — the API did not answer.</p>
        )}
        <p className="text-xs text-ink-500 sm:ml-auto">From the live API state · synthetic data</p>
      </section>

      <section id="roles" aria-labelledby="roles-title" className="scroll-mt-28 space-y-4">
        <div>
          <h2 id="roles-title" className="text-2xl font-semibold tracking-[-0.015em] text-ink-900">
            Open a role interface
          </h2>
          <p className="mt-1 text-[15px] text-ink-600">Each interface opens as a demo persona. Every screen has a link back to this portal.</p>
        </div>
        <RoleCards onOpenScenarios={onOpenScenarios} />
      </section>

      <ResetDemo onDone={live.refresh} />
    </div>
  );
}

/**
 * Clear all demo data (demo administrator, demo mode only). Destructive for everyone watching the demo, so
 * it says exactly what is cleared and asks for an explicit confirmation first.
 */
function ResetDemo({ onDone }: { onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const toast = useToast();
  return (
    <section aria-labelledby="reset-title" className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-surface px-6 py-5 ring-1 ring-ink-200">
      <div className="min-w-0 max-w-2xl">
        <h2 id="reset-title" className="text-base font-semibold text-ink-900">
          Reset the demo data
        </h2>
        <p className="mt-1 text-[13px] leading-6 text-ink-600">
          Clears every demo case, encounter, vital sign, prescription, note, report and document, and re-seeds the synthetic hospitals, ambulances and clinicians.
          It affects everyone using this demo. Only possible in demo mode.
        </p>
      </div>
      <JivaButton variant="danger-soft" icon="refresh" onClick={() => setAsking(true)}>
        Reset demo data…
      </JivaButton>
      <JivaModal
        open={asking}
        onClose={() => setAsking(false)}
        title="Reset all demo data?"
        icon="alertTriangle"
        tone="danger"
        description="Every demo case, encounter and clinical record is deleted for everyone using this demo, and the synthetic network is re-seeded. This cannot be undone."
        actions={
          <>
            <JivaButton variant="ghost" autoFocus onClick={() => setAsking(false)}>
              Keep the data
            </JivaButton>
            <AsyncButton
              variant="danger"
              icon="refresh"
              pendingText="Resetting…"
              onAction={async () => {
                const r = await call('demo-admin', 'POST', '/api/demo/reset').catch(() => null);
                if (!r) return 'Cannot reach the JIVA API.';
                if (!r.ok) return failure(r);
                setAsking(false);
                onDone();
                toast.show({ title: 'Demo data reset', description: 'All demo records were cleared and the synthetic network re-seeded.', tone: 'ok', icon: 'refresh', groupKey: 'reset' });
                return null;
              }}
            >
              Reset demo data
            </AsyncButton>
          </>
        }
      />
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <dd className="text-2xl font-semibold tabular-nums text-ink-950">{value}</dd>
      <dt className="text-[13px] text-ink-600">{label}</dt>
    </div>
  );
}
