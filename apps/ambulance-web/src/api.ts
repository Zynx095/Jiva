import { io } from 'socket.io-client';

/**
 * DEMO-ONLY authentication: this app acts as a fixed demo persona. The API enforces
 * that persona's role and scope server-side. Override with ?as=<personaId> or
 * VITE_DEMO_PERSONA. Production would use Cognito tokens instead.
 */
export const API_URL: string = import.meta.env.VITE_API_URL || 'http://localhost:4000';
export const PERSONA: string =
  new URLSearchParams(window.location.search).get('as') || import.meta.env.VITE_DEMO_PERSONA || 'demo-amb-1';

const headers = (extra: Record<string, string> = {}) => ({ 'x-jiva-demo-user': PERSONA, ...extra });

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(API_URL + path, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPost(path: string, body?: unknown, persona = PERSONA): Promise<Response> {
  return fetch(API_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jiva-demo-user': persona },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const socket = io(API_URL, { auth: { demoUser: PERSONA } });

export interface CommandResponse<T = Record<string, unknown>> {
  status: number;
  body: T & { error?: string; message?: string; issues?: Array<{ path: string; message: string }> };
}

/**
 * POST a command and return the status and JSON body. Throws only when JIVA could not be reached, so
 * callers can tell "rejected" from "maybe not delivered" (retry with the same clientRequestId is safe).
 */
export async function postCommand<T = Record<string, unknown>>(path: string, body: unknown): Promise<CommandResponse<T>> {
  const res = await apiPost(path, body);
  const json = (await res.json().catch(() => ({}))) as CommandResponse<T>['body'];
  return { status: res.status, body: json };
}

export interface Point {
  latitude: number;
  longitude: number;
}

/**
 * Send this unit's position, set by the crew. JIVA receives no GPS from the ambulance, so the crew updates
 * the position when it moves; it is recorded with source MANUAL and shown as "Set by the crew" everywhere.
 * It goes through the same event API and authorization as any position update.
 */
export async function sendManualPosition(ambulanceId: string, p: Point): Promise<string | null> {
  const r = await postCommand('/api/events', {
    eventId: crypto.randomUUID(),
    eventType: 'ambulance.location.updated',
    timestamp: new Date().toISOString(),
    version: '1.0',
    source: { type: 'ambulance', id: ambulanceId },
    payload: { ambulanceId, coordinates: { latitude: p.latitude, longitude: p.longitude }, source: 'MANUAL' },
  }).catch(() => null);
  if (!r) return 'Cannot reach JIVA. The position was not sent — try again.';
  if (r.status === 202 || r.status === 200) return null;
  return r.body.message ?? r.body.error ?? `JIVA refused the position (${r.status}).`;
}
