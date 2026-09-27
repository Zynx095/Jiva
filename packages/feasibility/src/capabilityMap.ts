import type { Capabilities, CapabilityType, OperationalEvidence } from '@jiva/domain-models';

/**
 * Explicit, total mapping from CareRequirement capability codes to facility capability keys.
 * Replaces the camelCase regex in the legacy eligibility engine. The Record type makes the
 * compiler reject any CapabilityType that is not mapped.
 */
export const CAPABILITY_KEY: Record<CapabilityType, keyof Capabilities> = {
  EMERGENCY: 'emergency',
  TRAUMA: 'trauma',
  ICU: 'icu',
  HDU: 'hdu',
  NICU: 'nicu',
  PICU: 'picu',
  VENTILATOR: 'ventilator',
  CARDIOLOGY: 'cardiology',
  CARDIAC_SURGERY: 'cardiacSurgery',
  NEUROLOGY: 'neurology',
  NEUROSURGERY: 'neurosurgery',
  ORTHOPAEDICS: 'orthopaedics',
  ONCOLOGY: 'oncology',
  PAEDIATRICS: 'paediatrics',
  NEONATOLOGY: 'neonatology',
  OBSTETRICS: 'obstetrics',
  GENERAL_SURGERY: 'generalSurgery',
  VASCULAR: 'vascular',
  BURNS: 'burns',
  DIALYSIS: 'dialysis',
  TRANSPLANT: 'transplant',
  BLOOD_BANK: 'bloodBank',
  CT: 'ct',
  MRI: 'mri',
};

/** Capabilities that have a live operational status field. EMERGENCY is handled by HC-OPS-01. */
export const LIVE_STATUS_KEY: Partial<Record<CapabilityType, keyof OperationalEvidence['statuses']>> = {
  TRAUMA: 'trauma',
  ICU: 'icu',
  NICU: 'nicu',
  PICU: 'picu',
  VENTILATOR: 'ventilator',
};

export function isCapabilityType(value: string): value is CapabilityType {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_KEY, value);
}
