import { capabilityLabel, joinList } from './labels';
import { capabilityStatus } from './status';
import { formatClock, timeAgo, timeUntil } from './time';

/**
 * Client view of GET /api/cases/:id/referrals. Four kinds of information per connected hospital, kept
 * apart on screen as they are on the server: what the hospital LISTS, what JIVA ASSESSED, what the
 * hospital ANSWERED for this case, and what capacity it last REPORTED (and who reported it).
 */
export interface ReferralRow {
  hospitalId: string;
  name: string;
  dataStatus: string;
  listed: { listedRequired: string[]; missingRequired: string[] };
  assessment?: { eligibility: string; reason: string; etaMinutes?: number; distanceKm?: number; evaluatedAt: string };
  referral: { state: 'NOT_REQUESTED' | 'OUTSTANDING' | 'EXPIRED' | 'CANCELLED'; requestId?: string; requestedAt?: string; expiresAt?: string; cancelledAt?: string };
  answer?: { responseId: string; requestId: string; status: string; respondedAt: string; validUntil: string; current: boolean; limitations: string[]; provenance: string };
  capacity: { emergency: string; icu: string; trauma: string; reportedAt?: string; provenance: string; verified: boolean };
}

export interface ReferralOverview {
  caseId: string;
  requiredCapabilities: string[];
  generatedAt: string;
  rows: ReferralRow[];
}

/** One status per hospital for this case: its explicit answer if it gave one, otherwise the referral's state. */
export function referralStatus(r: ReferralRow, now: number): string {
  if (r.answer) {
    const positive = r.answer.status === 'ACCEPTED' || r.answer.status === 'LIMITED';
    if (positive && !(r.answer.current && Date.parse(r.answer.validUntil) > now)) return 'EXPIRED';
    return r.answer.status;
  }
  if (r.referral.state === 'OUTSTANDING') return r.referral.expiresAt && Date.parse(r.referral.expiresAt) > now ? 'PENDING' : 'UNANSWERED';
  if (r.referral.state === 'EXPIRED') return 'UNANSWERED';
  if (r.referral.state === 'CANCELLED') return 'CANCELLED';
  return 'NOT_ASKED';
}

/** The answer (or why there is none), in one line. */
export function referralDetail(r: ReferralRow, now: number): string {
  const a = r.answer;
  if (a) {
    const lim = a.limitations.length ? ` · ${a.limitations.join('; ')}` : '';
    if (a.status === 'ACCEPTED' || a.status === 'LIMITED') {
      return `Answered ${formatClock(a.respondedAt)}${Date.parse(a.validUntil) > now && a.current ? ` · valid ${timeUntil(a.validUntil, now)}` : ' · no longer valid'}${lim}`;
    }
    return `Answered ${formatClock(a.respondedAt)}${lim}`;
  }
  switch (r.referral.state) {
    case 'OUTSTANDING':
      return r.referral.expiresAt && Date.parse(r.referral.expiresAt) > now ? `Asked ${formatClock(r.referral.requestedAt)} · answer due ${timeUntil(r.referral.expiresAt, now)}` : 'Asked · no answer in time';
    case 'EXPIRED':
      return 'Asked · no answer in time';
    case 'CANCELLED':
      return 'Request withdrawn';
    default:
      if (r.listed.missingRequired.length) return `Not asked: does not list ${joinList(r.listed.missingRequired.map((c) => capabilityLabel(c)))}`;
      if (r.capacity.emergency === 'UNAVAILABLE') return 'Not asked: emergency department reported unavailable';
      return 'Not asked for this case';
  }
}

const PROVENANCE_TEXT: Record<string, string> = {
  SEED: 'seed values, no report yet',
  SYNTHETIC_DEMO: 'demo report',
  HOSPITAL_CONFIRMED: 'confirmed by the hospital',
  AUTHORIZED_FEED: 'authorised hospital feed',
  UNVERIFIED: 'unverified report',
};

/** Reported capacity and who reported it — never presented as verified unless it is. */
export function capacityLine(r: ReferralRow, now: number): string {
  const c = r.capacity;
  const states = `ED ${capabilityStatus(c.emergency).label.toLowerCase()} · ICU ${capabilityStatus(c.icu).label.toLowerCase()} · trauma ${capabilityStatus(c.trauma).label.toLowerCase()}`;
  const who = PROVENANCE_TEXT[c.provenance] ?? c.provenance.toLowerCase();
  return `${states} — ${who}${c.reportedAt ? `, ${timeAgo(c.reportedAt, now)}` : ''}`;
}
