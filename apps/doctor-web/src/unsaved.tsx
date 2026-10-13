import { createContext, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from 'react';

/**
 * Which open forms hold unsaved edits. Forms report themselves with `useUnsaved`; the workspace asks before
 * switching patients (so edits are never silently dropped — and never carried to the next patient, because
 * the panels remount per encounter), and the browser asks before a reload or close.
 */
interface UnsavedRegistry {
  set: (id: string, label: string | null) => void;
  /** Labels of the forms with unsaved edits, e.g. ["vital signs", "clinical note"]. */
  pending: () => string[];
}

const UnsavedContext = createContext<UnsavedRegistry | null>(null);

export function UnsavedProvider({ children }: { children: ReactNode }) {
  const forms = useRef(new Map<string, string>());
  const registry = useMemo<UnsavedRegistry>(
    () => ({
      set: (id, label) => {
        if (label) forms.current.set(id, label);
        else forms.current.delete(id);
      },
      pending: () => [...new Set(forms.current.values())],
    }),
    [],
  );
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (forms.current.size === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
  return <UnsavedContext.Provider value={registry}>{children}</UnsavedContext.Provider>;
}

/** Marks the calling form as holding unsaved edits while `dirty` is true; cleared when it closes or unmounts. */
export function useUnsaved(dirty: boolean, label: string) {
  const registry = useContext(UnsavedContext);
  const id = useId();
  useEffect(() => {
    registry?.set(id, dirty ? label : null);
  }, [registry, id, dirty, label]);
  useEffect(() => () => registry?.set(id, null), [registry, id]);
}

export const useUnsavedRegistry = () => useContext(UnsavedContext);

/** "vital signs", "vital signs and a clinical note", "a, b and c". */
export function listLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
