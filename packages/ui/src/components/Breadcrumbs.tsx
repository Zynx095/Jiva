import { cx } from '../lib/cx';
import { Icon } from './Icon';

export interface Crumb {
  label: string;
  onClick?: () => void;
}

/** "Where am I": every level is clickable except the current one. */
export function JivaBreadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cx('min-w-0', className)}>
      <ol className="flex min-w-0 items-center gap-1 text-[13px]">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} className={cx('flex min-w-0 items-center gap-1', last ? 'shrink' : 'shrink-0')}>
              {i > 0 && <Icon name="chevronRight" size={13} className="shrink-0 text-ink-400" />}
              {last || !c.onClick ? (
                <span aria-current={last ? 'page' : undefined} className={cx('truncate', last ? 'font-semibold text-ink-900' : 'text-ink-500')}>
                  {c.label}
                </span>
              ) : (
                <button type="button" onClick={c.onClick} className="truncate rounded px-0.5 font-medium text-ink-500 hover:text-brand-700 hover:underline">
                  {c.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
