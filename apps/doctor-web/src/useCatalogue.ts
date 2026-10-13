import { useEffect, useState } from 'react';
import type { CatalogueList, MedicationCatalogueEntry, SampleCatalogueEntry } from '@jiva/ui/src';
import { apiGet } from './api';

/**
 * Read access to the clinical catalogue (clinicians may read it; administrators manage it). Searches are
 * debounced; nothing here selects, prescribes or attaches anything by itself.
 */

export type Loadable<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'unavailable' } | { state: 'error' };

const enc = encodeURIComponent;

export function useMedicationSearch(query: string, limit = 12): Loadable<CatalogueList<MedicationCatalogueEntry>> {
  const [result, setResult] = useState<Loadable<CatalogueList<MedicationCatalogueEntry>>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      apiGet<CatalogueList<MedicationCatalogueEntry>>(`/api/catalogue/medications?limit=${limit}${query.trim() ? `&q=${enc(query.trim())}` : ''}`)
        .then((data) => live && setResult({ state: 'ready', data }))
        .catch(() => live && setResult({ state: 'error' }));
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query, limit]);
  return result;
}

/** The synthetic sample library. Unavailable (404) outside demo mode: samples never reach real encounters. */
export function useSampleLibrary(): Loadable<CatalogueList<SampleCatalogueEntry>> {
  const [result, setResult] = useState<Loadable<CatalogueList<SampleCatalogueEntry>>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    apiGet<CatalogueList<SampleCatalogueEntry>>('/api/catalogue/scan-assets')
      .then((data) => live && setResult({ state: 'ready', data }))
      .catch((err: unknown) => live && setResult(String(err).includes('404') ? { state: 'unavailable' } : { state: 'error' }));
    return () => {
      live = false;
    };
  }, []);
  return result;
}
