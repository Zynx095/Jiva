# JIVA — Doctor workspace, ambulance intake, clinical catalogue and demo portal

Branch `feat/jiva-doctor-clinical-workspace`, built on the emergency-to-care journey
([`emergency-to-care.md`](emergency-to-care.md)). This document describes what the branch adds, as it stands.
Security: [`security-review.md`](security-review.md) §6. Persistence: [`persistence-plan.md`](persistence-plan.md)
§0. Gaps: [`production-readiness.md`](production-readiness.md).

> JIVA is a research and demonstration platform, not a medical device. It never diagnoses, never suggests a
> medication or a dose, and never interprets an image or a result. Everything in demo mode is synthetic. State
> lives in memory: **nothing survives an API restart**.

## 1. The interfaces

| Interface | App | Dev / preview | Who |
|---|---|---|---|
| Ambulance | `apps/ambulance-web` | 5174 / 4174 | crews `demo-amb-1…3` |
| Hospital (coordination) | `apps/hospital-web` | 5175 / 4175 | coordinators `demo-hosp-1…4`; a clinician persona is sent to the doctor workspace |
| **Doctor** | `apps/doctor-web` (new) | 5177 / 4177 | clinicians `demo-doc-1…5` |
| Patient | `apps/patient-web` | 5176 / 4176 | `demo-patient-1/2` |
| Management | `apps/management-web` | 5173 / 4173 | `demo-mgmt-1` |
| **Demo portal** (separate, not operational) | `apps/demo-portal` (new) | 5178 / 4178 | acts as each demo persona per step |

`npm run dev` / `npm run start:prod` start all six and report `READY`; the API's default CORS origins include
the new ports.

## 2. Doctor workspace

Only the encounters assigned to the clinician (the API returns nothing else). Per encounter:

- **Overview** — what the crew reported at the scene (symptoms, suspected cause labelled unconfirmed, assessed
  care); the crew's **pre-hospital record** (vital signs with source, time, freshness, quality flags; vital signs
  not available with the reason; symptom description and onset); the hospital's arrival, handover and
  responsibility records (incl. the GPS geofence time as evidence only and the assignment history); and the
  **encounter history** — the case's recorded events as this clinician may see them (content-free).
- **Vital signs** — in-hospital readings (clinician-entered, optional "questionable" flag; demo simulator
  labelled) next to the crew's record.
- **Prescriptions** — choose a product from the medication catalogue (name, strength and dosage form locked
  to the entry; dose, frequency, duration and instructions from the clinician) or enter one without the
  catalogue; **save as draft** or **prescribe and authorise**; a draft is authorised only by *Review and
  authorise* with an explicit attestation of the version shown; discard drafts; change (re-authorises) or stop
  with a reason; full version history showing who authorised what.
- **Reports and notes** — diagnostic reports (unchanged) and **clinical notes** (progress, assessment,
  procedure, handover, other), versioned, care team only.
- **Documents and scans** — typed uploads (X-ray, CT, MRI, ultrasound, ECG, laboratory and pathology reports,
  other), **new versions** that keep the earlier one (marked as replaced), and the **synthetic sample library**
  (demo only): browse, preview, attach — always shown as "Synthetic sample — not this patient".

## 3. Ambulance intake

The intake form takes, optionally: vital signs (heart rate, SpO₂, blood pressure, temperature, breathing rate)
with the time they were measured, a "questionable" flag per value, a reason for any vital sign that could not be
taken (not measured, equipment unavailable, could not be obtained), a free-text symptom description and the
onset time. After the report, the job view's **Patient observations** card shows what was recorded and adds
readings en route (and, in demo mode, a labelled simulated ambulance monitor) until the handover releases the
crew. The values go to the case's clinical record, never to the operational event stream, routing or dispatch.
No ambulance monitor is connected to JIVA, and the screens say so.

## 4. Clinical catalogue

| | Sample documents (`scan-assets`) | Medications |
|---|---|---|
| Canonical file | `data/catalogue/scan-assets.json` + `data/catalogue/assets/` | `data/catalogue/medications.json` |
| Content | 8 synthetic files drawn by `scripts/catalogue-assets.ts` (chest and leg X-ray, CT head, MRI brain, abdominal ultrasound, ECG lead II strip, two lab report PDFs): no person, no finding, labelled on the image | 21 common generic products: name, one strength, dosage form, routes, ATC code — no doses, frequencies or indications |
| Entry fields | `assetId`, `status`, `category`, `documentType` (must fit the category), `title`, `description`, `bodySite`, `assetRef` (bare file name), `contentType`, `sizeBytes`, `sha256`, `designation` (SYNTHETIC/EDUCATIONAL), `provenance`, `schemaVersion` | `medicationId`, `status`, `name`, `strength`, `formulation`, `routes`, `atcCode`, `provenance`, `schemaVersion` |
| Modes | DEMO only (404 in operational mode) | DEMO: bundled list; OPERATIONAL: empty until an administrator imports one |

