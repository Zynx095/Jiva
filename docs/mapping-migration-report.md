# JIVA — Mapping Provider Migration Report
**Migration:** Google Maps Platform → MapLibre GL JS + OpenStreetMap + Valhalla / OSRM  
**Date:** September 2026  
**Status:** COMPLETE & AUDITED  
**System Readiness:** HACKATHON DEMO READY / PROTOTYPE READY  

---

## 1. Migration Overview

The proprietary Google Maps dependency has been completely eliminated from the JIVA platform and replaced with an open, self-hostable, and sovereign mapping stack. The migration spans the entire monorepo—from frontend MapLibre rendering down to backend multi-tier routing failover.

| Subsystem | Previous State | New Migrated State |
|---|---|---|
| **Frontend Map Rendering** | `@vis.gl/react-google-maps` | `maplibre-gl` (MapLibre GL JS) |
| **Map Tiles & Geodata** | Google Maps JavaScript API (proprietary) | OpenStreetMap (`© OpenStreetMap contributors`) |
| **Primary Routing Engine** | Google Routes API (server-side key) | Valhalla (`http://localhost:8002`, `VALHALLA_BASE_URL`) |
| **Secondary Routing Engine** | None | OSRM (`http://localhost:5000`, `OSRM_BASE_URL`) |
| **Offline / Demo Routing** | Mock Bengaluru coordinates | `MockMappingProvider` with interpolated GeoJSON lines & encoded polylines |
| **Failover Chain** | None (hard-failure on missing key) | `FallbackMappingProvider` (Valhalla → OSRM → Mock) with structured logging |
| **Frontends Migrated** | `apps/management-web`, `apps/ambulance-web` | Fully rendered via `<JivaMap>` without API key checks |
| **Vendor Lock-in** | Proprietary Google Cloud billing dependency | 100% Open-Source, self-hostable via Docker Compose |

---

## 2. Invariants & Clinical Boundaries Preserved

In accordance with strict architectural freezing:
1. **Clinical Eligibility Intact:** `eligibilityEngine.ts` and `evaluateHospitals()` were completely preserved without modification. Clinical requirements always gate hospital candidacy before any routing occurs.
2. **Hospital Acceptance Protocol Intact:** Ephemeral reservation windows, clinician confirmation states (`ACCEPTED`, `LIMITED`, `REJECTED`, `UNAVAILABLE`), and automated expiration handling remain 100% intact.
3. **Non-Authority Principle Enforced:** The mapping provider calculates road distance, travel duration, and polyline/coordinate geometry between two predetermined coordinates. It possesses **zero** authority over hospital selection or dispatch priority.
4. **Telemetry Decoupling Preserved:** High-frequency GPS updates (`ambulance.location.updated`) update state store telemetry and do **not** trigger route recalculations. Route recalculations occur solely upon destination changes or capacity status updates.
5. **Traffic Honesty:** The canonical `RouteResult` model explicitly reports `trafficAware: false` when using OSM/Valhalla data until live traffic sensors are integrated.

---

## 3. Detailed Changes by Package

### A. `@jiva/mapping` (`packages/mapping`)
- **Canonical Model Extended:** `RouteResult` extended with `coordinates: [number, number][]` (GeoJSON `[lng, lat]`), `provider: 'valhalla' | 'osrm' | 'mock'`, `sourceType: 'osm' | 'synthetic'`, `synthetic: boolean`, `calculatedAt: string`, and `trafficAware: boolean`.
- **`ValhallaMappingProvider`:** Added implementation querying `/route` with costing parameter `auto`, timeout support (5000ms), and precision-6 polyline decoding.
- **`OSRMMappingProvider`:** Added implementation querying `/route/v1/driving/` with `geometries=geojson` for direct coordinate extraction.
- **`MockMappingProvider`:** Added interpolated intermediate road-network waypoints and polyline encoding.
- **`FallbackMappingProvider`:** Implemented three-tier failover chain emitting structured `mapping.provider.fallback` logs.
- **`createMappingProvider()`:** Factory function supporting `auto`, `valhalla`, `osrm`, and `mock` modes.
- **`polyline.ts`:** Implemented precision 5/6 polyline decoding and encoding.
- **Deletions:** Deleted `packages/mapping/src/providers/GoogleMapsProvider.ts`.

