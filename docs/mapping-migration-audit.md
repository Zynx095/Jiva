# JIVA — Mapping Provider Replacement Audit
**Target:** Google Maps → MapLibre GL JS + OpenStreetMap + Valhalla / OSRM  
**Architecture Status:** FROZEN — Implementation Only  
**Audit Date:** September 2026  

---

## 1. Current Mapping Architecture

JIVA currently abstracts mapping through a clean boundary interface (`MappingProvider` in `@jiva/mapping`). The architecture separates clinical decision-making from geographic routing:
- **Decision Engine (Clinical):** Determines which hospital is capable and appropriate for the patient (`eligibilityEngine.ts`, `HospitalAcceptanceProtocol`).
- **Mapping Engine (Geospatial):** Answers "How do we travel from origin to destination and what is the estimated distance/ETA?"
- **Visualization (Frontend):** Renders markers and vehicle telemetry on a map canvas.

```
       Emergency Lifecycle & Clinician Acceptance
                          │
                          ▼
            JIVA Deterministic Routing Engine
                          │
                          ▼
                   MappingProvider
                   ┌──────┴──────┐
                   ▼             ▼
          GoogleMapsProvider   MockMappingProvider (Bengaluru corridors)
```

---

## 2. Inventory of Google Maps Dependencies

### 2.1 NPM Packages
- `@vis.gl/react-google-maps`: Declared in:
  - `packages/ui/package.json` (`^1.5.0`)
  - `apps/management-web/package.json` (`^1.10.1`)
  - `apps/ambulance-web/package.json` (`^1.10.1`)

### 2.2 Source Files & Components
- `packages/mapping/src/providers/GoogleMapsProvider.ts`:
  - Direct HTTP calls to `https://routes.googleapis.com/directions/v2:computeRoutes` (Routes API v2).
  - Direct HTTP calls to `https://maps.googleapis.com/maps/api/geocode/json` (Geocoding API).
- `packages/ui/src/Map/JivaMap.tsx`:
  - Wraps `<APIProvider apiKey={...}>` and `<Map mapId={...}>` from `@vis.gl/react-google-maps`.
- `packages/ui/src/Map/AmbulanceMarker.tsx`:
  - Uses `<AdvancedMarker>` from `@vis.gl/react-google-maps`.
- `packages/ui/src/Map/HospitalMarker.tsx`:
  - Uses `<AdvancedMarker>` and `<Pin>` from `@vis.gl/react-google-maps`.
- `apps/management-web/src/App.tsx`:
  - Imports `JivaMap`, `HospitalMarker`, `AmbulanceMarker`, and reads `VITE_GOOGLE_MAPS_API_KEY`.
- `apps/ambulance-web/src/App.tsx`:
  - Imports `JivaMap`, `HospitalMarker`, `AmbulanceMarker`, and reads `VITE_GOOGLE_MAPS_API_KEY`.
- `services/api/src/stateEngines.ts`:
  - Instantiates `GoogleMapsProvider(googleApiKey)` when key is configured.
- `services/api/src/infrastructure/factory.ts`:
  - Instantiates `GoogleMapsProvider` in infrastructure bundle.
- `services/api/src/lambdas/hospitalAcceptanceProcessor.ts`:
  - Instantiates `GoogleMapsProvider` for AWS Lambda execution.

### 2.3 Environment Variables
- `VITE_GOOGLE_MAPS_API_KEY`: Client-side rendering key for web applications.
- `VITE_GOOGLE_MAPS_MAP_ID`: Map ID for Cloud-styled maps / `DEMO_MAP_ID`.
- `GOOGLE_MAPS_SERVER_KEY`: Server-side API key for Routes API.
- `ENABLE_GOOGLE_MAPS`: Toggle flag in `packages/config`.

---

## 3. Consumers of `MappingProvider`

| Consumer | Location | Method Invoked | Purpose |
| :--- | :--- | :--- | :--- |
| `eligibilityEngine.ts` | `services/api/src/eligibilityEngine.ts` | `calculateRoute()` | Computes distance (km) and ETA (minutes) to rank clinically eligible candidate hospitals. |
| `stateEngines.ts` | `services/api/src/stateEngines.ts` | `calculateRoute()` | Calculates initial route when hospital accepts; recalculates route when hospital becomes unavailable. |
| `hospitalAcceptanceProcessor.ts` | `services/api/src/lambdas/hospitalAcceptanceProcessor.ts` | `calculateRoute()` | Calculates route on acceptance in AWS Lambda. |
| `factory.ts` | `services/api/src/infrastructure/factory.ts` | Provider instantiation | Bundles `mappingProvider` into the infrastructure container. |
| `parity.test.ts` | `tests/integration/parity.test.ts` | `calculateRoute()` (via engine) | Integration test verifying candidate scoring. |
| `security-prompt-injection.test.ts` | `tests/unit/security-prompt-injection.test.ts` | `calculateRoute()` (via engine) | Unit test validating prompt injection resistance during eligibility. |