- **Versioning:** the catalogue has a version (+1 per applied import); each entry a revision. A prescription
  written from the catalogue records the entry and revision it used.
- **Import (administrators):** `POST /api/catalogue/:kind/import/preview` (CSV or JSON, ≤ 90,000 characters,
  ≤ 500 records) returns, per record, NEW / CHANGED (with field names) / UNCHANGED / INVALID (with issues) /
  DUPLICATE, and changes nothing; `POST …/import/apply` applies exactly that preview, by the same administrator,
  within 15 minutes, if the catalogue did not change meanwhile. Any invalid or duplicated record blocks the whole
  import; changing existing entries needs `confirmChanges: true`; nothing is ever deleted (withdraw with status
  `WITHDRAWN`). Sample entries must reference an existing regular file inside the asset store whose size, sha256
  and file signature match (≤ 5 MB; PNG, JPEG or PDF); no path, directory or link can be referenced.
- **Export (administrators):** `GET /api/catalogue/:kind/export?format=csv|json`; CSV cells that could start a
  spreadsheet formula are escaped (and unescaped on import).
- `npm run catalogue:validate` validates the bundled files exactly as the API loads them;
  `npm run catalogue:assets` regenerates the sample files byte-identically.
- In the demo portal, *Asset library → Catalogue administration* does export → edit → preview → confirmed apply.

## 5. Demo portal

A separate app with its own layout and navigation (Scenarios, Controls, Timeline, Asset library, System),
visually set apart, which refuses to run against an API in operational mode.

- **Scenarios** (each step a real API call as the persona shown, then a read-back of authoritative state):
  successful acceptance; rejection then reroute; busy (unavailable) then reroute; several rejections before an
  acceptance; answer expiry (20-second validity); arrival and handover; doctor assignment and review; synthetic
  scan; clinician-authorised demonstration prescription (draft → explicit authorisation); realtime outage and
  recovery. Resetting scenarios ask first.
- **Controls:** the same steps by hand, with a log of the server's answers.
- **Timeline:** the recorded ledger (as the demo administrator, which excludes clinical content), the assigned
  doctor's clinical events and the content-free audit trail (including refused attempts), each labelled
  "Synthetic · demo persona" or "Derived by JIVA from synthetic inputs".
- **Asset library:** browse and preview the synthetic samples; attach one as the assigned doctor; catalogue
  administration.
- **System:** mode, provenance statement, live integrations (none), the portal's own live connection, links to
  the five operational apps as demo personas.
- **Realtime outage:** `POST /api/demo/realtime-interruption {seconds: 5–60}` (demo administrator, DEMO mode only)
  closes every live transport and refuses new handshakes for the window; screens show "Reconnecting…" and recover
  by themselves. A full API outage is shown by stopping and restarting the API (which loses demo state).
- What the portal cannot do: it has no access beyond the personas' own; it cannot run in operational mode; it
  does not simulate devices other than the existing labelled simulators.

## 6. API additions

| Method and path | Who | Notes |
|---|---|---|
| `GET /api/catalogue`, `GET /api/catalogue/:kind` | CLINICIAN, ADMIN | Withdrawn entries listed for admins only (`includeWithdrawn=true`) |
| `GET /api/catalogue/scan-assets/:assetId/content` | CLINICIAN, ADMIN | DEMO only; attachment with `nosniff`, `no-store`, sandbox CSP |
| `POST /api/catalogue/:kind/import/preview`, `…/import/apply`, `GET …/export` | ADMIN | Audited; apply idempotent |
| `POST /api/encounters/:id/prescriptions` (`draft`, `formulation`, `medicationId`) | assigned CLINICIAN | Catalogue agreement checked (422 `catalogue_mismatch` / `unknown_medication`) |
| `POST /api/encounters/:id/prescriptions/:rxId/authorise` | assigned CLINICIAN | `expectedVersion` + `attestation: true`; drafts only |
| `POST /api/encounters/:id/prescriptions/:rxId/discard` | assigned CLINICIAN | Drafts only; reason |
| `POST /api/encounters/:id/documents` (`documentType`, `supersedesDocumentId`) | assigned CLINICIAN | Type must fit the category; replaces a verified, not yet replaced document of the same category |
| `POST /api/encounters/:id/documents/samples` | assigned CLINICIAN | DEMO only; copies a verified sample; `origin: CATALOGUE_SAMPLE`, `SYNTHETIC_DEMO` |
| `GET/POST /api/encounters/:id/notes`, `POST …/notes/:noteId/amend` | assigned CLINICIAN | Patients 403 |
| `POST /api/emergencies` (`clinical`) | AMBULANCE | Optional pre-hospital record with the report |
| `GET/POST /api/cases/:caseId/prehospital`, `POST …/prehospital/simulate` | attending AMBULANCE writes; crew, assigned CLINICIAN, own PATIENT read | Simulate: DEMO only |
| `GET /api/encounters/:id/prehospital` | assigned CLINICIAN, own PATIENT | |
| `POST/GET /api/demo/realtime-interruption` | ADMIN | DEMO only |

