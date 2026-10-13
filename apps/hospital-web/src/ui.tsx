import { useRef, type ReactNode } from 'react';
import { Icon, cx } from '@jiva/ui/src';
import { commandError, postCommand } from './api';

/**
 * Small form building blocks shared by the coordinator and clinician screens, plus the command helper:
 * every write goes to the API as a command and the screen shows the server's answer, never an
 * optimistic guess.
 */

export const inputClass =
  'w-full rounded-lg bg-white px-3 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 transition-shadow duration-150 placeholder:text-ink-400 hover:ring-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-600 disabled:bg-ink-50 disabled:text-ink-500';

export function Field({ label, htmlFor, hint, required, children, className }: { label: string; htmlFor: string; hint?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cx('min-w-0 space-y-1', className)}>
      <label htmlFor={htmlFor} className="block text-xs font-semibold text-ink-700">
        {label}
        {required && <span className="text-danger-700"> *</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function CommandError({ message }: { message: string }) {
  return (
    <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-danger-50 px-3 py-2 text-[13px] text-danger-700 ring-1 ring-inset ring-danger-200">
      <Icon name="alertCircle" size={15} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

/**
 * One idempotency key per intent: resubmitting the same content (e.g. after a network error) reuses the
 * key, so the server applies it at most once; changed content is a new intent with a new key.
 */
export function useIdempotencyKey(): (body: unknown) => string {
  const ref = useRef<{ key: string; body: string } | null>(null);
  return (body: unknown) => {
    const s = JSON.stringify(body);
    if (!ref.current || ref.current.body !== s) ref.current = { key: crypto.randomUUID(), body: s };
    return ref.current.key;
  };
}

export interface SendResult<T> {
  error: string | null;
  status: number;
  body?: T & { error?: string; message?: string };
}

/** POST a command; resolves with a sentence for the user on any failure (never throws). */
export async function sendCommand<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<SendResult<T>> {
  try {
    const r = await postCommand<T>(path, body);
    return { error: commandError(r), status: r.status, body: r.body };
  } catch {
    return { error: 'Cannot reach JIVA. Nothing was lost — try again; the same request is safe to resend.', status: 0 };
  }
}