---

## 4. Current Route Request & Response Contract

### 4.1 Request Contract (`RouteRequest`)
```typescript
export interface RouteRequest {
  origin: GeoPoint;
  destination: GeoPoint;
  waypoints?: GeoPoint[];
  travelMode: 'DRIVING';
}
```

### 4.2 Response Contract (`RouteResult`)
```typescript
export interface RouteLeg {
  start: GeoPoint;
  end: GeoPoint;
  distanceMeters: number;
  durationSeconds: number;
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  polyline?: string;
  legs: RouteLeg[];
  // Metadata to be added:
  provider?: 'valhalla' | 'osrm' | 'mock';
  sourceType?: 'osm' | 'synthetic';
  synthetic?: boolean;
  calculatedAt?: string;
  alternatives?: RouteResult[];
}
```

---

## 5. Frontend Map Responsibilities
- **Render Canvas:** Initialize map centered on Bengaluru (`12.9716, 77.5946`) with pan, zoom, and responsive resizing.
- **Marker Layering:** Display ambulance positions with status badges, hospital locations with acceptance color coding (`ACCEPTED`, `LIMITED`, `REJECTED`, `UNAVAILABLE`, `UNKNOWN`), and patient emergency coordinates.
- **Polyline Layering:** Render active driving route geometry from ambulance origin to designated hospital, updating cleanly on reroute.
- **Attribution Display:** Display mandatory OpenStreetMap attribution (`© OpenStreetMap contributors`).
- **Telemetry Updates:** Smoothly update marker positions upon receiving `ambulance.location.updated` without remounting or resetting camera bounds.
- **Source Indicator:** Clearly display route provider status (`Valhalla / OSM`, `OSRM`, or `DEMO ROUTE — Synthetic`).

---

## 6. Backend Routing Responsibilities
- **Road-Network Calculation:** Request driving route geometry, road distance (meters), and estimated duration (seconds) from the active provider.
- **Fault-Tolerant Resolution:** Execute provider chain: **Valhalla → OSRM → MockMappingProvider**.
- **Performance & Decoupling:** Decouple GPS telemetry ticks from route recalculations (recalculate only when destination changes, route invalidates, or significant threshold is reached).
- **Audit Logging:** Log provider fallback events with structured causal details.

---

## 7. What Will Change
1. **Frontend Rendering:** Replace `@vis.gl/react-google-maps` with `maplibre-gl` in `@jiva/ui` (`JivaMap.tsx`, `HospitalMarker.tsx`, `AmbulanceMarker.tsx`).
2. **Tile Layer:** Use OpenStreetMap tile layers with compliant attribution.
3. **Routing Providers:**
   - Add `ValhallaMappingProvider` (targeting `VALHALLA_BASE_URL`, default `http://localhost:8002`).
   - Add `OSRMMappingProvider` (targeting `OSRM_BASE_URL`, default `http://localhost:5000`).
   - Implement `createMappingProvider()` factory with auto-fallback.
4. **Local Self-Hosting Config:** Create `infrastructure/local/mapping/docker-compose.yml` for local Valhalla deployment.
5. **Route Metadata:** Attach provider transparency metadata (`provider`, `sourceType`, `synthetic`).
6. **Tests:** Add tests for Valhalla parsing, OSRM parsing, provider fallback, and parity.
7. **Package Cleanup:** Completely remove `@vis.gl/react-google-maps` and Google Maps API keys from `.env` and runtime configurations.

---

## 8. What Must NOT Change
- ❌ **NO change to Clinical Eligibility Engine (`eligibilityEngine.ts`)**: Capability matching and clinical scoring remain 100% deterministic.
- ❌ **NO change to Hospital Acceptance Protocol**: Ephemeral timers, clinician response states (`ACCEPTED`, `LIMITED`, `REJECTED`, `UNAVAILABLE`, `EXPIRED`, `UNKNOWN`) remain unchanged.
- ❌ **NO change to State Engines**: `EmergencyStateEngine`, `AmbulanceStateEngine`, `HospitalStateEngine` maintain identical event transitions.
- ❌ **NO change to Event Schema**: Canonical event names (`ambulance.location.updated`, `destination.changed`, `route.recalculated`, etc.) remain identical.
- ❌ **NO change to AI Safety Boundaries**: Bedrock AI retains zero authority over routing or dispatch.
- ❌ **NO change to Offline Capability**: `MockMappingProvider` remains 100% functional for offline hackathon demos.
