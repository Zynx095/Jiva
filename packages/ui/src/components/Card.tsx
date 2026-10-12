import React from 'react';
import { cx } from '../lib/cx';
import type { Tone } from '../lib/status';
import { Icon, type IconName } from './Icon';

const ACCENT: Record<Tone, string> = {
  ok: 'shadow-[inset_3px_0_0_var(--color-brand-500)]',
  warn: 'shadow-[inset_3px_0_0_var(--color-warn-500)]',
  danger: 'shadow-[inset_3px_0_0_var(--color-danger-500)]',
  neutral: 'shadow-[inset_3px_0_0_var(--color-ink-300)]',
};

export interface JivaCardProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'section' | 'article' | 'div' | 'li' | 'aside';
  padded?: boolean;
  /** Left accent stripe that carries the card's state. */
  accent?: Tone;
  selected?: boolean;
}

/** White surface on the gray page. Elevation is reserved for things that float (popovers, toasts). */
export function JivaCard({ as = 'section', padded = true, accent, selected, className, children, ...rest }: JivaCardProps) {
  const Comp = as;
  return (
    <Comp
      className={cx(
        'rounded-xl bg-white ring-1 ring-ink-200',
        padded && 'p-4',
        accent && ACCENT[accent],
        selected && 'ring-2 ring-brand-500',
        className,
      )}
      {...rest}
    >
      {children}
    </Comp>
  );
}

export interface CardHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: IconName;
  actions?: React.ReactNode;
  /** Heading level for the document outline. */
  level?: 2 | 3;
  className?: string;
  id?: string;
}

export function CardHeader({ title, subtitle, icon, actions, level = 2, className, id }: CardHeaderProps) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className={cx('flex items-start justify-between gap-3', className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && (
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-ink-50 text-ink-600 ring-1 ring-inset ring-ink-200">
            <Icon name={icon} size={15} />
          </span>
        )}
        <div className="min-w-0">
          <H id={id} className="text-[15px] font-semibold leading-6 tracking-[-0.01em] text-ink-900">
            {title}
          </H>
          {subtitle && <div className="text-[13px] leading-5 text-ink-500">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Uppercase-free section label for grouping inside panels. */
export function SectionLabel({ children, className, count }: { children: React.ReactNode; className?: string; count?: number }) {
  return (
    <div className={cx('flex items-center gap-2 text-[13px] font-semibold text-ink-600', className)}>
      {children}
      {count !== undefined && (
        <span className="rounded-full bg-ink-100 px-1.5 py-px text-xs font-semibold tabular-nums text-ink-600">{count}</span>
      )}
    </div>
  );
}

/** Label/value row used in detail views. */
export function DataRow({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-baseline justify-between gap-4 py-1.5 text-sm', className)}>
      <dt className="shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink-900">{children}</dd>
    </div>
  );
}
