import React, { useEffect, useRef } from 'react';
import { cx } from '../lib/cx';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Briefly highlights its content when `value` changes (never on first render), so a realtime update
 * is noticed without a notification. Uses the Web Animations API; skipped for reduced motion.
 */
export function Flash({ value, children, className, as = 'span' }: { value: unknown; children: React.ReactNode; className?: string; as?: 'span' | 'div' }) {
  const ref = useRef<HTMLElement | null>(null);
  const previous = useRef(value);
  useEffect(() => {
    if (Object.is(previous.current, value)) return;
    previous.current = value;
    const el = ref.current;
    if (!el || reducedMotion() || typeof el.animate !== 'function') return;
    el.animate(
      [
        { backgroundColor: 'rgb(211 238 223 / 0.95)', boxShadow: '0 0 0 4px rgb(211 238 223 / 0.95)' },
        { backgroundColor: 'rgb(211 238 223 / 0)', boxShadow: '0 0 0 4px rgb(211 238 223 / 0)' },
      ],
      { duration: 1400, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [value]);
  const setRef = (el: HTMLElement | null) => {
    ref.current = el;
  };
  return as === 'div' ? (
    <div ref={setRef} className={cx('rounded-md', className)}>
      {children}
    </div>
  ) : (
    <span ref={setRef} className={cx('rounded-md', className)}>
      {children}
    </span>
  );
}
