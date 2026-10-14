import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'ghost' | 'danger' | 'critical' | 'danger-soft' | 'warn-soft' | 'ok-soft';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * One visual weight per role:
 *   primary   — the one most important action of the current workflow (green)
 *   secondary — useful, less important (white, warm outline)
 *   tertiary  — low-emphasis text action (green text)
 *   ghost     — toolbar / dismiss actions (neutral text)
 *   danger    — confirms a destructive action (red)
 *   critical  — an emergency action (deep red, strongest weight); always explicit about its effect
 *   *-soft    — consequential choices shown side by side with a primary (outlined in their tone)
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'jiva-fill-primary shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(32_40_32/0.18)] hover:jiva-fill-primary-hover hover:shadow-e2',
  secondary: 'bg-surface text-ink-800 shadow-xs ring-1 ring-inset ring-ink-300 hover:bg-ink-50 hover:text-ink-900 hover:ring-ink-400 active:bg-ink-100',
  tertiary: 'text-brand-700 hover:bg-brand-50 hover:text-brand-800 active:bg-brand-100',
  ghost: 'text-ink-700 hover:bg-ink-100 hover:text-ink-900 active:bg-ink-200',
  danger: 'jiva-fill-danger shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(32_40_32/0.18)] hover:jiva-fill-danger-hover hover:shadow-e2',
  critical: 'jiva-fill-critical shadow-[inset_0_1px_0_rgb(255_255_255/0.16),0_2px_8px_rgb(168_47_50/0.30)] hover:jiva-fill-critical-hover',
  'danger-soft': 'bg-surface text-danger-700 shadow-xs ring-1 ring-inset ring-danger-200 hover:bg-danger-50 hover:ring-danger-300',
  'warn-soft': 'bg-surface text-warn-800 shadow-xs ring-1 ring-inset ring-warn-200 hover:bg-warn-50 hover:ring-warn-300',
  'ok-soft': 'bg-surface text-brand-800 shadow-xs ring-1 ring-inset ring-brand-200 hover:bg-brand-50 hover:ring-brand-300',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-[13px]',
  md: 'h-10 gap-2 rounded-[10px] px-4 text-sm',
  lg: 'h-12 gap-2 rounded-xl px-5 text-[15px]',
};

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cx('animate-spin', className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export interface JivaButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  block?: boolean;
}

export const JivaButton = React.forwardRef<HTMLButtonElement, JivaButtonProps>(function JivaButton(
  { variant = 'secondary', size = 'md', icon, iconRight, loading, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const iconSize = size === 'sm' ? 15 : 17;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-semibold tracking-[-0.005em] transition-[background-color,box-shadow,color,transform] duration-150 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:saturate-50 disabled:shadow-none disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight && !loading && <Icon name={iconRight} size={iconSize} />}
    </button>
  );
});

/** An action resolves to an error message, or nothing on success. */
export type ActionResult = string | null | void | undefined;
export type ActionState = 'idle' | 'pending' | 'success' | 'error';

/** idle → pending → success | error, with the error text kept for the caller to show. */
export function useAsyncAction(action: () => Promise<ActionResult>, successMs = 2400) {
  const [state, setState] = useState<ActionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const busy = useRef(false);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const run = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    window.clearTimeout(timer.current);
    setState('pending');
    setError(null);
    try {
      const result = await action();
      if (typeof result === 'string' && result) {
        setError(result);
        setState('error');
      } else {
        setDoneAt(Date.now());
        setState('success');
        if (successMs > 0) timer.current = window.setTimeout(() => setState('idle'), successMs);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState('error');
    } finally {
      busy.current = false;
    }
  }, [action, successMs]);

  const reset = useCallback(() => {
    window.clearTimeout(timer.current);
    setState('idle');
    setError(null);
  }, []);

  return { state, error, doneAt, run, reset };
}

export interface AsyncButtonProps extends Omit<JivaButtonProps, 'onClick' | 'loading'> {
  onAction: () => Promise<ActionResult>;
  pendingText?: string;
  successText?: string;
  /** Called with the error message (or null on success) after each attempt. */
  onSettled?: (error: string | null) => void;
}

/** A button that shows its own progress: idle → "Sending…" → ✓ done (or ✕ failed, with a retry). */
export function AsyncButton({ onAction, pendingText, successText, onSettled, children, icon, variant, ...rest }: AsyncButtonProps) {
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });
  const wrapped = useCallback(async () => {
    const result = await onAction();
    settled.current?.(typeof result === 'string' && result ? result : null);
    return result;
  }, [onAction]);
  const { state, error, run } = useAsyncAction(wrapped);
  const label = state === 'pending' ? pendingText ?? children : state === 'success' ? successText ?? children : children;
  return (
    <JivaButton
      {...rest}
      variant={variant}
      icon={state === 'success' ? 'check' : state === 'error' ? 'alertCircle' : icon}
      loading={state === 'pending'}
      onClick={run}
      title={state === 'error' && error ? `Failed: ${error}. Click to try again.` : rest.title}
      data-state={state}
      className={cx(rest.className, state === 'error' && 'ring-2 ring-danger-300', state === 'success' && 'ring-2 ring-brand-300')}
    >
      {label}
      <span className="sr-only" aria-live="polite">
        {state === 'pending' ? 'Sending' : state === 'success' ? 'Done' : state === 'error' ? `Failed: ${error}` : ''}
      </span>
    </JivaButton>
  );
}
