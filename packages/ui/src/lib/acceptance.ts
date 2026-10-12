import type { JivaEvent } from './events';

/** A hospital's state for one case, replayed from acceptance-protocol events. */
export type CaseResponseStatus = 'PENDING' | 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'UNAVAILABLE' | 'EXPIRED' | 'UNANSWERED' | 'CANCELLED';

export interface CaseResponse {
  hospitalId: string;
  status: CaseResponseStatus;
  requestedAt?: string;
  answerBy?: string;
  respondedAt?: string;
  validUntil?: string;
  limitations: string[];
  cancelReason?: string;
  etaMinutes?: number;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Replays the acceptance protocol (oldest → newest) into per-case, per-hospital state.
 * Display only: the engines decide; this explains what they decided on.
 */
export function caseResponses(eventsNewestFirst: JivaEvent[]): Map<string, Map<string, CaseResponse>> {
  const out = new Map<string, Map<string, CaseResponse>>();
  const slot = (caseId: string) => {
    let m = out.get(caseId);
    if (!m) out.set(caseId, (m = new Map()));
    return m;
  };
  for (let i = eventsNewestFirst.length - 1; i >= 0; i--) {
    const e = eventsNewestFirst[i];
    const p = e.payload;
    const caseId = str(p.caseId);
    const hospitalId = str(p.hospitalId);
    switch (e.eventType) {
      case 'hospital.acceptance.requested':
        if (caseId && hospitalId) {
          slot(caseId).set(hospitalId, {
            hospitalId,
            status: 'PENDING',
            requestedAt: str(p.requestedAt) ?? e.timestamp,
            answerBy: str(p.expiresAt),
            etaMinutes: typeof p.ambulanceEtaMinutes === 'number' ? p.ambulanceEtaMinutes : undefined,
            limitations: [],
          });
        }
        break;
      case 'hospital.acceptance.received':
        if (caseId && hospitalId) {
          const m = slot(caseId);
          const prev = m.get(hospitalId);
          const status = str(p.status);
          m.set(hospitalId, {
            ...(prev ?? { hospitalId, limitations: [] }),
            status: status === 'ACCEPTED' || status === 'LIMITED' || status === 'REJECTED' || status === 'UNAVAILABLE' ? status : 'PENDING',
            respondedAt: str(p.respondedAt) ?? e.timestamp,
            validUntil: str(p.validUntil),
            limitations: strs(p.limitations),
            cancelReason: undefined,
          });
        }
        break;
      case 'hospital.acceptance.cancelled':
        if (caseId && hospitalId) {
          const m = slot(caseId);
          const prev = m.get(hospitalId);
          if (prev) m.set(hospitalId, { ...prev, status: prev.status === 'PENDING' ? 'CANCELLED' : prev.status, cancelReason: str(p.reason) });
        }
        break;
      case 'hospital.acceptance.expired': {
        if (!hospitalId) break;
        const kind = str(p.kind);
        if (caseId) {
          // Case-scoped: this case's answer lapsed, or its referral closed without an answer.
          const m = slot(caseId);
          const prev = m.get(hospitalId);
          if (prev && kind === 'REQUEST_UNANSWERED' && prev.status === 'PENDING') m.set(hospitalId, { ...prev, status: 'UNANSWERED' });
          else if (prev && kind !== 'REQUEST_UNANSWERED' && (prev.status === 'ACCEPTED' || prev.status === 'LIMITED')) m.set(hospitalId, { ...prev, status: 'EXPIRED' });
          break;
        }
        // Older events carry no case id: they expired the hospital's current answer for every case.
        for (const m of out.values()) {
          const prev = m.get(hospitalId);
          if (prev && (prev.status === 'ACCEPTED' || prev.status === 'LIMITED')) m.set(hospitalId, { ...prev, status: 'EXPIRED' });
        }
        break;
      }
    }
  }
  return out;
}

/** A request is awaiting an answer only while it is unanswered, not withdrawn, and not past its deadline. */
export const isAwaiting = (r: CaseResponse, now: number) => r.status === 'PENDING' && (!r.answerBy || Date.parse(r.answerBy) > now);
