import { io } from 'socket.io-client';

/**
 * The demo portal talks to the same JIVA API as the operational apps, and every call names the demo persona
 * it acts as (a crew, a hospital coordinator, a clinician, the demo administrator). The API applies that
 * persona's normal authorization to each call: the portal has no special access and fabricates nothing.
 * Demo personas exist only while the API runs in DEMO mode, and only for this machine.
 */
export const API_URL: string = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export interface CallResult<T = unknown> {
  status: number;
  ok: boolean;
  body: T & { error?: string; message?: string; issues?: Array<{ path: string; message: string }> };
}

/** One API call as `persona`. Throws only when JIVA cannot be reached. */
export async function call<T = unknown>(persona: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<CallResult<T>> {
  const res = await fetch(API_URL + path, {
    method,
    headers: { 'x-jiva-demo-user': persona, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as CallResult<T>['body'];
  return { status: res.status, ok: res.ok, body: json };
}

/** A protected file (sample preview) as `persona`. */
export async function blob(persona: string, path: string): Promise<Blob> {
  const res = await fetch(API_URL + path, { headers: { 'x-jiva-demo-user': persona } });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.blob();
}

/** One sentence for a failed call, from the server's own answer. */
export function failure(r: CallResult): string {
  if (r.status === 400) return r.body.issues?.map((i) => `${i.path}: ${i.message}`).join('; ') || 'The request was not valid.';
  return `${r.status} ${r.body.error ?? ''}${r.body.message ? ` — ${r.body.message}` : ''}`.trim();
}

/** The portal listens as the demo administrator: operational events and the demo reset (never clinical content). */
export const socket = io(API_URL, { auth: { demoUser: 'demo-admin' } });
