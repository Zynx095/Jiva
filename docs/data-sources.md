# JIVA Data Sources & Provenance

This document outlines the authoritative public sources used to seed the JIVA Hospital Master Database for Bengaluru.

| Source | Authority | Coverage | Fields | Publication/update date | Currentness | How JIVA uses it | Limitations |
|--------|-----------|----------|--------|-------------------------|-------------|------------------|-------------|
| Bengaluru Urban Govt Directory | Govt of Karnataka | Bengaluru Urban District | Name, Address, Category, Phone, Pincode | Varies | Static | Base facility graph creation and verification | No structured API; HTML requires manual ingest |
| BBMP Palike Hospitals | BBMP | Bengaluru City Wards | Name, Zone, Ward, Category | Varies | Static | Supplemental civic hospital verification | Table-based HTML; manual extraction required |
| Official Hospital Institutions | Private Institutions (e.g. Baptist, Manipal) | Facility specific | Beds, Specialties, Location | Current | Historical/Static | Verifying historical bed capacity and precise coordinates | Disparate formats; some do not publish network bed breakdown per facility |

## Ingestion Architecture

JIVA does not dump scraped data directly into the application. We use a structured pipeline:
1. `npm run data:fetch` -> Adapters fetch into `data/raw/`
2. `npm run data:normalize` -> Data is normalized to canonical `HospitalState`, deduped, and written to `data/canonical/hospitals.json`
3. `npm run data:validate` -> A strict validator checks for required coordinates, sources, and ensures no current capacity is inferred from historical data.
