/**
 * Classifies shadow disagreements from GET /api/feasibility/shadow so simulation output never
 * lumps a KNOWN, INTENTIONAL divergence together with a genuinely unexpected one.
 *
 * Known intentional divergence (documented, not fixed on purpose): legacy still accepts a LIMITED
 * response that does not cover every required capability (e.g. LIMITED without ICU); the Care
 * Feasibility Engine correctly marks that hospital INELIGIBLE (HC-ACC-03: LIMITED_MISSING_CAPABILITY).
 * This is legacy D1/D7-class frozen behaviour (see docs/claude-01-care-feasibility-design.md) and is
 * expected to keep appearing in shadow mode. Nothing here suppresses or hides a disagreement count —
 * it only labels which bucket each one falls into.
 */
export interface ShadowDisagreement {
  kind: 'VERDICT' | 'SELECTION';
  hospitalId?: string;
  legacy: string;
  engine: string;
  engineReasons: string[];
}

export type Classified = ShadowDisagreement & { classification: 'KNOWN_EXPECTED_SHADOW_DIVERGENCE' | 'UNEXPECTED_DISAGREEMENT' };

const KNOWN_REASON = 'LIMITED_MISSING_CAPABILITY';

export function classifyDisagreements(all: ShadowDisagreement[]): Classified[] {
  const knownHospitals = new Set(
    all.filter(d => d.kind === 'VERDICT' && d.engineReasons.includes(KNOWN_REASON)).map(d => d.hospitalId)
  );
  return all.map(d => {
    const known = (d.kind === 'VERDICT' && d.engineReasons.includes(KNOWN_REASON)) ||
      (d.kind === 'SELECTION' && knownHospitals.has(d.legacy));
    return { ...d, classification: known ? 'KNOWN_EXPECTED_SHADOW_DIVERGENCE' : 'UNEXPECTED_DISAGREEMENT' };
  });
}

/** Fetch, classify and print. Returns the count of UNEXPECTED disagreements (0 = clean). */
export async function reportShadowDisagreements(apiBase: string, persona = 'demo-mgmt-1'): Promise<number> {
  const base = apiBase.replace(/\/$/, '').replace(/\/api(\/events)?$/, '');
  const res = await fetch(`${base}/api/feasibility/shadow`, { headers: { 'x-jiva-demo-user': persona } });
  if (!res.ok) {
    console.log(`[Shadow] could not read /api/feasibility/shadow (HTTP ${res.status}); skipping disagreement report.`);
    return 0;
  }
  const body = await res.json();
  const classified = classifyDisagreements(body.disagreements as ShadowDisagreement[]);
  const known = classified.filter(d => d.classification === 'KNOWN_EXPECTED_SHADOW_DIVERGENCE');
  const unexpected = classified.filter(d => d.classification === 'UNEXPECTED_DISAGREEMENT');
  console.log(`\n[Shadow] mode=${body.mode} traces=${body.traces.length} disagreements=${classified.length} (known-expected=${known.length}, unexpected=${unexpected.length}) shadow-failures=${body.failures?.length ?? 0}`);
  for (const d of known) console.log(`  KNOWN_EXPECTED_SHADOW_DIVERGENCE  ${d.kind} ${d.hospitalId ?? d.legacy} legacy=${d.legacy} engine=${d.engine} [${d.engineReasons.join(',')}]`);
  for (const d of unexpected) console.log(`  UNEXPECTED_DISAGREEMENT           ${d.kind} ${d.hospitalId ?? d.legacy} legacy=${d.legacy} engine=${d.engine} [${d.engineReasons.join(',')}]`);
  return unexpected.length;
}
