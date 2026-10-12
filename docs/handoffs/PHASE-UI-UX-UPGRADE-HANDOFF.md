# JIVA UI/UX Upgrade Handoff

**Author**: Claude (Opus 5.5)
**Date**: 3 October 2026
**Scope**: Frontend only: `apps/*` and `packages/ui`. No backend, event-schema, authority, data or AWS changes.
**Operating mode**: Unchanged. The system runs in `SHADOW` mode, legacy rule engines decide all routing, and human authorization is not granted.
**State**: Working tree on `main`, **not committed**.

The design rules that came out of this work are in [`DESIGN.md`](../../DESIGN.md) at the repository root.

---

## 0. Read first: the identity in the brief vs. the code

The brief said to *keep* an existing white-first, green-primary, light-gray JIVA identity. That identity was not in the code. The audit found:

| Screen | Before |
|---|---|
| Command Center, Hospital, Ambulance | Dark: black backgrounds, blue accents, purple "AI" panels, 10–11px uppercase labels |
| Patient | Light, but with a blue header |
| Branding | Default Vite favicon (purple bolt). Tab titles were `management-web`, `hospital-web` and so on |
| Design documentation | No `DESIGN.md` and no shared components beyond the map |

**Decision.** I treated the identity described in the brief as the JIVA identity. The brief's do-not list also forbids "dark futuristic dashboards" and "purple AI aesthetics". I kept each app's **template** (layout and information architecture):

- Command Center: map plus side panels.
- Ambulance: map plus job panel.
- Hospital: requests plus status column.
- Patient: journey column.

Everything is now white-first with green as the only brand colour, a green-tinted gray family, amber for attention and red only for critical states.

If a dark theme is wanted later, the tokens in `packages/ui/src/styles/jiva.css` are the single place to add a dark set.

---

## 1. UX problems found (audit)

### Command Center (`apps/management-web`)

**Header and status**
- Six separate health labels competed in the header.
- Mapping before the first route showed `NONE-YET` in **green**, which made an unknown state look healthy.
- Statuses appeared as raw enums (`IN_TRANSIT`, `(ACCEPTED)`).

**Map**
- The layer buttons (Hospitals / Ambulances / Emergencies / Routes) had **no click handlers**. They were dead controls, and they overlapped the provider label.
- The demo-controls panel permanently covered about 20% of the map.
- Idle ambulances were seeded at hospital coordinates, so their glowing markers **hid two of the four hospitals**.
- Emergency locations were never drawn. `EmergencyMarker` existed but was unused.

**Lists and navigation**
- There was **no hospital list**, so hospital state could only be found on the map.
- Incident cards looked clickable (pointer cursor) but did nothing.
- The hospital-detail "modal" was a stub with a bare `Close` button.
- There was no search, no filtering, no drill-down and no deep link.

**Event stream and realtime**
- The event stream showed raw types (`ambulance.location.updated`) in monospace, and GPS fixes flooded it.
- Realtime changes silently replaced numbers.

### Hospital (`apps/hospital-web`)

**Requests**
- The deadline was only "Respond by 2:41 pm". There was no countdown and no sense of urgency.
- "Accept with limits" and "Reject" sent **fixed hidden reasons** ("ICU capacity limited", "Trauma service unavailable") without asking the clinician.
- After answering, the card simply vanished. There was no confirmation and no visible effect, such as "the ambulance is now coming to you".

**Status and history**
- "Report ED unavailable" executed immediately, without saying that it reroutes ambulances.
- There was no view of ambulances heading to the hospital, although the API already scopes them to it.
- Response history covered only the current browser tab.

### Ambulance (`apps/ambulance-web`)
- The reroute banner used purple with raw IDs: `REROUTED: HOSP-BLR-001 → HOSP-BLR-004. Destination HOSP-BLR-001 capacity became UNAVAILABLE`.
- The ETA was shown in amber, which reads as a warning.
- Severity was not shown, and there was no "next action".
- The other-hospitals list was cut off at the bottom of the screen.
- The map showed only the destination.

