import fs from 'fs';
import path from 'path';
import type { Practitioner } from '@jiva/domain-models';
import { evidenceEnvironment } from '../evidenceTrust';

/**
 * Staff directory used for doctor assignment.
 *
 * DEMO: a small, explicitly synthetic roster for the four synthetic network hospitals
 * (data/synthetic/bengaluru/clinicians.json), every entry labelled SYNTHETIC_DEMO.
 * PRODUCTION: empty. No hospital staff feed is integrated, so no doctor can be assigned until one is —
 * JIVA never invents staff.
 *
 * The repository's doctors.csv is deliberately NOT used: its "hospital_branch" values (Westside Clinic,
 * Eastside Clinic, Central Hospital) match no JIVA hospital, its specialties (dermatology, paediatrics,
 * oncology) are unrelated to emergency care, and it carries phone numbers and e-mail addresses.
 */
const ROSTER_FILE = path.resolve(__dirname, '../../../../data/synthetic/bengaluru/clinicians.json');

export function loadRoster(): Practitioner[] {
  if (evidenceEnvironment() !== 'DEMO') return [];
  try {
    const raw = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8')) as Array<Omit<Practitioner, 'dataStatus' | 'source'>>;
    return raw.map(p => ({ ...p, dataStatus: 'SYNTHETIC_DEMO', source: 'synthetic-demo-roster' }));
  } catch (err) {
    console.warn(`[Roster] Synthetic roster unavailable (${err instanceof Error ? err.message : err}); no doctor can be assigned.`);
    return [];
  }
}
