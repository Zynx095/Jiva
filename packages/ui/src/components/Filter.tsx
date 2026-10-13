import type { ReactNode } from 'react';
import { cx } from '../lib/cx';
import { TONE_STYLES, type Tone } from '../lib/status';
import { Icon, type IconName } from './Icon';

export interface FilterOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  tone?: Tone;
  icon?: IconName;
}

export interface JivaFilterProps<T extends string> {
  /** Accessible name of the group, e.g. "Hospital status". */
  label: string;
  options: FilterOption<T>[];
  /** Selected values; empty means "All". */
  value: T[];
  onChange: (next: T[]) => void;
  multiple?: boolean;
  allLabel?: string;
  size?: 'sm' | 'md';
  className?: string;
}

const chip = (active: boolean, size: 'sm' | 'md') =>
  cx(
    'inline-flex shrink-0 items-center gap-1.5 rounded-full font-semibold transition-[background-color,color,box-shadow] duration-150 active:scale-[0.97]',
    size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
    active ? 'jiva-fill-inverse shadow-xs' : 'bg-surface text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 hover:ring-ink-300',
  );

/** Instant filter chips. "All" clears; the active count and a clear action appear once something is selected. */
export function JivaFilter<T extends string>({ label, options, value, onChange, multiple = true, allLabel = 'All', size = 'sm', className }: JivaFilterProps<T>) {
  const toggle = (v: T) => {
    if (!multiple) return onChange(value[0] === v ? [] : [v]);
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  return (
    <div role="group" aria-label={label} className={cx('flex items-center gap-1.5', className)}>
      <button type="button" aria-pressed={value.length === 0} onClick={() => onChange([])} className={chip(value.length === 0, size)}>
        {allLabel}
      </button>
      {options.map((o) => {
        const active = value.includes(o.value);
        return (
          <button key={o.value} type="button" aria-pressed={active} onClick={() => toggle(o.value)} className={chip(active, size)}>
            {o.icon ? (
              <Icon name={o.icon} size={13} strokeWidth={2} className={active ? 'text-white' : o.tone ? TONE_STYLES[o.tone].text : undefined} />
            ) : (
              o.tone && <span className={cx('h-2 w-2 rounded-full', TONE_STYLES[o.tone].dot)} aria-hidden="true" />
            )}
            {o.label}
            {o.count !== undefined && <span className={cx('tabular-nums', active ? 'text-white/75' : 'text-ink-500')}>{o.count}</span>}
          </button>
        );
      })}
      {value.length > 0 && (
        <button type="button" onClick={() => onChange([])} className="ml-0.5 shrink-0 rounded-md px-1.5 text-xs font-semibold text-brand-700 hover:underline">
          Clear{value.length > 1 ? ` ${value.length}` : ''}
        </button>
      )}
    </div>
  );
}

/** An on/off chip (map layers and similar). */
export function ToggleChip({ pressed, onChange, icon, children, size = 'sm', className }: {
  pressed: boolean;
  onChange: (next: boolean) => void;
  icon?: IconName;
  children: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <button type="button" aria-pressed={pressed} onClick={() => onChange(!pressed)} className={cx(chip(pressed, size), className)}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
}
