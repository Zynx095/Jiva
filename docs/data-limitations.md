# JIVA Data Limitations

1. **No Live Public Bed API**: There is no authoritative, machine-readable, open API for live hospital bed availability in Bengaluru.
2. **HTML Table Extraction**: The BBMP and Bengaluru Urban directories are rendered as HTML. They must be manually extracted or run through a headless browser scraper. We currently utilize `manual-extract.json` adapters to simulate the ingestion of these HTML tables.
3. **Network Bed Counts**: Some private hospital groups (like Manipal) report bed capacity as a network aggregate (e.g. 12,600+ network beds). We do not divide this by facility; if a facility-specific count is unpublished, we record it as `NOT_DISCLOSED`.
4. **Routing data**: Routes come from the `MappingProvider` chain (Valhalla → OSRM → Mock). Without self-hosted Valhalla/OSRM, routes are synthetic straight-line corridors (labelled as such). No Google data is used.