## 7. Event contracts (additions, all content-free)

| Event | Payload (summary) | Delivered to |
|---|---|---|
| `clinical.prehospital.recorded` | entryId, caseId, ambulanceId, source, measurementCount, measurementTypes, unavailableCount, narrative (boolean), observedFrom/To | the recording crew, the patient, the clinician assigned to the case's encounter |
| `clinical.note.recorded` | noteId, encounter refs, version, action, noteType, contentHash, `patientVisible: false` | the assigned clinician |
| `clinical.prescription.recorded` (extended) | status `DRAFT`/`CANCELLED`, action `AUTHORISED`/`CANCELLED`; `patientVisible` false until first authorised | the assigned clinician; the patient once authorised |
| `clinical.document.stored` (extended) | `documentType`, `origin`, `supersedes` | as before |

## 8. Authorization summary

| Principal | New permissions | Refused |
|---|---|---|
| AMBULANCE (attending crew) | write and read its case's pre-hospital record until the handover | everything clinical in hospital; after the handover the record (404) |
| CLINICIAN (assigned) | read the pre-hospital record; drafts, authorisation, discard; notes; typed uploads and versions; attach samples (demo); read the catalogue | any of it for encounters not assigned to them (404) — revoked at once on reassignment |
| PATIENT | read their own pre-hospital record; authorised prescriptions only; released documents (samples labelled) | drafts, notes (403), writes |
| HOSPITAL coordinator, MANAGEMENT | — | pre-hospital record, notes, catalogue (403) |
| ADMIN | catalogue import/export; demo realtime interruption | clinical content (403) |

## 9. Tests

| Suite | Checks |
|---|---|
| `tests/unit/clinical-catalogue.test.ts` | Schemas, asset references (traversal, type, size, hash), CSV codec and formula guard, preview/apply rules, export round trips |
| `tests/unit/prescription-workflow.test.ts` | Draft → authorised / discarded lifecycle, patient view, catalogue agreement, attested authorisation contract |
| `tests/unit/document-types-samples.test.ts` | Type/category rules, sample command, document event contract |
| `tests/unit/prehospital-and-notes.test.ts` | Pre-hospital contracts, entries, latest values, events, authorization matrix and delivery; notes |
| `tests/unit/operational-isolation.test.ts` | Real route handlers with non-demo principals: nothing synthetic in operational mode |
| `tests/unit/clinical-store-contract.test.ts` | The `IClinicalStore` contract a durable store must also pass |
| `tests/integration/doctor-workspace.test.ts` | Real API (:4105): intake with vitals → record follows the patient → drafts and authorisation → samples and versions → notes → reassignment → realtime interruption → catalogue administration → demo reset |
| `tests/integration/demo-portal-scenarios.test.ts` | Real API (:4106): all ten portal scenarios with the portal's own steps; SHADOW authority and no unexpected shadow disagreement |

## 10. Limitations (explicit)

- **No persistence:** a restart loses every case, encounter, record, document and catalogue import (see
  [`persistence-plan.md`](persistence-plan.md) §0 for why the durable store was not shipped here).
- **No device integration:** crew and clinician values are typed in; the simulators are demo-only and labelled.
- **The medication catalogue is illustrative,** not a formulary: no dosing, interactions, allergies or
  e-prescribing; operational mode needs an authoritative catalogue imported by an administrator (in memory).
- **No DICOM viewer;** samples are schematic PNG/PDF files, not imaging studies.
- **Catalogue administration has no operational UI** (API only); the demo portal's panel runs as the demo
  administrator.
- **Patient app:** shows authorised prescriptions and released documents (a released sample carries the label
  "Synthetic sample — not your own result", whatever its title), but has no dedicated view of the crew's
  pre-hospital record (the API allows the patient to read it).
- All the production prerequisites of [`emergency-to-care.md`](emergency-to-care.md) §9 still apply.
