/**
 * Links between the JIVA apps. Each app runs on its own port (development 5173–5178, production preview
 * 4173–4178); a link keeps the family the current page is served from and carries the demo persona.
 */
export type JivaApp = 'management' | 'ambulance' | 'hospital' | 'patient' | 'doctor' | 'demo';

const OFFSET: Record<JivaApp, number> = { management: 3, ambulance: 4, hospital: 5, patient: 6, doctor: 7, demo: 8 };

export const APP_TITLE: Record<JivaApp, string> = {
  management: 'Management',
  ambulance: 'Ambulance',
  hospital: 'Hospital',
  patient: 'Patient',
  doctor: 'Doctor workspace',
  demo: 'Demo portal',
};

export function jivaAppUrl(app: JivaApp, persona?: string, here: Location = window.location): string {
  const port = Number(here.port) || (here.protocol === 'https:' ? 443 : 80);
  const family = port >= 4170 && port <= 4179 ? 4170 : 5170;
  const url = new URL(`${here.protocol}//${here.hostname}:${family + OFFSET[app]}/`);
  if (persona) url.searchParams.set('as', persona);
  return url.toString();
}
