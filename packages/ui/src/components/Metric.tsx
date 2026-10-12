import React from 'react';
import { cx } from '../lib/cx';
import { TONE_STYLES, type Tone } from '../lib/status';
import { Flash } from './Flash';
import { Icon, type IconName } from './Icon';

export interface JivaMetricProps {
  label: string;
  value: React.ReactNode;
  /** Colours the value only when it carries meaning (e.g. awaiting > 0). */
  tone?: Tone;
  icon?: IconName;
  hint?: React.ReactNode;
  /** Makes the metric a filter shortcut. */
  onClick?: () => void;
  active?: boolean;
  className?: string;
}

/** A single headline number. Clickable metrics act as shortcuts into the matching list. */
export function JivaMetric({ label, value, tone, icon, hint, onClick, active, className }: JivaMetricProps) {
  const body = (
    <>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-[13px] font-medium leading-5 text-ink-500">
        {icon && <Icon name={icon} size={14} className={tone ? TONE_STYLES[tone].text : 'text-ink-400'} />}
        {label}
      </span>
      <Flash value={value} className="mt-1 -ml-1 inline-block px-1">
        <span className={cx('text-2xl font-semibold leading-8 tracking-[-0.02em] tabular-nums', tone ? TONE_STYLES[tone].text : 'text-ink-900')}>
          {value}
        </span>
      </Flash>
      {hint && <span className="mt-0.5 block w-full max-w-full truncate text-xs text-ink-500">{hint}</span>}
    </>
  );
  const shell = 'flex min-w-0 flex-col items-start rounded-xl px-4 py-2.5 text-left';
  if (!onClick) return <div className={cx(shell, className)}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        shell,
        'transition-[background-color,box-shadow] duration-150 hover:bg-ink-50 active:scale-[0.99]',
        active && 'bg-ink-50 ring-1 ring-inset ring-ink-200',
        className,
      )}
    >
      {body}
    </button>
  );
}
