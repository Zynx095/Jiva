# JIVA — Mapping & Routing Architecture (MapLibre + OpenStreetMap + Valhalla / OSRM)

**Platform Status:** HACKATHON DEMO READY / PROTOTYPE READY  
**Component:** Open-Source Mapping, Geocoding & Road-Network Routing Stack  
**License Compliance:** OpenStreetMap Attribution (`© OpenStreetMap contributors`), MapLibre GL JS (BSD 3-Clause)

---

## 1. Executive Summary

JIVA has transitioned from proprietary, vendor-locked mapping (Google Maps Platform) to a fully open, sovereign, self-hostable mapping and routing stack:
- **Map Rendering:** [MapLibre GL JS](https://maplibre.org/)
- **Map Data & Tiles:** [OpenStreetMap](https://www.openstreetmap.org/)
- **Primary Routing Engine:** [Valhalla](https://github.com/valhalla/valhalla) (multimodal routing, dynamic costing)
- **Secondary / Fallback Router:** [OSRM](http://project-osrm.org/) (high-performance road routing)
- **Offline / Zero-Config Demo Fallback:** `MockMappingProvider` (deterministic Bengaluru road corridors)

This architecture guarantees:
1. **Zero Vendor Lock-In & Zero API Key Hurdles:** The entire platform boots and runs out of the box without requiring credit cards, Google Cloud project setups, or proprietary API keys.
2. **Offline Resilience:** For hackathon judging and field operations in disconnected environments, `MockMappingProvider` deterministically generates road corridors and navigation lines.
3. **Data Sovereignty & Predictable Cost:** Public health agencies and emergency services can host their own routing infrastructure within sovereign cloud environments (e.g. AWS GovCloud, self-hosted Kubernetes).
4. **Honest Traffic & Provenance Disclosures:** Every route calculation explicitly declares its `provider`, `sourceType`, `synthetic`, and `trafficAware` status.

---

## 2. Architectural Boundaries & Non-Authority Principle

```
+-------------------------------------------------------------+
|                      JIVA Core Engine                       |
|                                                             |
|  [Clinical Eligibility] ---> [Hospital Acceptance Protocol] |
|           |                                 |               |
|           v                                 v               |
|  Verified Hospitals             Hospital State (ACCEPTED)   |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|               @jiva/mapping (Routing Stack)                 |
|                                                             |
|  +-------------------------------------------------------+  |
|  |             createMappingProvider(config)             |  |
|  |               (FallbackMappingProvider)               |  |
|  +-------------------------------------------------------+  |
|            |                        |                 |     |
|            v (Primary)              v (Secondary)     v (3rd)
|    [Valhalla :8002]          [OSRM :5000]       [Mock]      |
|                                                             |
|  Outputs: distanceMeters, durationSeconds, coordinates, ETA |
+-------------------------------------------------------------+
```

### Strict System Invariant:
**The mapping provider has ZERO clinical decision-making authority.**  
1. Mapping engines **never** decide which hospital is appropriate for a patient.
2. Clinical suitability is determined **solely** by `eligibilityEngine.ts` matching structured `CareRequirements` against verified hospital capabilities.
3. The mapping engine only calculates road distance, estimated travel duration, and polyline/coordinate geometry between two predetermined geographic coordinates.

---

## 3. Canonical Route Result Model

All routing providers implement the canonical `MappingProvider` contract and return the standardized `RouteResult` model:

```typescript
export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  polyline?: string;               // Encoded polyline (precision 5 or 6)
  coordinates?: [number, number][]; // GeoJSON [longitude, latitude] coordinates
  legs?: {
    start: GeoPoint;
    end: GeoPoint;
    distanceMeters: number;
    durationSeconds: number;
  }[];
  provider: 'valhalla' | 'osrm' | 'mock';
  sourceType: 'osm' | 'synthetic';
  synthetic: boolean;
  calculatedAt: string;            // ISO 8601 timestamp
  trafficAware: boolean;           // Always false for OSM/Valhalla unless real telemetry attached
}
```

### Coordinate Order Specification:
- **MapLibre GL JS & GeoJSON:** Standardizes on `[longitude, latitude]`.
- **Domain Models & Events:** Standardizes on `{ latitude: number, longitude: number }`.
- `@jiva/mapping` cleanly translates between domain points and GeoJSON arrays without coordinate inversion.

---

## 4. Provider Hierarchy & Failover Mechanics

When `MAPPING_PROVIDER=auto` is set (the system default):
1. **Primary: Valhalla (`http://localhost:8002`)**  
   Queries `/route` with costing parameter `auto`. Decodes precision-6 polyline `shape` into GeoJSON coordinates.
2. **Secondary: OSRM (`http://localhost:5000`)**  
   If Valhalla is unreachable or times out (5000ms), JIVA automatically shifts to OSRM `/route/v1/driving/...` with `geometries=geojson`.
3. **Tertiary: MockMappingProvider (Guaranteed Offline)**  
   If OSRM is also offline or in air-gapped demo environments, JIVA automatically falls back to deterministic Bengaluru corridor interpolation.
4. **Structured Fallback Logging:**  
   Every failover publishes a structured observable warning event:
   ```json
   {
     "event": "mapping.provider.fallback",
     "from": "valhalla",
     "to": "osrm",
     "reason": "fetch failed",
     "timestamp": "2026-09-26T12:00:00.000Z"
   }
   ```

---

## 5. Frontend Map Rendering (MapLibre GL JS + OSM)

Both `apps/management-web` and `apps/ambulance-web` use the unified `<JivaMap>` component:
- **Tile Source:** OpenStreetMap Standard raster tiles (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`).
- **Attribution Requirement:** Displays visible OSM attribution: `© OpenStreetMap contributors` with valid links.
- **Provider HUD Badge:** The map badge shows the provider of the displayed route (`VALHALLA`, `OSRM`, or synthetic/mock) and "no live traffic"; the command-center header shows the provider that actually answered the last route (`/api/health` → `components.mapping.activeProvider`, `fallbackActive`, `lastFallbackReason`).
- **Verification status:** Mock provider and fallback chain verified at runtime (refused, hung and malformed providers). Real Valhalla/OSRM servers have **not** been run in the audited environment (no Docker); their response parsing is covered by fixture tests only.
- **Dynamic GeoJSON Route Layers:**
  - Primary Route Line: `#10B981` (Emerald) with dark casing for maximum contrast.
  - Alternative Routes: `#6B7280` (Muted gray) dashed lines.
- **Animated Markers:**
  - `<AmbulanceMarker>`: Uses `marker.setLngLat([lng, lat])` for GPU-accelerated telemetry interpolation without DOM re-creation.
  - `<HospitalMarker>`: Status-colored SVG teardrop pins (`ACCEPTED` emerald, `LIMITED` amber, `REJECTED`/`UNAVAILABLE` red, `UNKNOWN` blue) with interactive popups.

---

## 6. Telemetry Decoupling & High-Frequency GPS Ingestion

To prevent routing engine exhaustion during high-frequency GPS telemetry streaming:
1. `ambulance.location.updated` updates the vehicle coordinate and heading in `ambulancesStore`.
2. **Route recalculation is strictly decoupled from raw GPS ticks.**
3. Route recalculation occurs **only** when:
   - A destination hospital changes (`destination.changed`)
   - A hospital capacity state becomes saturated or unavailable (`hospital.capacity.updated`)
   - An acceptance times out (`hospital.acceptance.expired`)
   - An explicit reroute command is issued by a clinical coordinator

---

## 7. Self-Hosted Infrastructure Setup

To spin up local Valhalla and OSRM routing containers:
```bash
cd infrastructure/local/mapping

# Download OSM extract (Southern India / Karnataka)
curl -o valhalla_tiles/southern-zone-latest.osm.pbf https://download.geofabrik.de/asia/india/southern-zone-latest.osm.pbf

# Start Valhalla
docker compose up -d valhalla
```

### Environment Configuration (.env):
```bash
# Mapping Provider: 'auto', 'valhalla', 'osrm', or 'mock'
MAPPING_PROVIDER=auto

# Self-Hosted Valhalla Endpoint
VALHALLA_BASE_URL=http://localhost:8002

# Self-Hosted OSRM Endpoint
OSRM_BASE_URL=http://localhost:5000

# Mapping Request Timeout (ms)
MAPPING_TIMEOUT_MS=5000
```

---

## 8. Verification & Test Coverage

All mapping functionality is verified via automated tests:
- `npm run test:unit`: Tests polyline precision decoding, response parsing, provider metadata, and fallback chain execution.
- `npm run test:integration`: Tests end-to-end integration between `createMappingProvider()`, `evaluateHospitals()`, and `calculateBestHospitals()`.
- `npm run simulate:mapping:blr`: Demonstrates live Bengaluru corridor route generation, GeoJSON coordinate extraction, and simulated ambulance movement.
- `npm run demo:check`: Confirms mapping subsystem readiness for hackathon demonstration.
