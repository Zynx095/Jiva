import React from 'react';
import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  /** What is empty. */
  title: string;
  /** Why, and what will make something appear. */
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
  className?: string;
}

/** Never just "No data": say what is empty, why, and what the person can do. */
export function EmptyState({ icon = 'info', title, description, action, compact, className }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-center text-center', compact ? 'gap-1.5 px-3 py-5' : 'gap-2 px-6 py-10', className)}>
      <span className={cx('flex items-center justify-center rounded-full bg-ink-100 text-ink-500', compact ? 'h-9 w-9' : 'h-11 w-11')}>
        <Icon name={icon} size={compact ? 17 : 20} />
      </span>
      <p className={cx('font-semibold text-ink-800', compact ? 'text-sm' : 'text-[15px]')}>{title}</p>
      {description && <p className={cx('max-w-sm text-ink-500', compact ? 'text-[13px]' : 'text-sm')}>{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
