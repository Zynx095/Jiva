import React, { useEffect, useRef, useState } from 'react';
import { cx } from '../lib/cx';
import { TONE_STYLES, type Tone } from '../lib/status';
import { dayLabel, formatClock } from '../lib/time';
import { Icon, type IconName } from './Icon';

export interface TimelineItem {
  id: string;
  /** ISO timestamp. */
  time: string;
  title: string;
  description?: React.ReactNode;
  tone?: Tone;
  icon?: IconName;
  /** Small trailing context (e.g. "Hospital"). */
  meta?: React.ReactNode;
  /** Revealed on demand: source, provenance, technical evidence. */
  details?: React.ReactNode;
  /** Number of merged repeats ("×6"). */
  count?: number;
}

export interface JivaTimelineProps {
  items: TimelineItem[];
  groupByDay?: boolean;
  /** Tighter rows for activity streams. */
  dense?: boolean;
  empty?: React.ReactNode;
  className?: string;
  /** Label for the expand control. */
  detailsLabel?: string;
}

/**
 * A living history: newest first, grouped by day, each entry expandable to its source and evidence.
 * Entries that arrive after the first render slide in, so new events are noticed without a toast.
 */
export function JivaTimeline({ items, groupByDay = true, dense, empty, className, detailsLabel = 'Details' }: JivaTimelineProps) {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Entries present on first render are history; anything later is "fresh" for ~1 s.
  if (seen.current === null && items.length > 0) seen.current = new Set(items.map((i) => i.id));
  useEffect(() => {
    if (!seen.current) return;
    const added = items.filter((i) => !seen.current?.has(i.id)).map((i) => i.id);
    if (added.length === 0) return;
    for (const id of added) seen.current.add(id);
    setFresh(new Set(added));
    const t = window.setTimeout(() => setFresh(new Set()), 1200);
    return () => window.clearTimeout(t);
  }, [items]);
  const isNew = (id: string) => fresh.has(id) || (seen.current !== null && !seen.current.has(id));

  if (items.length === 0) return <>{empty ?? null}</>;

  const groups: Array<[string, TimelineItem[]]> = [];
  for (const item of items) {
    const key = groupByDay ? dayLabel(item.time) : '';
    const last = groups[groups.length - 1];
    if (last && last[0] === key) last[1].push(item);
    else groups.push([key, [item]]);
  }

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={cx('space-y-4', className)}>
      {groups.map(([day, list]) => (
        <section key={day || 'all'} aria-label={day || undefined}>
          {groupByDay && <h3 className="mb-2 text-xs font-semibold text-ink-500">{day}</h3>}
          <ol className="relative">
            {list.map((item, idx) => {
              const tone = item.tone ?? 'neutral';
              const open = expanded.has(item.id);
              const last = idx === list.length - 1;
              return (
                <li key={item.id} className={cx('relative flex gap-3', dense ? 'pb-3' : 'pb-4', isNew(item.id) && 'animate-enter')}>
                  {!last && <span aria-hidden="true" className="absolute bottom-0 left-[13px] top-7 w-px bg-ink-200" />}
                  <span
                    aria-hidden="true"
                    className={cx('relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-4 ring-white', TONE_STYLES[tone].soft, TONE_STYLES[tone].text)}
                  >
                    <Icon name={item.icon ?? 'activity'} size={14} strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 text-sm font-semibold leading-5 text-ink-900">
                        {item.title}
                        {item.count && item.count > 1 ? <span className="ml-1.5 text-xs font-semibold tabular-nums text-ink-500">×{item.count}</span> : null}
                      </p>
                      <time dateTime={item.time} className="shrink-0 text-xs tabular-nums text-ink-500">
                        {formatClock(item.time)}
                      </time>
                    </div>
                    {item.description && <div className="mt-0.5 text-[13px] leading-5 text-ink-600">{item.description}</div>}
                    {(item.meta || item.details) && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {item.meta && <span className="text-xs text-ink-500">{item.meta}</span>}
                        {item.details && (
                          <button
                            type="button"
                            aria-expanded={open}
                            onClick={() => toggle(item.id)}
                            className="inline-flex items-center gap-0.5 rounded text-xs font-semibold text-brand-700 hover:underline"
                          >
                            {open ? 'Hide' : detailsLabel}
                            <Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} />
                          </button>
                        )}
                      </div>
                    )}
                    {open && item.details && <div className="mt-2 animate-fade rounded-lg bg-ink-50 p-3 text-[13px] text-ink-700 ring-1 ring-inset ring-ink-200">{item.details}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