### Patient (`apps/patient-web`)
- The structure was good: a journey stepper, honest ETA text and a demo badge. However, it used a blue header, unlike the other apps.
- There was no history of what happened, no "what happens next", no emergency call action and no way to see where information came from.

### All apps
- System fonts and four copies of the status-colour helpers.
- No skip links and no reduced-motion handling.
- 10–11px text throughout the operations screens.

---

## 2. What changed, per screen

### Command Center

**Shell**
- The header has the JIVA mark and **global search** (cases, hospitals and ambulances; `/` or Ctrl/⌘+K; arrow keys and Enter).
- A single **System status** pill opens a drawer covering:
  - Components: event bus, store, realtime, routing including the last fallback reason, AI, infrastructure and demo auth.
  - **Decision authority**: SHADOW, the agreement count, kill switch, circuit breaker and policy hash, read-only from `/api/feasibility/shadow`.
- A connection pill and a *Demo data* badge.

**Headline numbers**
- Five numbers, each a **shortcut**. For example, *Awaiting hospital answer* opens Hospitals filtered to pending.
- Values flash when they change.

**Map**
- Re-toned light basemap.
- **Working** layer toggles, a status filter with counts, a *Stale data* filter and *Reset*.
- Emergency markers, compact idle-ambulance chips and a legend.
- Tools to recenter and fit the route.
- First load frames every unit. The map re-frames after a demo reset.

**Map and panel synchronisation**
- Clicking a marker opens a compact popup with the details and route actions, and opens the detail panel.
- Clicking a list row flies to the marker.
- The selection is stored in the URL hash, so browser Back walks back through drill-downs.

**Side panel tabs**
- **Incidents**: case cards showing severity, needs, ambulance, destination and acceptance, route facts, a summary of answers (asked / accepted / limited / declined / awaiting), and *Latest updates*.
- **Hospitals**: status filter chips synced with the map, ED/ICU/trauma dots, provenance (*Demo data*) and freshness ("Answered 2 min ago · expires in 28 min", "Seed data — no live report yet").
- **Ambulances**: assignment, route facts and GPS age, with a stale flag.
- **Activity**: human-readable stream with category filters, GPS rows merged and hidden by default, and shadow-engine traces under *Decisions*. Every entry expands to *Why & evidence* (the candidate trace, AI content, links to related entities, then technical details).

**Detail views (breadcrumbs + Back)**
- **Case**: severity and status, ambulance, destination and arrival, **hospital answers** with countdowns, hospitals *not asked* and why, the collapsible **decision trace**, and the case timeline.
- **Hospital**: current answer and validity, services (listed vs reported), ambulances heading there, requests for the hospital, provenance.
- **Ambulance**: assignment, route provenance, GPS freshness, recent activity, telemetry.

**Demo controls**
- Moved under the map into a collapsible strip. The collapsed/expanded state is remembered per viewer.
- Grouped as Scenario, Hospital answers, Disruption and Telemetry.
- Every button shows pending, done or failed. API rejections appear as "Control rejected by API: …".
- **Labels are unchanged**, so `docs/demo-runbook.md` and `docs/judge-demo-script.md` still match.

### Hospital
- **Status strip**: ED / ICU / trauma, the current answer and its case and validity, report freshness, and *Report ED unavailable* / *available*.
- **Request card**:
  - A draining deadline bar and an `mm:ss` countdown, turning red under 2 minutes.
  - The reported condition, required care in plain labels, and the ambulance ETA marked as an estimate.
  - **Accept** (one click), **Accept with limits** and **Decline**.
  - Limits and decline open an inline reason picker (multi-select). The reasons are what get sent, and each choice states its consequence.
  - The send button goes pending → done, or shows an inline error with the server's reason (for example, an expired request returns a 409).
