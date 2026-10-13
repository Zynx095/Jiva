import { useState } from 'react';
import { FORMULATION_TEXT, Icon, JivaButton, ROUTE_TEXT, cx, type MedicationCatalogueEntry } from '@jiva/ui/src';
import { inputClass } from './ui';
import { useMedicationSearch } from './useCatalogue';

/**
 * Choose a medication product from the catalogue. Choosing fills the product fields (name, strength, dosage
 * form, allowed routes); the dose, frequency and duration always come from the clinician. A catalogue match
 * never prescribes anything, and the server re-checks that the product fields agree with the entry.
 */
export function MedicationPicker({ id, onPick }: { id: string; onPick: (entry: MedicationCatalogueEntry) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <JivaButton size="sm" variant="ghost" icon="search" onClick={() => setOpen(true)}>
        Choose from the medication catalogue
      </JivaButton>
    );
  }
  return (
    <PickerPanel
      id={id}
      onClose={() => setOpen(false)}
      onPick={(m) => {
        onPick(m);
        setOpen(false);
      }}
    />
  );
}

function PickerPanel({ id, onPick, onClose }: { id: string; onPick: (entry: MedicationCatalogueEntry) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const result = useMedicationSearch(query);
  return (
    <div className="space-y-2 rounded-lg bg-white p-2.5 ring-1 ring-inset ring-ink-200">
      <label htmlFor={id} className="block text-xs font-semibold text-ink-700">
        Search the medication catalogue
      </label>
      <div className="flex items-center gap-2">
        <input id={id} autoFocus className={cx(inputClass, 'h-9')} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, catalogue id or ATC code" autoComplete="off" />
        <JivaButton size="sm" variant="ghost" onClick={onClose}>
          Close
        </JivaButton>
      </div>
      {result.state === 'loading' ? (
        <p className="text-xs text-ink-500">Searching…</p>
      ) : result.state === 'error' || result.state === 'unavailable' ? (
        <p className="text-xs text-danger-700">The catalogue could not be loaded. You can still enter the medication yourself.</p>
      ) : result.data.entries.length === 0 ? (
        <p className="text-xs text-ink-500">No catalogue entry matches. The catalogue is a small selection — enter the medication yourself if it is not listed.</p>
      ) : (
        <ul className="max-h-60 divide-y divide-ink-100 overflow-y-auto rounded-md ring-1 ring-inset ring-ink-100" aria-label="Catalogue results">
          {result.data.entries.map((m) => (
            <li key={m.medicationId}>
              <button
                type="button"
                className="flex w-full items-start justify-between gap-2 px-2.5 py-2 text-left hover:bg-brand-50/60 focus:bg-brand-50/60 focus:outline-none"
                onClick={() => onPick(m)}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-900">
                    {m.name} {m.strength}
                  </span>
                  <span className="block text-xs text-ink-600">
                    {FORMULATION_TEXT[m.formulation] ?? m.formulation} · {m.routes.map((r) => ROUTE_TEXT[r] ?? r).join(' / ')}
                    {m.atcCode ? ` · ATC ${m.atcCode}` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-ink-500">{m.medicationId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {result.state === 'ready' && (
        <p className="flex items-start gap-1.5 text-[11px] text-ink-500">
          <Icon name="info" size={12} className="mt-px shrink-0" />
          {result.data.notice}
        </p>
      )}
    </div>
  );
}
