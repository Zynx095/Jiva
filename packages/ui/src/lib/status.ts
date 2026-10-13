import type { IconName } from '../components/Icon';
import { AMBULANCE_STATUS_TEXT, SEVERITY_TEXT } from './labels';

/**
 * One status vocabulary for every screen (see DESIGN.md › Status language).
 *   ok      green  — accepted, active, available, confirmed
 *   warn    amber  — pending, limited, stale, needs attention
 *   danger  red    — rejected, unavailable, critical, error
 *   neutral gray   — unknown, expired, historical, inactive
 * A status is always rendered as icon + label + colour, never colour alone.
 */
export type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon: IconName;
  /** One plain sentence explaining what the status means. */
  hint?: string;
}

export const TONE_STYLES: Record<Tone, { badge: string; text: string; solid: string; soft: string; dot: string; border: string }> = {
  ok: {
    badge: 'bg-brand-50 text-brand-800 ring-brand-200',
    text: 'text-brand-700',
    solid: 'bg-brand-700 text-white',
    soft: 'bg-brand-50',
    dot: 'bg-brand-500',
    border: 'border-brand-200',
  },
  warn: {
    badge: 'bg-warn-50 text-warn-800 ring-warn-200',
    text: 'text-warn-700',
    solid: 'bg-warn-600 text-white',
    soft: 'bg-warn-50',
    dot: 'bg-warn-500',
    border: 'border-warn-200',
  },
  danger: {
    badge: 'bg-danger-50 text-danger-700 ring-danger-200',
    text: 'text-danger-700',
    solid: 'bg-danger-600 text-white',
    soft: 'bg-danger-50',
    dot: 'bg-danger-500',
    border: 'border-danger-200',
  },
  neutral: {
    badge: 'bg-ink-50 text-ink-700 ring-ink-200',
    text: 'text-ink-600',
    solid: 'bg-ink-700 text-white',
    soft: 'bg-ink-50',
    dot: 'bg-ink-400',
    border: 'border-ink-200',
  },
};

/** A hospital's answer to an acceptance request (or the absence of one). */
export function acceptanceStatus(status?: string): StatusMeta {
  switch (status) {
    case 'ACCEPTED':
      return { label: 'Accepted', tone: 'ok', icon: 'checkCircle', hint: 'The hospital confirmed it can receive this patient.' };
    case 'LIMITED':
      return { label: 'Limited', tone: 'warn', icon: 'half', hint: 'The hospital can receive the patient with stated limits.' };
    case 'PENDING':
      return { label: 'Awaiting response', tone: 'warn', icon: 'clock', hint: 'JIVA asked the hospital and is waiting for an answer.' };
    case 'REJECTED':
      return { label: 'Declined', tone: 'danger', icon: 'xCircle', hint: 'The hospital cannot take this case.' };
    case 'UNAVAILABLE':
      return { label: 'Unavailable', tone: 'danger', icon: 'ban', hint: 'The hospital reported it cannot receive patients right now.' };
    case 'EXPIRED':
      return { label: 'Expired', tone: 'neutral', icon: 'hourglass', hint: 'The last answer is too old to rely on.' };
    case 'UNANSWERED':
      return { label: 'No answer in time', tone: 'neutral', icon: 'hourglass', hint: 'The request reached its deadline without an answer. JIVA treats the hospital as unknown for this case.' };
    case 'NOT_ASKED':
      return { label: 'Not asked', tone: 'neutral', icon: 'minus', hint: 'JIVA did not send this hospital a request for this case.' };
    case 'CANCELLED':
      return { label: 'Withdrawn', tone: 'neutral', icon: 'x', hint: 'JIVA withdrew the request (the case changed or closed).' };
    default:
      return { label: 'No current response', tone: 'neutral', icon: 'help', hint: 'No current answer from this hospital. JIVA never assumes a bed is free.' };
  }
}