- **Confirmation card**: after answering, the card states the effect, e.g. "AMB-BLR-001 is now heading here · 22 min" or "Your emergency department is reported unavailable, so JIVA routes this patient elsewhere".
- **Patients on the way**: ambulances routed here, with ETA, distance, GPS age, needs and whether a brief exists.
- **Your recent answers**: built from the case timelines this hospital may read plus live events, so it survives a reload.
- **Facility panel**: hospital → service drill-down with breadcrumbs (listed vs reported). It states that ward, room and bed data stay inside the hospital by design.
- **Report ED unavailable** now asks for confirmation in a dialog that states the consequence: ambulances heading here are rerouted.
- Handoff briefs are labelled advisory. A hospital-scoped activity timeline was added.
- The page title shows open requests, e.g. `(1) New request · JIVA Hospital`.
- A demo persona switcher replaces typing `?as=`.

### Ambulance
- **Decision bar**: patient (with severity read from the case history), condition, destination and its acceptance, and ETA plus distance (flashes on change).
- **Next action**: Drive to X / Proceed to the patient / Hold — finding a new destination / Hand over at X.
- **Reroute card**, kept until the crew clicks *Got it*: the old destination (struck through), why (in sentence form), "JIVA re-evaluated eligible hospitals", then the new destination with ETA and distance. The abandoned route stays **dashed** on the map.
- **Hospital answers for this case**: destination pinned first, then answer, limits, deadline or "not asked".
- Route provenance card and case activity.
- The map shows the destination, the other hospitals (dimmed, with case-specific status) and the pickup point.

### Patient
- **Current care** hero: a plain headline ("On the way to Indiranagar"), ETA marked as an estimate, and a five-step journey.
- **Your hospital** with its confirmation state.
- **What happens next**, in plain words, changing with the case state.
- **Recent activity**: a living timeline. Each entry expands to its time, source ("JIVA coordination system"), a *Demo data* note and a reference.
- **Need urgent help? Call 108** (a real `tel:` link).
- **Your health records**: medications, reports, care team and upcoming appointments are shown as **Not connected yet / Coming later**. They are not faked. This is Phase 7 scope.
- AI summary labelled "AI-generated, for information only". A dismissible destination-change notice.

---

## 3. Shared components (`packages/ui`)

**New**
- **Tokens**: `styles/jiva.css`. Tailwind v4 `@theme` with brand / ink / warn / danger scales, shadows, motion keyframes, focus ring, reduced-motion rules, map chrome and marker styles.
- **Font**: `fonts.ts` loads the self-hosted Plus Jakarta Sans Variable. The new dependency is `@fontsource-variable/plus-jakarta-sans` (OFL-1.1).
- **Components**: `Icon` (custom set) with `iconSvg`, `JivaButton`, `AsyncButton`, `useAsyncAction`, `Spinner`, `JivaCard`, `CardHeader`, `SectionLabel`, `DataRow`, `JivaBadge`, `JivaStatus`, `StatusDot`, `JivaMetric`, `Flash`, `EmptyState`, `JivaSkeleton`, `SkeletonRows`, `JivaTabs`, `TabPanel`, `JivaFilter`, `ToggleChip`, `JivaBreadcrumbs`, `ToastProvider`, `useToast`, `JivaModal`, `JivaDrawer`, `JivaSearch`, `JivaTimeline`, `TechnicalDetails`, `eventTechnicalFields`, `AppHeader`, `JivaLogo`, `ConnectionPill`, `DemoBadge`, `PersonaSelect`, `MapPopup`, `MapLegend`.
- **Logic** (`lib/`):
  - `status.ts`: the one status vocabulary.
  - `labels.ts`: plain-language capability labels.
  - `time.ts`: `useNow`, relative times and countdowns.
  - `events.ts`: `describeEvent` and `humanizeReason`, per audience.
  - `acceptance.ts`: `caseResponses` replay, shared by the Command Center and the Ambulance app.
  - `cx.ts`.

**Changed (backwards compatible)**
- `JivaMap` gained:
  - The basemap treatment.
  - `focus` / `fit` camera props, with offset and padding.
  - `onBackgroundClick`.
  - `topLeft` / `bottomLeft` overlay slots and the tools.
  - A short provider chip on phones.
