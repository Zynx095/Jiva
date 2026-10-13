import React from 'react';
import { cx } from '../lib/cx';
import { TONE_STYLES, type StatusMeta, type Tone } from '../lib/status';
import { Icon, type IconName } from './Icon';

export interface JivaBadgeProps {
  tone?: Tone;
  icon?: IconName;
  size?: 'sm' | 'md';
  title?: string;
  className?: string;
  children: React.ReactNode;
}

/** Small label with tone. Pair with an icon or words so colour is never the only signal. */
export function JivaBadge({ tone = 'neutral', icon, size = 'sm', title, className, children }: JivaBadgeProps) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-semibold ring-1 ring-inset',
        size === 'sm' ? 'h-6 rounded-full px-2 text-xs' : 'h-7 rounded-full px-2.5 text-[13px]',
        TONE_STYLES[tone].badge,
        className,
      )}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} strokeWidth={2} />}
      {children}
    </span>
  );
}

export interface JivaStatusProps {
  meta: StatusMeta;
  size?: 'sm' | 'md';
  className?: string;
  /** Text appended after the label, e.g. "for CASE-BLR-876". */
  suffix?: React.ReactNode;
}

/** Renders a StatusMeta (icon + label + tone); the hint becomes the tooltip. */
export function JivaStatus({ meta, size = 'sm', className, suffix }: JivaStatusProps) {
  return (
    <JivaBadge tone={meta.tone} icon={meta.icon} size={size} title={meta.hint} className={className}>
      {meta.label}
      {suffix}
    </JivaBadge>
  );
}

/** A small coloured dot; `pulse` marks something live or waiting. Always accompany with text. */
export function StatusDot({ tone = 'neutral', pulse, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cx('relative inline-flex h-2 w-2 shrink-0', className)} aria-hidden="true">
      {pulse && <span className={cx('absolute inset-0 rounded-full animate-ring', TONE_STYLES[tone].dot)} />}
      <span className={cx('relative inline-flex h-2 w-2 rounded-full', TONE_STYLES[tone].dot)} />
    </span>
  );
}
