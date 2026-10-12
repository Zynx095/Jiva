# Bengaluru public facility directory

Built by `npm run directory:build` (`scripts/directory-build.ts`, rules in `scripts/lib/directory.ts`).
Rebuilding from the committed inputs is offline and byte-identical; `-- --fetch-osm` refreshes the
OpenStreetMap snapshot with one Overpass query.

**A directory entry says a facility is publicly listed. It says nothing about what the facility can do
now.** Directory facilities are not connected to JIVA: they are never loaded into the hospital store,
never receive referrals, never become routing candidates, and their services, beds and capacity are
`UNKNOWN`. The API serves them at `GET /api/directory/facilities` (and `/near`) for map coverage and
for "call ahead" context only.

## Files

| File | What it is | Licence |
|---|---|---|
| `bengaluru-facilities.json` | The directory (`FacilityDirectory` in `packages/domain-models/src/directory.ts`) | Listing fields: see sources below. Coordinates of `OSM_FACILITY_MATCH` entries are derived from OpenStreetMap: © OpenStreetMap contributors, ODbL 1.0 |
| `osm-health-facilities.json` | Trimmed snapshot of named OSM health facilities (`amenity=hospital/clinic`, `healthcare=hospital/clinic/centre/birthing_centre`) inside the service-area box, with the query and fetch time | © OpenStreetMap contributors, [ODbL 1.0](https://opendatacommons.org/licenses/odbl/) |
| `build-report.json` | Review aid: counts per source, why each unplaced facility stayed unplaced, every merge | — |

If this repository or the directory is published, the ODbL attribution and share-alike terms apply to
`osm-health-facilities.json` and to the coordinates in `bengaluru-facilities.json`.

## Sources

| sourceId | File | Content | Provenance and constraints |
|---|---|---|---|
| `rohini-network-list` | `Bengaluru.xlsx` | 306 hospitals: name, address, ROHINI id | Publisher not documented in the repository. ROHINI is the insurance industry's hospital registry: listing means "registered for insurance", not "provides emergency care". Usage terms unknown — verify before redistribution. |
| `bbmp-health-facilities` | `bbmphospital.csv` | 55 BBMP health centres and urban family welfare centres | BBMP Health Department listing (copy supplied in the repository). Primary care, not hospitals. Listed landline numbers kept as published. |
| `bbmp-referral-hospitals` | `bbmp_referral.csv` | 6 BBMP referral hospitals | Same publisher. Beds/services/staff columns are empty in the source and stay empty. |
| `bbmp-maternity-homes` | `bbmp_maternity.csv` | 24 BBMP maternity homes | Same publisher. |
| `hospitals-in-india` | `HospitalsInIndia.csv` | 83 rows with City = Bangalore | Origin not documented in the repository. |
| `manual-extract` | `data/raw/*.json` via `data/canonical/hospitals.json` | 7 facilities with official URLs | Coordinates were typed in by a contributor (`MANUAL_UNVERIFIED` unless an OSM match confirms them). |

## Rules

**Names and addresses.** Whitespace collapsed; `H.C.` → Health Centre, `UFWC` → Urban Family Welfare
Centre; address text pasted into a name field (after a comma, starting with a house number or a road
word) removed; insurer notes such as "(No Cashless for …)" removed; the mis-encoded dash in the BBMP
lists (`Bangalore ? 79`) restored.

**Pincode.** An explicit 6-digit `56xxxx` value, else one written in the address, else the postal
shorthand `Bangalore - 79` → `560079`. Codes outside the Bengaluru series are ignored.

**Category.** The source's own type wins (`BBMP Health Centre` → `HEALTH_CENTRE`, …). Otherwise a
documented name keyword (eye/netralaya → `SPECIALTY_HOSPITAL` with hint EYE; nursing home; clinic;
maternity/motherhood; …). Otherwise `UNKNOWN`. Every entry records `categoryBasis`. A specialty hint
comes from the name only and is never a capability.

**Merging.** Two listings are one facility only with positive evidence: same name key (no parenthetical,
legal suffixes or "unit of …" tail), never two rows of one source (a source lists each branch once),
no conflicting pincodes, and the same pincode or a shared address locality word. A listing joins an
existing facility only when exactly one qualifies — chains keep their branches apart.

**Coordinates (OpenStreetMap name match).** A listing is placed only when all of these hold:

1. The specialty classes of the two names are identical (an eye hospital never stands in for the
   general hospital of the same name).
2. Every identifying word of the listing appears in the OSM name, and every identifying word of the
   OSM name appears in the listing's name or address. Specialty words never identify; a locality word
   identifies only when the name has nothing else ("Hosahalli Referral Hospital").
3. Name similarity ≥ 0.75, or ≥ 0.5 with corroboration (same postcode, or an address locality named
   in the OSM feature).
4. Identity resting only on common words, or on one word while the rest of the name differs, needs
   corroboration.
5. Differing postcodes reject the candidate.
6. Several equally good candidates far apart (a chain) leave the listing `UNRESOLVED` unless exactly
   one is corroborated.
7. The point lies inside the service area (lat 12.70–13.30, lng 77.30–77.95).

Everything else stays `UNRESOLVED` — listed, but not on the map. The reasons are in
`build-report.json`. Matches were reviewed by hand during development; the rules were tightened until
the reviewed false positives (e.g. a "Cloudnine Jayanagar" listing matching "Jayanagar General
Hospital") were rejected.

## Known limitations

- Most facilities (about two thirds) have no verified location; many BBMP names do not appear in OSM.
- Name variants across sources are not always merged (e.g. "Referral Hospital, Srirampura" and
  "Srirampuram Referral Hospital").
- OSM data has its own errors; a name match is not a site survey.
- The source lists are point-in-time copies; facilities may have closed, moved or been renamed.
