import { useState } from 'react';
import { Icon, jivaAppUrl } from '@jiva/ui/src';
import { ROLES, type RoleEntry } from './roles';

/**
 * One card per role interface, plus the guided scenarios. A card says what the role does and sees, lets
 * the presenter pick the demo persona, and opens the interface as that persona (in this tab, or a new one).
 */
export function RoleCards({ onOpenScenarios }: { onOpenScenarios: () => void }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {ROLES.map((r) => (
        <li key={r.app}>
          <RoleCard role={r} />
        </li>
      ))}
      <li>
        <article aria-labelledby="role-guided" className="group flex h-full flex-col rounded-2xl bg-surface p-5 ring-1 ring-ink-200 transition-shadow duration-200 hover:shadow-e3">
          <Header icon="activity" title="Guided demos" id="role-guided" />
          <p className="mt-3 text-[14px] leading-6 text-ink-700">
            Run predefined scenarios step by step — acceptance, rejection and rerouting, expiry, arrival and handover, doctor assignment, prescriptions, a realtime
            outage — and watch every role react.
          </p>
          <p className="mt-2 flex items-start gap-1.5 text-[13px] text-ink-500">
            <Icon name="shield" size={14} className="mt-0.5 shrink-0" />
            Each step is a real API call as the persona shown; resetting scenarios ask first.
          </p>
          <div className="mt-auto pt-5">
            <button type="button" onClick={onOpenScenarios} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold jiva-fill-primary transition-transform duration-150 active:scale-[0.98] hover:jiva-fill-primary-hover">
              Choose a scenario
              <Icon name="arrowRight" size={16} />
            </button>
          </div>
        </article>
      </li>
    </ul>
  );
}

function Header({ icon, title, id }: { icon: RoleEntry['icon']; title: string; id: string }) {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-surface-raised text-brand-700 ring-1 ring-inset ring-brand-200">
        <Icon name={icon} size={20} />
      </span>
      <h3 id={id} className="text-lg font-semibold tracking-[-0.01em] text-ink-950">
        {title}
      </h3>
    </div>
  );
}

function RoleCard({ role }: { role: RoleEntry }) {
  const [persona, setPersona] = useState(role.personas[0].value);
  const chosen = role.personas.find((p) => p.value === persona) ?? role.personas[0];
  const href = jivaAppUrl(role.app, persona);
  const id = `role-${role.app}`;
  return (
    <article aria-labelledby={id} className="group flex h-full flex-col rounded-2xl bg-surface p-5 ring-1 ring-ink-200 transition-shadow duration-200 hover:shadow-e3">
      <Header icon={role.icon} title={role.title} id={id} />
      <p className="mt-3 text-[14px] leading-6 text-ink-700">{role.does}</p>
      <p className="mt-2 flex items-start gap-1.5 text-[13px] text-ink-500">
        <Icon name="shield" size={14} className="mt-0.5 shrink-0" />
        {role.sees}
      </p>
      <div className="mt-auto space-y-2 pt-5">
        {role.personas.length > 1 ? (
          <label className="block">
            <span className="text-xs font-semibold text-ink-600">Demo persona</span>
            <select
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              className="mt-1 h-10 w-full rounded-lg bg-surface-raised px-3 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-600"
            >
              {role.personas.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-xs text-ink-600">
            Demo persona: <span className="font-semibold text-ink-800">{chosen.label}</span>
          </p>
        )}
        {chosen.note && <p className="text-xs text-ink-500">{chosen.note}</p>}
        <div className="flex gap-2">
          <a href={href} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-semibold jiva-fill-primary transition-transform duration-150 active:scale-[0.98] hover:jiva-fill-primary-hover">
            Open {role.title.toLowerCase()} interface
            <Icon name="arrowRight" size={16} />
          </a>
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open the ${role.title.toLowerCase()} interface as ${chosen.label} in a new tab`}
            title="Open in a new tab"
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-surface-raised text-ink-700 ring-1 ring-inset ring-ink-300 transition-colors duration-150 hover:text-ink-950 hover:ring-ink-400"
          >
            <Icon name="maximize" size={16} />
          </a>
        </div>
      </div>
    </article>
  );
}
