import type { EtaEvidence, FeasibilitySnapshot, UnknownFact } from '@jiva/domain-models';
import type { MappingProvider } from '@jiva/mapping';

/**
 * Fills snapshot.transport.etaByHospital for the given hospitals only (Stage A survivors).
 * Mapping receives coordinates only — never capability, acceptance or clinical data — and its
 * output can only order candidates. A failed route is an explicit UnknownFact, never ETA 0 (D1).
 */
export async function enrichTransport(
  snapshot: FeasibilitySnapshot,
  hospitalIds: string[],
  provider: MappingProvider
): Promise<FeasibilitySnapshot> {
  const origin = snapshot.transport.origin?.value;
  const etaByHospital: Record<string, EtaEvidence | UnknownFact> = { ...snapshot.transport.etaByHospital };

  await Promise.all(hospitalIds.map(async id => {
    const h = snapshot.candidates.find(c => c.hospitalId === id);
    if (!origin) {
      etaByHospital[id] = { status: 'UNKNOWN', reasonCode: 'NO_ORIGIN', detail: 'No origin location for this case.' };
      return;
    }
    if (!h?.location) {
      etaByHospital[id] = { status: 'UNKNOWN', reasonCode: 'NO_LOCATION', detail: 'Facility has no coordinates.' };
      return;
    }
    try {
      const route = await provider.calculateRoute({
        origin,
        destination: { latitude: h.location.value.latitude, longitude: h.location.value.longitude },
        travelMode: 'DRIVING',
      });
      if (!Number.isFinite(route.durationSeconds) || !Number.isFinite(route.distanceMeters)) {
        etaByHospital[id] = { status: 'UNKNOWN', reasonCode: 'ROUTE_FAILED', detail: 'Provider returned a non-numeric route.' };
        return;
      }
      etaByHospital[id] = {
        durationSeconds: route.durationSeconds,
        distanceMeters: route.distanceMeters,
        provider: route.provider || 'unknown',
        synthetic: route.synthetic ?? route.sourceType === 'synthetic',
        trafficAware: route.trafficAware ?? false,
        calculatedAt: route.calculatedAt || snapshot.evaluatedAt,
      };
    } catch (err) {
      etaByHospital[id] = {
        status: 'UNKNOWN',
        reasonCode: 'ROUTE_FAILED',
        detail: `Route calculation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }));

  return { ...snapshot, transport: { ...snapshot.transport, etaByHospital } };
}
