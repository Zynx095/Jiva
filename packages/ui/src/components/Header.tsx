import React from 'react';
import { useRuntimeMode } from '../lib/mode';
import { cx } from '../lib/cx';
import { timeAgo, useNow } from '../lib/time';
import { Spinner } from './Button';
import { Icon } from './Icon';
import { StatusDot } from './Status';

/** The JIVA mark: a live pulse in a rounded green square. */
export function JivaLogo({ size = 30, withWordmark = true, className }: { size?: number; withWordmark?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <rect width="32" height="32" rx="9" fill="var(--color-brand-700)" />
        <path d="M6.5 17h4.2l2.6-6.2 4.6 11.4 2.6-5.2h5" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {withWordmark && <span className="text-[17px] font-bold tracking-[0.06em] text-ink-900">JIVA</span>}
    </span>
  );
}

export interface AppHeaderProps {
  /** Product area, e.g. "Command Center". */
  app: string;
  /** Who/where, e.g. "Bengaluru network". */
  context?: React.ReactNode;
  /** Usually global search. */
  center?: React.ReactNode;
  actions?: React.ReactNode;
  /** Id of the main landmark for the skip link. */
  mainId?: string;
}

export function AppHeader({ app, context, center, actions, mainId = 'main' }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-ink-200 bg-white">
      <a
        href={`#${mainId}`}
        className="sr-only z-50 rounded-lg bg-brand-700 px-3 py-2 text-sm font-semibold text-white focus:not-sr-only focus:absolute focus:left-3 focus:top-2"
      >
        Skip to content
      </a>
      <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <JivaLogo />
          <span className="hidden h-6 w-px bg-ink-200 sm:block" aria-hidden="true" />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[15px] font-semibold text-ink-900">{app}</div>
            {context && <div className="truncate text-xs text-ink-500">{context}</div>}
          </div>
        </div>
        {center && <div className="order-last w-full md:order-none md:mx-auto md:w-auto md:max-w-md md:flex-1">{center}</div>}
        {actions && <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
    </header>
  );
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Realtime link state, kept subtle when healthy and explicit when not. */
export function ConnectionPill({ state, lastSync, className }: { state: ConnectionState; lastSync?: number | null; className?: string }) {
  const now = useNow(5000);
  const synced = lastSync ? `Last update ${timeAgo(lastSync, now)}` : undefined;
  const view = {
    live: { text: 'Live', cls: 'bg-brand-50 text-brand-800 ring-brand-200' },
    connecting: { text: 'Connecting…', cls: 'bg-ink-50 text-ink-700 ring-ink-200' },
    reconnecting: { text: 'Reconnecting…', cls: 'bg-warn-50 text-warn-800 ring-warn-200' },
    offline: { text: 'Offline — showing last known data', cls: 'bg-danger-50 text-danger-700 ring-danger-200' },
  }[state];
  return (
    <span
      role="status"
      title={synced}
      className={cx('inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-semibold ring-1 ring-inset', view.cls, className)}
    >
      {state === 'live' ? <StatusDot tone="ok" pulse /> : state === 'offline' ? <Icon name="wifiOff" size={13} /> : <Spinner size={12} />}
      {view.text}
    </span>
  );
}

/** Persistent honesty marker: this screen shows synthetic / simulated data. */
export function DemoBadge({ detail = 'Synthetic hospitals, simulated responses and mock routes. Not real capacity.', className }: { detail?: string; className?: string }) {
  return (
    <span
      title={detail}
      className={cx('inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full bg-warn-50 px-2.5 text-xs font-semibold text-warn-800 ring-1 ring-inset ring-warn-200', className)}
    >
      <Icon name="info" size={13} strokeWidth={2} />
      Demo data
      <span className="sr-only">: {detail}</span>
    </span>
  );
}

/**
 * The demo label, driven by the server's mode: shown in DEMO mode and while the mode is not yet known
 * (a screen never claims operational data before the server confirms it); hidden in OPERATIONAL mode.
 */
export function ModeBadge({ apiUrl, detail, className }: { apiUrl: string; detail?: string; className?: string }) {
  const mode = useRuntimeMode(apiUrl);
  if (mode === 'OPERATIONAL') return null;
  return <DemoBadge detail={detail} className={className} />;
}

export interface PersonaOption {
  value: string;
  label: string;
}

/** DEMO ONLY: switch the persona this screen acts as (reloads with ?as=…). */
export function PersonaSelect({ value, options, className }: { value: string; options: PersonaOption[]; className?: string }) {
  return (
    <label className={cx('inline-flex h-7 items-center gap-1.5 rounded-full bg-white pl-2.5 pr-1 text-xs font-semibold text-ink-700 ring-1 ring-inset ring-ink-200', className)}>
      <Icon name="user" size={13} />
      <span className="sr-only">Demo persona</span>
      <select
        value={value}
        onChange={(e) => {
          const url = new URL(window.location.href);
          url.searchParams.set('as', e.target.value);
          window.location.assign(url.toString());
        }}
        className="h-6 cursor-pointer rounded-full bg-transparent pr-1 text-xs font-semibold text-ink-800 outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
