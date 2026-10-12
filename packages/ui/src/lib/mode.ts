import { useEffect, useState } from 'react';

/**
 * The server's data mode (GET /api/health → `mode`). DEMO: everything shown is synthetic and labelled.
 * OPERATIONAL: only authenticated users and authoritative sources. Screens never assume operational
 * mode: until the server confirms it, they keep the demo label.
 */
export type RuntimeModeName = 'DEMO' | 'OPERATIONAL';

const requests = new Map<string, Promise<RuntimeModeName | null>>();

export function fetchRuntimeMode(apiUrl: string): Promise<RuntimeModeName | null> {
  let p = requests.get(apiUrl);
  if (!p) {
    p = fetch(`${apiUrl}/api/health`)
      .then((r) => r.json() as Promise<{ mode?: string }>)
      .then((h) => (h.mode === 'OPERATIONAL' || h.mode === 'DEMO' ? h.mode : null))
      .catch(() => null);
    requests.set(apiUrl, p);
    // A failed check is retried on the next mount.
    void p.then((m) => {
      if (m === null) requests.delete(apiUrl);
    });
  }
  return p;
}

export function useRuntimeMode(apiUrl: string): RuntimeModeName | null {
  const [mode, setMode] = useState<RuntimeModeName | null>(null);
  useEffect(() => {
    let live = true;
    void fetchRuntimeMode(apiUrl).then((m) => {
      if (live) setMode(m);
    });
    return () => {
      live = false;
    };
  }, [apiUrl]);
  return mode;
}