### B. `@jiva/ui` (`packages/ui`)
- **`<JivaMap>`:** Rebuilt using MapLibre GL JS, OpenStreetMap standard raster tiles, visible attribution control, provider HUD badge, and dynamic GeoJSON line layer for active and alternative routes.
- **`<HospitalMarker>`:** Implemented status-colored SVG teardrop pins with interactive popups.
- **`<AmbulanceMarker>`:** Implemented smooth `marker.setLngLat([lng, lat])` GPU movement.
- **`<MapContext>`:** Lightweight React context providing map instance reference.
- **Dependency Cleanup:** Uninstalled `@vis.gl/react-google-maps`.

### C. Frontend Applications (`apps/management-web` & `apps/ambulance-web`)
- Removed all Google Maps API key requirements, checks, and error banners.
- Render `<JivaMap>` directly with live `routeCoordinates` and `routeMetadata`.
- Removed `@vis.gl/react-google-maps` from `package.json`.

### D. Backend Services (`services/api`)
- **Infrastructure Factory (`factory.ts`):** Initialized `mappingProvider` using `createMappingProvider(config.mapping, logger)`.
- **State Engines (`stateEngines.ts`):** Switched from GoogleMapsProvider to `createMappingProvider()`. Enriched `route.recalculated` events with `coordinates`, `provider`, `sourceType`, and `synthetic`.
- **Lambda Processor (`hospitalAcceptanceProcessor.ts`):** Switched to `createMappingProvider()` and enriched route recalculation events.
- **Health Endpoint (`index.ts`):** `/api/health` now inspects and returns the active mapping provider name.

### E. `@jiva/event-schema` & `@jiva/config`
- Extended `RouteCalculatedSchema` and `RouteRecalculatedSchema` with optional `coordinates`, `provider`, `sourceType`, and `synthetic`.
- Added `mapping: { provider, valhallaBaseUrl, osrmBaseUrl, timeoutMs }` to `JivaConfig` in `@jiva/config`.

### F. Local Infrastructure (`infrastructure/local/mapping`)
- Created `docker-compose.yml` defining `valhalla` (port 8002) and `osrm` (port 5000) services.
- Created `README.md` documenting Geofabrik Karnataka/Southern India OSM data download and setup.

---

## 4. Verification & Audit Results

| Verification Step | Command | Result |
|---|---|---|
| **Demo Readiness Check** | `npm run demo:check` | **STATUS: READY** (All 11 subsystems passed) |
| **Mapping Unit Tests** | `npx tsx tests/unit/mapping-provider.test.ts` | **PASSED** (Polyline, Mock, Valhalla, OSRM) |
| **Fallback Chain Tests** | `npx tsx tests/unit/mapping-fallback.test.ts` | **PASSED** (Primary → Secondary → Tertiary failover) |
| **Parity Integration Tests** | `npx tsx tests/integration/mapping-parity.test.ts` | **PASSED** (Eligibility, Routing, Coordinates) |
| **Full Unit & Integration Suite** | `npm test` | **PASSED** (All 6 unit + 2 integration test suites) |
| **Data Pipeline Validation** | `npm run data:validate` | **PASSED** (Report saved, zero errors) |
| **Mapping Simulation** | `npm run simulate:mapping:blr` | **PASSED** (9 waypoints, simulated telemetry) |
| **Full Monorepo Build** | `npm run build` | **PASSED** (All 4 frontend apps & 9 packages) |

---

## 5. Conclusion

The Google Maps dependency has been completely replaced with a sovereign, open mapping stack:
- **MapLibre GL JS** delivers hardware-accelerated frontend rendering.
- **OpenStreetMap** provides open, community-auditable map data.
- **Valhalla & OSRM** provide self-hostable, cost-predictable road-network routing.
- **MockMappingProvider** guarantees 100% offline, zero-config reliability for hackathon demonstrations.
- The JIVA core clinical logic, event stream, and multi-party coordination workflows remain rock-solid and unmodified.
