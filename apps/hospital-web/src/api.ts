import { io } from 'socket.io-client';

/**
 * DEMO-ONLY authentication: this app acts as a fixed demo persona. The API enforces
 * that persona's role and scope server-side. Override with ?as=<personaId> or
 * VITE_DEMO_PERSONA. Production would use Cognito tokens instead.
 */
export const API_URL: string = import.meta.env.VITE_API_URL || 'http://localhost:4000';
export const PERSONA: string =
  new URLSearchParams(window.location.search).get('as') || import.meta.env.VITE_DEMO_PERSONA || 'demo-hosp-1';

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

/** Submits an event as this persona. Resolves to null on success, or a sentence explaining the failure. */
export async function sendEvent(event: Record<string, unknown>): Promise<string | null> {
  try {
    const res = await apiPost('/api/events', event);
    if (res.ok) return null;
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) return 'This request is no longer open — it may have expired, been answered already, or been withdrawn.';
    if (res.status === 403) return `Not allowed: ${body.message || 'this persona cannot act for this hospital'}.`;
    return body.message || body.error || `The API rejected the update (${res.status}).`;
  } catch {
    return 'Cannot reach the JIVA API. Check the connection and try again.';
  }
}
