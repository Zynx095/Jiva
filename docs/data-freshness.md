# Data Freshness & Verification

In JIVA, data freshness is non-negotiable.

Historical capacities (e.g. 450 total beds) are static snapshots. The validation pipeline explicitly fails if a hospital is marked `AVAILABLE` based solely on a historical bed count. 

Operational State freshness is managed via timestamps:
- `lastConfirmedAt`
- `expiresAt`

If an operational state exceeds its `expiresAt` timeframe, the JIVA state engine will automatically downgrade the capacity status to `UNKNOWN`.
