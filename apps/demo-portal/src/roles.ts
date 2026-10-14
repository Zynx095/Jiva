import type { IconName, JivaApp } from '@jiva/ui/src';

/**
 * The role interfaces the portal opens, what each role can do and see (as implemented — see the apps), and
 * the demo personas it can act as. Personas are DEMO-ONLY identities: the API accepts them only in demo mode
 * and only from this machine, and enforces each persona's role and scope exactly as for a real user.
 */
export interface RoleEntry {
  app: JivaApp;
  title: string;
  icon: IconName;
  /** What the role does in JIVA. */
  does: string;
  /** What information it can access (and what it cannot). */
  sees: string;
  personas: Array<{ value: string; label: string; note?: string }>;
}

export const ROLES: RoleEntry[] = [
  {
    app: 'patient',
    title: 'Patient',
    icon: 'user',
    does: 'Follow your own emergency: hospital confirmation, the ambulance and its estimated arrival, the care team, then medications, results and documents shared with you.',
    sees: 'Only your own case. No clinical notes, no drafts, nothing about other patients.',
    personas: [
      { value: 'demo-patient-1', label: 'Patient CASE-BLR-876', note: 'Appears once a scenario or a crew opens CASE-BLR-876' },
      { value: 'demo-patient-2', label: 'Patient CASE-BLR-877', note: 'Appears once a crew reports CASE-BLR-877' },
    ],
  },
  {
    app: 'doctor',
    title: 'Doctor',
    icon: 'stethoscope',
    does: 'Review assigned patients, enter and correct vital signs by hand, write clinical notes and reports, draft and authorise prescriptions, attach documents.',
    sees: 'Only the patients a hospital coordinator assigned to you, at your hospital.',
    personas: [
      { value: 'demo-doc-3', label: 'Dr. Ravi Kumar · Hebbal' },
      { value: 'demo-doc-4', label: 'Dr. Sanjay Patil · Whitefield' },
      { value: 'demo-doc-5', label: 'Dr. Ananya Das · Koramangala' },
      { value: 'demo-doc-1', label: 'Dr. Kavya Rao · Indiranagar' },
      { value: 'demo-doc-2', label: 'Dr. Arjun Menon · Indiranagar' },
    ],
  },
  {
    app: 'hospital',
    title: 'Hospital',
    icon: 'hospital',
    does: 'Answer incoming emergency requests (accept, accept with limits, decline), report service status, record arrival and handover with notes, assign the responsible doctor.',
    sees: 'Requests and patients for your hospital only; no clinical records.',
    personas: [
      { value: 'demo-hosp-1', label: 'Hebbal coordinator' },
      { value: 'demo-hosp-2', label: 'Whitefield coordinator' },
      { value: 'demo-hosp-3', label: 'Koramangala coordinator' },
      { value: 'demo-hosp-4', label: 'Indiranagar coordinator' },
    ],
  },
  {
    app: 'ambulance',
    title: 'Ambulance',
    icon: 'ambulance',
    does: 'Report an emergency from the scene, record patient observations, follow hospital answers and the route, and set the unit’s position by hand (no GPS is connected).',
    sees: 'Your own unit’s current case, until the hospital records the handover.',
    personas: [
      { value: 'demo-amb-1', label: 'Crew AMB-BLR-001' },
      { value: 'demo-amb-2', label: 'Crew AMB-BLR-002', note: 'The unit the guided scenarios use' },
      { value: 'demo-amb-3', label: 'Crew AMB-BLR-003' },
    ],
  },
  {
    app: 'management',
    title: 'Management',
    icon: 'map',
    does: 'Watch coordination across the network: active emergencies, each case’s hospital answers, ambulances, hospital status and the activity stream; demo controls act as the real actors.',
    sees: 'Operational state of every case and unit; no clinical content.',
    personas: [{ value: 'demo-mgmt-1', label: 'Network coordination' }],
  },
];
