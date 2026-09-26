# JIVA Self-Hosted Mapping Infrastructure (Valhalla & OSRM)

This directory provides the Docker Compose configuration for running self-hosted routing services for JIVA using OpenStreetMap (OSM) data.

## Architecture

- **Primary Router**: [Valhalla](https://github.com/valhalla/valhalla) (`http://localhost:8002`)
  - Supports multimodal routing, dynamic costing, and precision-6 polyline decoding.
- **Secondary / Fallback Router**: [OSRM](http://project-osrm.org/) (`http://localhost:5000`)
  - High-performance car routing returning native GeoJSON geometry.
- **Offline / Deterministic Fallback**: `MockMappingProvider` (Internal)
  - Automatically activates if neither Valhalla nor OSRM is reachable.
  - Requires zero internet connection, zero API keys, and zero Docker containers to run demonstrations.

---

## Quick Start (Valhalla)

### 1. Download Karnataka / Bengaluru OSM Extract
Download the Geofabrik Southern India or Karnataka extract:
```bash
mkdir -p valhalla_tiles
# Download Southern Zone extract
curl -o valhalla_tiles/southern-zone-latest.osm.pbf https://download.geofabrik.de/asia/india/southern-zone-latest.osm.pbf
```

### 2. Start Valhalla via Docker Compose
```bash
docker compose up -d valhalla
```
Valhalla will automatically build routing tiles in `./valhalla_tiles` and start serving on `http://localhost:8002`.

### 3. Verify Valhalla Status
```bash
curl http://localhost:8002/status
```

---

## Routing Fallback Chain in JIVA

When configured with `MAPPING_PROVIDER=auto` (default):
1. JIVA attempts routing via **Valhalla** (`VALHALLA_BASE_URL`, default `http://localhost:8002`).
2. If Valhalla is unreachable or times out (5000ms), JIVA logs a structured `mapping.provider.fallback` event and attempts **OSRM** (`OSRM_BASE_URL`, default `http://localhost:5000`).
3. If OSRM is also unavailable, JIVA falls back to **MockMappingProvider** without crashing or throwing errors.
4. All route responses explicitly declare:
   - `provider`: `"valhalla"` | `"osrm"` | `"mock"`
   - `sourceType`: `"osm"` | `"synthetic"`
   - `synthetic`: `true` | `false`
   - `trafficAware`: `false` (until live sensor telemetry is linked)