- `HospitalMarker`, `AmbulanceMarker` and `EmergencyMarker`: redesigned DOM, `onClick`, `selected` / `dimmed` / labels and ARIA. Ambulances glide between fixes.
- Every existing prop still works.

**Apps**
- Each app imports the tokens and adds `@source "../../../packages/ui/src"`, so Tailwind generates the shared components' classes. Previously some classes used inside `JivaMap` were never generated.
- `hospital-web` and `patient-web` now declare the `@jiva/ui` and `@jiva/domain-models` workspace dependencies they already imported.

---

## 4. Map improvements

- **Same architecture.** MapLibre, OSM raster tiles and the Valhalla → OSRM → Mock chain are unchanged. There is no Google Maps and no new tile provider.
- **Calm, clinical basemap.** The OSM tiles are desaturated, softened and lifted in the GPU, in the spirit of Snazzy Maps' *Subtle Grayscale* and *Ultra Light* styles.
- **Marker language**: each marker type is distinguished by shape, colour, a corner glyph and a label (never colour alone). Labels show on hover, focus or selection.

  | Marker | Shape and colour | Notes |
  |---|---|---|
  | Hospital | Rounded square with **H**, coloured by acceptance | White with a gray outline means no current response |
  | Ambulance on a job | Dark pill with call sign | Glides ~0.9 s between fixes, from wherever it is drawn |
  | Idle or arrived ambulance | Compact chip | Offset beside the station so it never hides a hospital |
  | Emergency | Red point | Soft ring while the case is open |

- **Routes**: the active route is `brand-800` over a white casing. A reroute leaves the old route dashed. The provider chip states synthetic routes and missing live traffic.
- **Interactions**: click or hover markers, compact popups, focus a selection (offset to leave room for the popup), fit the route, recenter, layer and status filters, a stale-data filter, and map/list synchronisation.

**Research notes**

- **Snazzy Maps.**
  - *Subtle Grayscale* (style 15) desaturates every feature by −100 and lifts lightness (landscape +65, local roads +40, arterials +30). It also simplifies POIs.
  - *Ultra Light with Labels* (style 151) uses near-white land (`#f5f5f5`), white roads, dark-gray labels and hidden icons.
  - JIVA's raster treatment approximates both: desaturation, lifted blacks, lower contrast and partial opacity over `#f7f8f7`.
  - Hiding POI icons is not possible with raster tiles; see the limitations.
- **Mayo Clinic.** mayoclinic.org returned HTTP 403 to automated fetching. Healthcare UX principles (plain language, one clear primary action, patient-first wording, visible emergency route) were applied from general practice. No layouts, text or branding were copied.

---

## 5. Interaction improvements

- **Primary actions in one or two interactions**:
  - Accept is one click.
  - Limits and decline are two clicks: choose the reasons, then send.
  - Any entity is one search or one click away.
- **Cause → effect on every API action**: idle → pending → done ✓, or failed ✕ with the reason and a retry. On the hospital screen, the downstream effect is shown in place.
- **Consequences stated before acting**: hint text under the decision buttons and the *Report ED unavailable* dialog.
- **Back navigation everywhere**: breadcrumbs, a Back button and URL-hash history.
- **KPIs as shortcuts** into filtered lists. **Filters** show counts, the number of active filters and Clear / Reset.

---

## 6. Realtime UX improvements

**Toasts**
- Short, grouped toasts for notable events (answers, reroutes, ED unavailable, arrivals, a new request for a hospital) with a *View* or *Review* shortcut.
- They never fire for GPS fixes or on the initial ledger load.
- At most four are visible, they pause on hover, and they are announced politely.

**In-place feedback**
- Values flash when they change.
- Timeline entries slide in.
- Markers glide.
- The reroute card persists until acknowledged.

**Freshness and connection**
- "Updated just now / 12 s ago" and expiry countdowns.
- A connection pill: Live / Connecting… / Reconnecting… / Offline — showing last known data.
- Every app resyncs about 120 ms after each event and every 15 s as a safety net.

