/**
 * Plain-language labels. Operational screens use `short`; patient-facing screens use `plain`.
 * Labels describe a service — they never imply a clinical judgement.
 */
const CAPABILITIES: Record<string, { short: string; plain: string }> = {
  EMERGENCY: { short: 'Emergency', plain: 'Emergency care' },
  TRAUMA: { short: 'Trauma', plain: 'Injury (trauma) care' },
  ICU: { short: 'ICU', plain: 'Intensive care' },
  HDU: { short: 'HDU', plain: 'High-dependency care' },
  NICU: { short: 'NICU', plain: 'Newborn intensive care' },
  PICU: { short: 'PICU', plain: "Children's intensive care" },
  VENTILATOR: { short: 'Ventilator', plain: 'Breathing support' },
  CARDIOLOGY: { short: 'Cardiology', plain: 'Heart care' },
  CARDIAC_SURGERY: { short: 'Cardiac surgery', plain: 'Heart surgery' },
  NEUROLOGY: { short: 'Neurology', plain: 'Brain and nerve care' },
  NEUROSURGERY: { short: 'Neurosurgery', plain: 'Brain surgery' },
  ORTHOPAEDICS: { short: 'Orthopaedics', plain: 'Bone and joint care' },
  ONCOLOGY: { short: 'Oncology', plain: 'Cancer care' },
  PAEDIATRICS: { short: 'Paediatrics', plain: "Children's care" },
  NEONATOLOGY: { short: 'Neonatology', plain: 'Newborn care' },
  OBSTETRICS: { short: 'Obstetrics', plain: 'Pregnancy and birth care' },
  GENERAL_SURGERY: { short: 'General surgery', plain: 'Surgery' },
  VASCULAR: { short: 'Vascular', plain: 'Blood vessel care' },
  BURNS: { short: 'Burns', plain: 'Burns care' },
  DIALYSIS: { short: 'Dialysis', plain: 'Kidney dialysis' },
  TRANSPLANT: { short: 'Transplant', plain: 'Transplant care' },
  BLOOD_BANK: { short: 'Blood bank', plain: 'Blood bank' },
  CT: { short: 'CT', plain: 'CT scan' },
  MRI: { short: 'MRI', plain: 'MRI scan' },
};

const titleCase = (code: string) => code.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function capabilityLabel(code: string, mode: 'short' | 'plain' = 'short'): string {
  return CAPABILITIES[code]?.[mode] ?? titleCase(code);
}

/** "A", "A and B", "A, B and C". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The part after an em dash ("JIVA … — Hebbal" → "Hebbal"), else the locality, else the name. */
export function hospitalShortName(name: string | undefined, locality?: string): string {
  if (!name) return locality || 'Unknown hospital';
  const dash = name.split(' — ');
  if (dash.length > 1) return dash[dash.length - 1];
  return locality || name;
}

/** "HOSP-BLR-001" → "001"; keeps demo-control style references readable. */
export function shortId(id: string | undefined): string {
  if (!id) return '';
  const m = id.match(/(\d+)$/);
  return m ? m[1] : id;
}

/** Ambulance lifecycle in words. */
export const AMBULANCE_STATUS_TEXT: Record<string, string> = {
  AVAILABLE: 'Available',
  DISPATCHED: 'Dispatched',
  EN_ROUTE_TO_PATIENT: 'To patient',
  ON_SCENE: 'On scene',
  PATIENT_ONBOARD: 'Patient on board',
  EN_ROUTE_TO_HOSPITAL: 'To hospital',
  ARRIVED: 'Arrived',
  UNAVAILABLE: 'Out of service',
};

export const SEVERITY_TEXT: Record<string, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};
