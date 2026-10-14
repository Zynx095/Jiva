import React, { useRef } from 'react';
import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
  icon?: IconName;
  /** Draws a small amber marker: something in this tab needs attention. */
  attention?: boolean;
}

export interface JivaTabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix: string;
  className?: string;
  /** Compact tabs for narrow side panels. */
  size?: 'md' | 'sm';
}

/** Accessible tabs: arrow keys / Home / End move between tabs, only the active tab is in the tab order. */
export function JivaTabs<T extends string>({ items, value, onChange, label, idPrefix, className, size = 'md' }: JivaTabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const last = items.length - 1;
    const next = e.key === 'ArrowRight' ? (i === last ? 0 : i + 1) : e.key === 'ArrowLeft' ? (i === 0 ? last : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={cx('jiva-scroll flex gap-0.5 overflow-x-auto border-b border-ink-200', className)}>
      {items.map((t, i) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cx(
              'relative -mb-px flex h-11 shrink-0 items-center border-b-2 font-semibold transition-colors duration-150',
              size === 'sm' ? 'gap-1 px-[7px] text-[13px]' : 'gap-1.5 px-3 text-sm',
              selected ? 'border-brand-700 text-ink-900' : 'border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-800',
            )}
          >
            {t.icon && <Icon name={t.icon} size={15} />}
            {t.label}
            {t.count !== undefined && (
              <span className={cx('rounded-full px-1.5 py-px text-xs tabular-nums', selected ? 'bg-brand-50 text-brand-800' : 'bg-ink-100 text-ink-600')}>
                {t.count}
              </span>
            )}
            {t.attention && (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-warn-500" aria-hidden="true" />
                <span className="sr-only">(needs attention)</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idPrefix, id, children, className }: { idPrefix: string; id: string; children: React.ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`} className={className}>
      {children}
    </div>
  );
}
