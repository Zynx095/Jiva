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

Only this protocol can shift a hospital's `operationalState.acceptance` from `UNKNOWN` to `AVAILABLE`.
