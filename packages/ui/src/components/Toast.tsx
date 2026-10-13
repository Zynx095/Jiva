import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../lib/cx';
import { TONE_STYLES, type Tone } from '../lib/status';
import { Icon, type IconName } from './Icon';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: Tone;
  icon?: IconName;
  /** Toasts with the same key merge into one ("3 updates") instead of stacking. */
  groupKey?: string;
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  count: number;
}

interface ToastApi {
  show: (toast: ToastInput) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
const noop: ToastApi = { show: () => undefined, dismiss: () => undefined };

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? noop;
}

const MAX_VISIBLE = 4;

/** Quiet, grouped realtime notifications. Announced politely to screen readers. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const itemsRef = useRef<ToastItem[]>([]);
  const timers = useRef(new Map<number, number>());
  const nextId = useRef(1);

  const commit = (next: ToastItem[]) => {
    itemsRef.current = next;
    setItems(next);
  };

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    commit(itemsRef.current.filter((t) => t.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number, ms: number) => {
      window.clearTimeout(timers.current.get(id));
      timers.current.set(id, window.setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );

  const show = useCallback(
    (input: ToastInput) => {
      const prev = itemsRef.current;
      const existing = input.groupKey ? prev.find((t) => t.groupKey === input.groupKey) : undefined;
      let id: number;
      if (existing) {
        id = existing.id;
        commit(prev.map((t) => (t.id === id ? { ...t, ...input, count: t.count + 1 } : t)));
      } else {
        id = nextId.current++;
        commit([...prev, { ...input, id, count: 1 }].slice(-MAX_VISIBLE));
      }
      schedule(id, input.durationMs ?? 5200);
    },
    [schedule],
  );

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => window.clearTimeout(t));
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[360px]"
      >
        {items.map((t) => (
          <div
            key={t.id}
            onMouseEnter={() => window.clearTimeout(timers.current.get(t.id))}
            onMouseLeave={() => schedule(t.id, 2500)}
            className="pointer-events-auto flex animate-toast items-start gap-3 rounded-xl bg-white p-3 pr-2 shadow-lg ring-1 ring-ink-200"
          >
            <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', TONE_STYLES[t.tone ?? 'neutral'].soft, TONE_STYLES[t.tone ?? 'neutral'].text)}>
              <Icon name={t.icon ?? 'info'} size={16} strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-5 text-ink-900">
                {t.title}
                {t.count > 1 && <span className="ml-1.5 rounded-full bg-ink-100 px-1.5 py-px text-xs font-semibold tabular-nums text-ink-600">×{t.count}</span>}
              </p>
              {t.description && <p className="mt-0.5 text-[13px] leading-5 text-ink-600">{t.description}</p>}
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                  className="mt-1.5 text-[13px] font-semibold text-brand-700 hover:underline"
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-800">
              <Icon name="x" size={15} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
