import type { CatalogueReference, MedicationRoute } from '@jiva/domain-models';
import type { MedicationEntry } from '@jiva/event-schema';

/**
 * A prescription written from the medication catalogue must agree with the entry it names: the same
 * medication, strength and dosage form, and a route the product can be given by. The catalogue only
 * identifies the product; dose, frequency and duration always come from the clinician, and selecting an
 * entry never creates or authorises anything.
 */

export interface MedicationFields {
  medicationId?: string;
  medication: string;
  strength?: string;
  formulation?: string;
  route: MedicationRoute;
}

export type CatalogueCheck =
  | { ok: true; ref?: CatalogueReference }
  | { ok: false; status: 422; error: 'unknown_medication' | 'catalogue_mismatch'; message: string };

const same = (a?: string, b?: string) => !!a && !!b && a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

export function checkAgainstCatalogue(
  f: MedicationFields,
  lookup: (medicationId: string) => { entry: MedicationEntry; revision: number } | undefined,
  catalogueVersion: number,
): CatalogueCheck {
  if (!f.medicationId) return { ok: true };
  const found = lookup(f.medicationId);
  if (!found || found.entry.status !== 'ACTIVE') {
    return { ok: false, status: 422, error: 'unknown_medication', message: 'This medication is not in the catalogue or was withdrawn. Choose another entry or enter the medication without a catalogue reference.' };
  }
  const e = found.entry;
  const mismatch: string[] = [];
  if (!same(f.medication, e.name)) mismatch.push('medication');
  if (!same(f.strength, e.strength)) mismatch.push('strength');
  if (f.formulation !== e.formulation) mismatch.push('formulation');
  if (!e.routes.includes(f.route)) mismatch.push('route');
  if (mismatch.length) {
    return { ok: false, status: 422, error: 'catalogue_mismatch', message: `The ${mismatch.join(', ')} ${mismatch.length === 1 ? 'does' : 'do'} not match catalogue entry ${e.medicationId} (${e.name} ${e.strength}, ${e.formulation.toLowerCase().replace(/_/g, ' ')}, ${e.routes.join('/')}).` };
  }
  return { ok: true, ref: { medicationId: e.medicationId, revision: found.revision, catalogueVersion } };
}
