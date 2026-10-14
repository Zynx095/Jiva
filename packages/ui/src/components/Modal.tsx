import React, { useEffect, useId, useRef } from 'react';
import { cx } from '../lib/cx';
import { TONE_STYLES, type Tone } from '../lib/status';
import { Icon, type IconName } from './Icon';

export interface JivaModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  icon?: IconName;
  tone?: Tone;
  children?: React.ReactNode;
  /** Buttons, right-aligned. */
  actions?: React.ReactNode;
}

/**
 * Native <dialog>: focus is trapped, Escape closes, focus returns to the trigger. Reserved for
 * decisions with consequences (e.g. reporting an emergency department unavailable).
 */
export function JivaModal({ open, onClose, title, description, icon, tone = 'neutral', children, actions }: JivaModalProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-auto max-h-[min(90dvh,720px)] w-[min(92vw,460px)] overflow-y-auto rounded-2xl bg-surface-raised p-0 text-ink-900 shadow-e4 ring-1 ring-ink-200 backdrop:bg-(--scrim) open:animate-toast"
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-3">
          {icon && (
            <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', TONE_STYLES[tone].soft, TONE_STYLES[tone].text)}>
              <Icon name={icon} size={18} strokeWidth={2} />
            </span>
          )}
          <div className="min-w-0">
            <h2 id={titleId} className="text-[17px] font-semibold leading-6 tracking-[-0.01em]">
              {title}
            </h2>
            {description && <div className="mt-1 text-sm leading-6 text-ink-600">{description}</div>}
          </div>
        </div>
        {children && <div className="mt-4">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap justify-end gap-2 border-t border-ink-200 bg-ink-50 px-5 py-3 sm:px-6">{actions}</div>}
    </dialog>
  );
}
