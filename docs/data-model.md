# Canonical Hospital Data Model

JIVA's `HospitalState` differentiates heavily between:
1. Static Fact (Name, address, type)
2. Historical Capacity (What a hospital published in 2021)
3. Operational State (Are they accepting emergencies *right now*?)

## Key Sub-Models
### 1. `OperationalState`
Represents the current minute-by-minute status of the facility.
Fields like `emergency`, `icu`, `trauma` can only be `AVAILABLE`, `LIMITED`, `UNAVAILABLE`, or `UNKNOWN`.
If JIVA has no active response from a hospital, these fields are STRICTLY `UNKNOWN`.

### 2. `DataProvenance`
Every hospital record contains a `provenance` array tracking exactly where each fact came from:
- `sourceId`
- `sourceName`
- `retrievedAt`
- `verificationStatus`

### 3. `DataStatus` Enum
Values: `CURRENT`, `HISTORICAL`, `PUBLIC_LISTED`, `HOSPITAL_CONFIRMED`, `AUTHORIZED_FEED`, `SYNTHETIC_DEMO`, `UNKNOWN`, `NOT_DISCLOSED`, `UNVERIFIED`.
This enum powers the UI badges so users never confuse a synthetic demo with real life, or historical capacity with live availability.