/** A reported service status (emergency department, ICU, trauma…). */
export function capabilityStatus(status?: string): StatusMeta {
  switch (status) {
    case 'AVAILABLE':
      return { label: 'Available', tone: 'ok', icon: 'checkCircle' };
    case 'LIMITED':
      return { label: 'Limited', tone: 'warn', icon: 'half' };
    case 'UNAVAILABLE':
      return { label: 'Unavailable', tone: 'danger', icon: 'ban' };
    default:
      return { label: 'Unknown', tone: 'neutral', icon: 'help', hint: 'Not reported.' };
  }
}

export function ambulanceStatus(status?: string): StatusMeta {
  const label = (status && AMBULANCE_STATUS_TEXT[status]) || 'Unknown';
  switch (status) {
    case 'AVAILABLE':
      return { label, tone: 'ok', icon: 'checkCircle' };
    case 'ARRIVED':
      return { label, tone: 'ok', icon: 'pin' };
    case 'UNAVAILABLE':
      return { label, tone: 'neutral', icon: 'ban' };
    case undefined:
      return { label, tone: 'neutral', icon: 'help' };
    default:
      return { label, tone: 'ok', icon: 'navigation' };
  }
}

export function patientStatus(status?: string): StatusMeta {
  switch (status) {
    case 'EMERGENCY_REPORTED':
      return { label: 'Reported', tone: 'danger', icon: 'siren' };
    case 'ASSESSED':
      return { label: 'Finding a hospital', tone: 'warn', icon: 'clock' };
    case 'IN_TRANSIT':
      return { label: 'In transit', tone: 'ok', icon: 'navigation' };
    case 'ARRIVED':
      return { label: 'Arrived', tone: 'ok', icon: 'pin', hint: 'At the hospital. Hospital care is confirmed when the hospital records the handover.' };
    case 'HANDED_OVER':
      return { label: 'In hospital care', tone: 'ok', icon: 'stethoscope', hint: 'The hospital recorded the handover from the ambulance crew.' };
    case 'ADMITTED':
      return { label: 'Admitted', tone: 'ok', icon: 'hospital' };
    case 'DISCHARGED':
      return { label: 'Closed', tone: 'neutral', icon: 'check' };
    default:
      return { label: 'Unknown', tone: 'neutral', icon: 'help' };
  }
}

export function severityStatus(severity?: string): StatusMeta {
  const label = (severity && SEVERITY_TEXT[severity]) || 'Not assessed';
  switch (severity) {
    case 'CRITICAL':
    case 'HIGH':
      return { label, tone: 'danger', icon: 'alertCircle' };
    case 'MEDIUM':
      return { label, tone: 'warn', icon: 'alertTriangle' };
    case 'LOW':
      return { label, tone: 'neutral', icon: 'info' };
    default:
      return { label, tone: 'neutral', icon: 'help' };
  }
}

/** Where a record comes from. Demo data is always labelled as such. */
export function dataStatus(status?: string): StatusMeta {
  switch (status) {
    case 'SYNTHETIC_DEMO':
      return { label: 'Demo data', tone: 'warn', icon: 'info', hint: 'Synthetic record for the demo. Not real hospital capacity.' };
    case 'PUBLIC_LISTED':
      return { label: 'Public listing', tone: 'neutral', icon: 'file', hint: 'From a public directory. Says what a hospital offers, not what is free now.' };
    case 'HOSPITAL_CONFIRMED':
      return { label: 'Hospital confirmed', tone: 'ok', icon: 'shield' };
    case 'AUTHORIZED_FEED':
      return { label: 'Authorised feed', tone: 'ok', icon: 'shield' };
    case 'HISTORICAL':
      return { label: 'Historical', tone: 'neutral', icon: 'clock' };
    case 'UNVERIFIED':
      return { label: 'Unverified', tone: 'warn', icon: 'alertTriangle' };
    default:
      return { label: 'Unknown source', tone: 'neutral', icon: 'help' };
  }
}
