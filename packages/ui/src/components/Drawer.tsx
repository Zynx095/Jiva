import React, { useEffect, useId, useRef } from 'react';
import { Icon } from './Icon';

export interface JivaDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/** Slide-over panel for secondary detail (system status, technical evidence). Escape or backdrop closes it. */
export function JivaDrawer({ open, onClose, title, subtitle, children, footer }: JivaDrawerProps) {
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
      className="my-0 mr-0 ml-auto h-dvh max-h-none w-[min(100vw,440px)] max-w-none bg-white p-0 text-ink-900 shadow-lg backdrop:bg-ink-950/30 open:animate-drawer"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-3 border-b border-ink-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold leading-6">
              {title}
            </h2>
            {subtitle && <div className="text-[13px] text-ink-500">{subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close panel" className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800">
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="jiva-scroll flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="border-t border-ink-200 px-5 py-3">{footer}</footer>}
      </div>
    </dialog>
  );
}
