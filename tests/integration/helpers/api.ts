/**
 * Helpers for runtime integration suites: start a REAL API process (mock mapping, demo personas) and
 * talk to it over HTTP and Socket.IO exactly as the apps do.
 */
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { randomUUID } from 'crypto';
import { io, type Socket } from 'socket.io-client';

export const ROOT = path.resolve(__dirname, '../../..');
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const uuid = () => randomUUID();

let failures = 0;
let passes = 0;
export function check(name: string, cond: boolean, detail = '') {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name} ${detail}`); }
}
export const results = () => ({ passes, failures });

export interface ApiResponse { status: number; json: any; text: string; body: Buffer; headers: Headers }

export interface Api {
  url: string;
  req(method: string, p: string, persona?: string, body?: unknown, extra?: { raw?: string | Buffer; headers?: Record<string, string> }): Promise<ApiResponse>;
  get(persona: string | undefined, p: string): Promise<ApiResponse>;
  post(persona: string | undefined, p: string, body?: unknown): Promise<ApiResponse>;
  event(persona: string | undefined, e: unknown): Promise<ApiResponse>;
  socket(persona?: string): Promise<{ s: Socket; events: any[]; error?: string }>;
  waitFor(fn: () => Promise<boolean>, ms?: number): Promise<boolean>;
  log(): string;
  stop(): void;
}

export async function startApi(port: number, env: Record<string, string> = {}): Promise<Api> {
  const url = `http://localhost:${port}`;
  const child: ChildProcess = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'services/api/src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), MAPPING_PROVIDER: 'mock', ACCEPTANCE_EXPIRY_CHECK_MS: '300', USE_BEDROCK: 'false', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', d => { log += d; });
  child.stderr?.on('data', d => { log += d; });

  const req: Api['req'] = async (method, p, persona, body, extra = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(extra.headers || {}) };
    if (persona) headers['x-jiva-demo-user'] = persona;
    const res = await fetch(url + p, {
      method,
      headers,
      body: extra.raw !== undefined ? (extra.raw as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let json: any;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, body: buf, headers: res.headers };
  };
  const waitFor: Api['waitFor'] = async (fn, ms = 8000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      try { if (await fn()) return true; } catch { /* retry */ }
      await sleep(100);
    }
    return false;
  };
  const api: Api = {
    url,
    req,
    get: (persona, p) => req('GET', p, persona),
    post: (persona, p, body) => req('POST', p, persona, body),
    event: (persona, e) => req('POST', '/api/events', persona, e),
    socket: (persona) => new Promise(resolve => {
      const events: any[] = [];
      const s = io(url, { auth: persona ? { demoUser: persona } : {}, reconnection: false, transports: ['websocket'] });
      s.on('event', e => events.push(e));
      s.on('connect', () => resolve({ s, events }));
      s.on('connect_error', err => resolve({ s, events, error: err.message }));
    }),
    waitFor,
    log: () => log,
    stop: () => { child.kill(); },
  };
  if (!(await waitFor(async () => (await req('GET', '/api/health')).status === 200, 30000))) {
    child.kill();
    throw new Error(`API did not start on :${port}\n${log.slice(-2000)}`);
  }
  return api;
}

/** A canonical event envelope. */
export const envelope = (eventType: string, payload: unknown, source: { type: string; id: string }, extra: Record<string, unknown> = {}) =>
  ({ eventId: uuid(), eventType, timestamp: new Date().toISOString(), version: '1.0', source, payload, ...extra });
