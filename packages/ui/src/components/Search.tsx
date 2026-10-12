import React, { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

export interface SearchItem {
  id: string;
  /** Result group heading, e.g. "Hospitals". */
  group: string;
  label: string;
  sublabel?: string;
  icon?: IconName;
  /** Extra text matched but not shown (ids, localities…). */
  keywords?: string;
  /** Right-aligned extra (a status badge). */
  meta?: React.ReactNode;
}

export interface JivaSearchProps {
  items: SearchItem[];
  onSelect: (item: SearchItem) => void;
  placeholder?: string;
  label?: string;
  className?: string;
  perGroup?: number;
}

const isTypingTarget = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/** Global contextual search: grouped results, arrow keys + Enter, "/" or Ctrl/⌘+K to focus. */
export function JivaSearch({ items, onSelect, placeholder = 'Search', label = 'Search', className, perGroup = 5 }: JivaSearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const groups = useMemo(() => {
    const terms = deferred.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = items.filter((it) => {
      const hay = `${it.label} ${it.sublabel ?? ''} ${it.keywords ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    const byGroup = new Map<string, SearchItem[]>();
    for (const m of matches) {
      const list = byGroup.get(m.group) ?? [];
      if (list.length < perGroup) list.push(m);
      byGroup.set(m.group, list);
    }
    return [...byGroup.entries()];
  }, [deferred, items, perGroup]);

  const flat = useMemo(() => groups.flatMap(([, list]) => list), [groups]);

  useEffect(() => setActive(0), [deferred]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === '/' && !isTypingTarget(e.target)) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  const choose = (item: SearchItem | undefined) => {
    if (!item) return;
    onSelect(item);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(flat[active]);
    } else if (e.key === 'Escape') {
      if (query) setQuery('');
      else inputRef.current?.blur();
      setOpen(false);
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;
  let index = -1;

  return (
    <div ref={rootRef} className={cx('relative', className)}>
      <label className="sr-only" htmlFor={`${listId}-input`}>
        {label}
      </label>
      <div className="flex h-10 items-center gap-2 rounded-xl bg-ink-50 px-3 ring-1 ring-inset ring-ink-200 transition-[box-shadow,background-color] focus-within:bg-white focus-within:ring-2 focus-within:ring-brand-500">
        <Icon name="search" size={16} className="shrink-0 text-ink-500" />
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && flat.length ? optionId(active) : undefined}
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-500 [&::-webkit-search-cancel-button]:hidden"
        />
        <kbd className="hidden shrink-0 rounded-md bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink-500 ring-1 ring-ink-200 sm:block">/</kbd>
      </div>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label={`${label} results`}
          className="jiva-scroll absolute left-0 right-0 top-[calc(100%+6px)] z-40 max-h-[min(70vh,420px)] animate-fade overflow-y-auto rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-ink-200"
        >
          {flat.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-500">{deferred ? `No matches for “${deferred}”.` : 'Nothing to search yet.'}</p>
          ) : (
            groups.map(([group, list]) => (
              <div key={group} role="presentation" className="py-1">
                <div role="presentation" className="px-2.5 pb-1 pt-1.5 text-xs font-semibold text-ink-500">
                  {group}
                </div>
                {list.map((it) => {
                  index += 1;
                  const i = index;
                  const selected = i === active;
                  return (
                    <div
                      key={it.id}
                      id={optionId(i)}
                      role="option"
                      aria-selected={selected}
                      onPointerEnter={() => setActive(i)}
                      onPointerDown={(e) => e.preventDefault()}
                      onClick={() => choose(it)}
                      className={cx('flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2', selected ? 'bg-brand-50' : 'hover:bg-ink-50')}
                    >
                      {it.icon && (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-ink-600 ring-1 ring-ink-200">
                          <Icon name={it.icon} size={15} />
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-ink-900">{it.label}</span>
                        {it.sublabel && <span className="block truncate text-xs text-ink-500">{it.sublabel}</span>}
                      </span>
                      {it.meta}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