---

## 7. Accessibility improvements

- Skip link, landmarks and labelled sections. Tabs follow the ARIA tab pattern (arrow keys, Home and End).
- The search is a combobox with `aria-activedescendant`. Toggles use `aria-pressed` and disclosures use `aria-expanded`.
- Dialogs and the drawer use native `<dialog>`, so focus is trapped, Escape closes them and focus returns to the trigger.
- A visible 2px focus ring everywhere. Map markers are focusable buttons with descriptive labels.

**Contrast and readability**
- Palette contrast was checked numerically:

  | Pair | Ratio |
  |---|---|
  | `brand-700` on white | 6.6:1 |
  | `ink-500` on white | 5.6:1 |
  | `warn-700` on `warn-50` | 5.1:1 |
  | `danger-700` on `danger-50` | 6.7:1 |

- `ink-400` is decorative only. The close buttons that used it were raised to `ink-500`.
- The minimum text size is 12px.

**Motion and announcements**
- `prefers-reduced-motion` disables CSS animation and transitions, marker gliding, value flashes and map flights (MapLibre honours the setting).
- Countdowns use `role="timer"` and are not announced every second. Toasts use a polite live region.

---

## 8. Responsive improvements

- No horizontal scroll at 390px or 768px on any app. This was checked by measuring every element's bounds in a real browser. One overflow was fixed: the header actions now wrap.

| App | Phone | Desktop |
|---|---|---|
| Command Center | KPIs scroll horizontally; the map is 58vh; collapsible demo strip; tabs below | Map plus a 420–460px panel |
| Ambulance | 2×2 decision bar, map (46vh), then the job panel | Side by side |
| Hospital | Requests first, side panels stacked below | Two columns |
| Patient | Single column, journey first | Two columns |

- The map legend is hidden and the provider chip shortened on phones, so the map stays readable.

---

## 9. Performance considerations

- The map is created once. Markers are created once per entity and only update their attributes.
- Route geometry keeps a stable reference per calculation, so GPS fixes never redraw or re-fit it.
- The Command Center keeps 400 events in memory and renders at most 150 activity rows. GPS rows are merged.
- Derived data (acceptance replay, facts, candidates and lookup maps) is memoised per data change.
- Search uses `useDeferredValue`. The clock ticks every 1 s only while a deadline is visible, otherwise every 5 s.
- **Bundle**: Command Center JS grew from 1,334 kB to about 1,430 kB (370 → 399 kB gzip). The font adds about 27 kB woff2 for the Latin subset; other subsets load only if needed. MapLibre still dominates (see limitations).

---

## 10. Roles and screens reviewed

| Role | Screen | Status |
|---|---|---|
| Patient | `patient-web` (`demo-patient-1`, `?as=demo-patient-2` for the empty state) | Reviewed and rebuilt: phone and desktop |
| Ambulance | `ambulance-web` (`demo-amb-1…3`) | Reviewed and rebuilt: idle, dispatched, routed, rerouted, arrived |
| Hospital | `hospital-web` (`demo-hosp-1…4`) | Reviewed and rebuilt: idle, request, accept, limits, decline, ED unavailable, arrivals |
| Clinician | Hospital console | No separate clinician persona or app exists. The acceptance workflow is the clinician-facing surface (responder role `CLINICAL_COORDINATOR`), so it was reviewed there. A dedicated clinician view needs Phase 7 clinical data and personas. |
| Management | `management-web` (`demo-mgmt-1`) | Reviewed and rebuilt: map, lists, details, search, drawer, demo controls |
| Maternity | — | **Does not exist.** There is no persona, no data and no workflow. Obstetrics is modelled as a capability, but no synthetic hospital lists it, and `bbmp_maternity.csv` is not ingested. Not built, to avoid fake functionality. |

Each reviewed screen was checked for navigation, primary and secondary workflow, map behaviour, realtime behaviour, errors, loading, empty states, phone layout and keyboard/accessibility.

---

## 11. Tests and verification

