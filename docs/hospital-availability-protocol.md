# Hospital Availability Protocol (Phase 2 Prep)

Because no public API provides real-time ICU beds in Bengaluru, JIVA operates on an event-driven Request/Response protocol.

## 1. Request
When an emergency occurs, JIVA publishes a `HospitalAvailabilityRequest`:
```json
{
  "requestId": "req-123",
  "hospitalId": "HOSP-INST-8592",
  "requiredCapabilities": ["ICU", "TRAUMA"],
  "ambulanceEtaMinutes": 12,
  "requestedAt": "2026-09-25T12:00:00Z",
  "expiresAt": "2026-09-25T12:05:00Z"
}
```

## 2. Response
The hospital's system (or a clinician via the Hospital UI) responds with a `HospitalAvailabilityResponse`:
```json
{
  "requestId": "req-123",
  "hospitalId": "HOSP-INST-8592",
  "status": "ACCEPTED",
  "respondedAt": "2026-09-25T12:01:00Z",
  "validUntil": "2026-09-25T13:00:00Z",
  "responderSource": "HOSPITAL_CONFIRMED"
}
```

Only this protocol can shift a hospital's `operationalState.acceptance` from `UNKNOWN` to `ACCEPTED` or `LIMITED`, and only for the case the response names. An acceptance expires at `validUntil` and returns to `UNKNOWN` (never to AVAILABLE).

### Correlation and provenance rules enforced by the Care Feasibility Engine (shadow)

For the feasibility engine, an `ACCEPTED`/`LIMITED` response only counts when it names the **current** request (`requestId`) for the same case and hospital, is made inside that request's `[requestedAt, expiresAt]` window, and the request has not been cancelled or superseded by a newer one. A response that does not satisfy this leaves the hospital `PENDING_ACCEPTANCE`; it never makes it eligible. `REJECTED`/`UNAVAILABLE` restrict and are honoured without correlation. The provenance of a response is **not** taken from its `source` or `responderRole` fields: it is derived by the ingestion adapter from the authenticated principal (see the trust boundary in `claude-01-care-feasibility-design.md`, Phase 3). Legacy behaviour is unchanged.
