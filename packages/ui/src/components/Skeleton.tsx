import { cx } from '../lib/cx';

/** Placeholder that keeps the layout's shape while data loads. */
export function JivaSkeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx('jiva-skeleton block rounded-md', className)} />;
}

export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx('space-y-3', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <JivaSkeleton className="h-9 w-9 rounded-lg" />
          <div className="flex-1 space-y-2">
            <JivaSkeleton className="h-3.5 w-2/3" />
            <JivaSkeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