| Command | Result |
|---|---|
| `npm run typecheck` (builds every workspace, including the four Vite production builds, plus tests typecheck) | ✅ exit 0 |
| `npm run test:unit` (25 suites) | ✅ exit 0 |
| `npm run test:integration` (parity, mapping parity, 100+ check API runtime suite) | ✅ exit 0: parity ✓, mapping parity ✓, runtime **124 passed, 0 failed** |
| `npm run build:lambdas` | ✅ exit 0 |
| `npm run data:validate` | ✅ exit 0: all 7 canonical facilities pass invariant and evidence validation |
| `npm run demo:check` (API running) | ✅ `STATUS: READY`: all four app builds (map worker bundled where needed), 7 lambda handlers load, synthetic data labelled, API health, RBAC 401, malformed event 400 |

**Browser verification.** Edge (headless) was driven through the DevTools protocol against `npm run dev`, with scripted scenarios through the real event API. The scratch tooling is not committed.

- **Flagship flow in every app**: reset → emergency + dispatch → Hebbal accepts → Indiranagar accepts → Whitefield limited → GPS ×2 → Hebbal ED unavailable → reroute → arrival.
- **Hospital console, through its own buttons**:
  - Accept (with confirmation and the "heading here" effect).
  - Accept with limits (reason picker, then send).
  - Report ED unavailable (confirmation dialog, then reroute toast).
- **Command Center**:
  - Marker click opens the popup and the detail panel, and the hash updates.
  - The breadcrumb returns to the list; *View case* shows the decision trace; browser Back works.
  - Search for "indira", then Enter, selects the hospital.
  - The *Hospitals accepting* shortcut filters the list and the map.
  - The Activity filter and *Why & evidence* expand.
  - The System status drawer shows the shadow authority read-out.
  - Keyboard Tab shows the focus ring.
- **Phone width (390px)**: all four apps, plus an overflow scan at 390px and 768px.

No browser console errors were logged during these runs.

---

## 12. Known limitations

**Interaction library and clinical data**
1. **ReactBits was not used.** It is not installed, and the brief allows it only if it is already available. Motion uses CSS and the Web Animations API instead.
2. **Patient clinical records** (labs, medications, reports, care team, appointments) do not exist in the backend (Phase 7). They are shown as *Not connected yet*, not mocked.
3. **The hospital hierarchy stops at the service level.** JIVA does not receive building, floor, ward, room or bed data; that is its privacy model. The facility panel says so instead of inventing beds.
4. **Hospitals cannot see severity.** It is not part of `PatientState`, and the emergency event is not delivered to the hospital role. Request cards show the reported condition and the required care instead.

**Backend behaviour the UI works around** (found during this work, not changed; the core is frozen)

5. Case timelines from `/api/cases/:id/timeline` **omit routing events**: `destination.changed` and `route.recalculated` carry only `ambulanceId`. Patient and crew timelines therefore show routing changes live, but not after a reload.
6. System-sourced external events, such as the demo dispatch, are **recorded twice** in the ledger (on ingest and by the bus listener). All UIs de-duplicate by `eventId`.

**Map and layout**

7. The basemap is a GPU re-tone of raster tiles. Per-feature styling (POI suppression, label density) would need a vector tile source, which would be an architecture change and was not made.
8. Toasts (bottom-right) can briefly cover panel content. Popups can extend past the map edge at very small sizes; MapLibre anchors them automatically.
9. **Bundle size**: MapLibre makes the map apps about 1.4 MB of JS (about 400 kB gzip). Code-splitting the map was not attempted.

**Housekeeping**

10. Unused Vite template files were left in place: `src/App.css`, `src/assets/*`, `public/icons.svg`, and `apps/management-web/tailwind.config.js` (a v3 config that Tailwind v4 ignores and which still lists the old dark palette).
11. There are no automated UI tests in the repository. UI verification was typecheck/build plus scripted browser runs. A Playwright suite would be the natural next step.
12. Nothing is committed. Review with `git status` / `git diff`.
