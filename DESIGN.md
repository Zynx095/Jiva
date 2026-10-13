# JIVA Design System

How JIVA looks, moves and speaks across the six apps: Command Center (management), Ambulance, Hospital, Patient, Doctor workspace and the separate Demonstration portal.
The tokens are in `packages/ui/src/styles/jiva.css` and the components are in `packages/ui/src`. Every app imports both, so there is one source of truth.

> **The rule:** optimise for "I immediately understand what this does", not "lots of animation". JIVA's complexity should feel simple.

---

## 1. Principles

**Every screen answers five questions within seconds:**

1. **Where am I?** The header shows the app and its context (hospital name, ambulance call sign, case id). Breadcrumbs appear on every drill-down.
2. **What is happening?** Headline numbers, status badges and a live activity stream.
3. **What matters right now?** One primary emphasis per screen: an open request, a reroute, an active emergency.
4. **What can I do?** The primary action is the most visible element and is reachable in one or two interactions.
5. **What happens next?** Consequences are stated before and after an action ("JIVA will ask other hospitals").

**Progressive disclosure has four levels:**

| Level | Question | Where it lives |
|---|---|---|
| 1 | What is happening? | Cards, badges, headline numbers, plain sentences |
| 2 | What can I do? | Buttons, filters, links between related entities |
| 3 | Why did it happen? | "Why & evidence", decision trace, hospital answers, reasons |
| 4 | Technical evidence | `TechnicalDetails`: event ids, correlation/causation ids, snapshot/audit/policy hashes, raw payloads |

Everyday users never have to read level 4. Operations and audit users can always reach it.

**Honesty comes before polish:**
- Unknown stays unknown. A hospital with no current answer is shown as *No current response* (gray, `?`), never as available.
- Synthetic data is always labelled: the *Demo data* badge, *Synthetic route · mock provider*, *Simulated demo response*, *AI-generated · advisory only*.
- A feature without backend data is shown as **not connected**, never mocked. Patient health records are the example: they are labelled *Coming later*.

**Cause → effect.** An action shows four states: idle, then pending ("Sending…"), then success (✓) or error (✕ with the reason and a retry). The downstream effect is then shown where it happened, for example "AMB-BLR-001 is now heading here · 22 min".

---

## 2. Identity

### Colour

Light only. A warm white page, pure white panels, cream for secondary surfaces, one healthcare green, one warm neutral family, and three colours that carry meaning: amber (waiting), muted blue-grey (information) and clinical red (critical). Do not add other hues; most content is neutral and strong colour is reserved for actions and states.

| Token | Hex | Use |
|---|---|---|
| `canvas` | `#faf9f6` | The page background (warm white) |
| white | `#ffffff` | Panels, cards, header |
| `ink-100` | `#f3f0e7` | Cream secondary surface, icon chips, subtle fills |
| `ink-200` | `#e8e5dc` | Warm borders and dividers |
| `ink-300` | `#d9d1c1` | Input outlines, stronger borders (`ink-400` on hover) |
| `ink-900` | `#202820` | Headings, primary text (15:1) |
| `ink-700/600` | `#404840` / `#545c53` | Body and secondary text |
| `ink-500` | `#636b62` | Lightest allowed text colour (5.5:1 on white, 4.8:1 on cream) |
| `ink-400` | `#9a9f96` | Decorative only (chevrons, separators, placeholders): **never body text** |
| `brand-700` | `#236b4b` | Primary buttons, links, active tab, route (6.4:1 on white) |
| `brand-800` | `#1b573c` | Hover / pressed green |
| `brand-50` / `brand-200` | `#e8f2eb` / `#c9dfd0` | Positive badge fill / border |
| `warn-700/800` on `warn-50` | `#7f5616` / `#664512` on `#fbf5e8` | Pending response, limited, stale, needs attention |
| `info-800` on `info-50` | `#364855` on `#eef2f5` | Informational notices: "Demo data", "Synthetic demo patient" |
| `danger-600/700` | `#c43d3d` / `#a82f32` | Critical emergency, declined, unavailable, destructive actions, errors |
| `danger-50` / `danger-200` | `#fbecec` / `#eecaca` | Soft red surface / border |

- The neutrals are warm (cream to deep green-black). Do not mix in cool Tailwind grays or Tailwind's default amber.
- Demo/synthetic labels use the **info** tone, not amber, so amber keeps meaning "needs attention".
- No dark theme, purple, neon, rainbow gradients or glass panels.
- Shadows are tinted with ink and come from one top light source. Elevation is reserved for floating layers: popovers, toasts, drawers and map controls.
- There are no gradients, glass effects, neon, glows or purple "AI" styling. AI output is styled like any other neutral content and is labelled as advisory.

### Typography

- **Plus Jakarta Sans Variable** is self-hosted through `@fontsource-variable` (OFL-1.1) and imported once per app via `@jiva/ui/src/fonts`. There is no runtime font CDN.
- Font sizes:
  - Body text is 14px in operations apps and 15–16px on the patient screen.
  - The minimum size is 12px. Only the patient journey labels on phones use 11px.
- Headings are semibold with slightly negative tracking, e.g. `tracking-[-0.01em]`. Use sentence case and avoid uppercase labels.
- Numbers that change (ETAs, counts, countdowns) use `tabular-nums` so they do not jitter.
- IDs and hashes in technical views use the system monospace.

### Shape, space, icons

- **Radius:** 12px (`rounded-xl`) for cards and panels, 16px for dialogs, 8–12px for buttons (by size) and inputs, full rounding for status badges, chips and pills. Inner elements are tighter than their containers.
- **Spacing:** cards use 16px padding on phones and 20px from `sm` up; sections inside panels are 20–32px apart.
- **Surfaces:** a hairline ring (`ink-200`) plus a barely visible lift; real shadows only on things that float (popovers, toasts, dialogs, map controls, the pinned patient context).
- **Heights:** buttons 32 / 40 / 48px (`sm` / `md` / `lg`); inputs 36px; primary decisions use `lg`.
- **Icons:** use the custom set in `components/Icon.tsx`: a 24px grid, 1.75 stroke and round joins. `iconSvg()` renders the same icons for map markers. Icons are decorative (`aria-hidden`) unless they carry a `title`.
- **Logo:** a live pulse inside a rounded green square (`JivaLogo`). The same mark is `apps/*/public/favicon.svg`.

---

## 3. Status language

A status is always shown as **icon + label + colour**, never colour alone. Use the helpers in `lib/status.ts` rather than inventing labels.

| Tone | Colour | Meaning | Examples |
|---|---|---|---|
| `ok` | green | Accepted, active, available, confirmed | Accepted ✓, Available ✓, To hospital, Arrived |
| `warn` | amber | Pending, limited, stale, needs attention | Awaiting response ⏱, Limited ◐, Arrived · awaiting handover, Seed data, Simulated reading |
| `danger` | red | Rejected, unavailable, critical, error | Declined ✕, Unavailable ⊘, Critical |
| `neutral` | warm gray | Unknown, expired, historical, inactive | No current response ?, Expired ⌛, Withdrawn |
| `info` | blue-grey | Information about the data, never a case state | Demo data, Synthetic demo patient, Demo case |

**Case-specific means case-specific.** A hospital's `operationalState.acceptance` is its latest answer to *any* case. A badge about one case uses that case's own referral answer (`referralStatus`, `caseResponses`), the hospital slot only when `acceptanceCaseId` names the case, and "unknown" otherwise — a hospital declining one patient never changes another patient's badge.

Helpers:
- `acceptanceStatus()` covers hospital answers.
- `capabilityStatus()` covers ED, ICU and trauma flags.
- `ambulanceStatus()` and `patientStatus()` cover lifecycles.
- `severityStatus()` covers the reported severity.
- `dataStatus()` covers provenance.

Every helper also returns a one-sentence `hint`, which is used as the tooltip.

---

## 4. Components (`@jiva/ui/src`)

| Component | Purpose and rules |
|---|---|
| `JivaButton` | Roles: `primary` (the one most important action of the workflow), `secondary`, `tertiary` (green text action), `ghost` (toolbar/dismiss), `danger` (confirms a destructive action), `critical` (an emergency action, e.g. *Report an emergency*, *Submit emergency*) and `*-soft` outlines for consequential choices next to a primary (*Accept with limits*, *Decline request*). Labels say what happens (*Accept emergency*, *Save vital signs*, *Upload document*), never *Go* or *Process*. States: hover, pressed (`scale .98`), focus-visible, disabled (50% and desaturated) and loading. |
| `AsyncButton` / `useAsyncAction` | For any action that calls the API. It shows pending, success and error (with the message in the tooltip and a live region) by itself. Actions resolve to `null` or an error sentence. |
| `JivaCard`, `CardHeader`, `DataRow`, `SectionLabel` | White surfaces. `accent` adds a left stripe carrying state. Selectable rows are `<button>`s, not cards with click handlers. |
| `JivaBadge`, `JivaStatus`, `StatusDot` | The status vocabulary. A dot is always paired with text. |
| `JivaMetric` | A headline number. When it has `onClick` it works as a shortcut into the list that explains it, e.g. *Awaiting hospital answer* opens Hospitals filtered to pending. |
| `Flash` | Briefly highlights a value when it changes, so the change is noticed without a notification. It never flashes on first render. |
| `JivaTimeline` | Newest first and grouped by day. Each entry can expand to its source and evidence. Entries that arrive live slide in. |
| `JivaTabs` + `TabPanel` | ARIA tabs with arrow, Home and End keys. Counts and an amber "attention" dot are optional. `size="sm"` for narrow side panels. |
| `JivaFilter`, `ToggleChip` | Instant filter chips. *All* clears the filter. They show counts, the number of active filters, and a *Clear* or *Reset* action. |
| `JivaSearch` | Global combobox, opened with `/` or Ctrl/⌘+K. Results are grouped by type and support arrow keys, Enter and Escape. |
| `JivaBreadcrumbs` | Shows the drill-down path. Every level except the current one is clickable. |
| `JivaDrawer`, `JivaModal` | Both use native `<dialog>`, which traps focus, closes on Escape and returns focus. The modal is only for decisions with consequences, such as *Report ED unavailable*. |
| `ToastProvider` / `useToast` | Quiet, grouped realtime notifications (same `groupKey` → "×3"), at most four, pausing on hover and announced politely. |
| `EmptyState`, `JivaSkeleton`, `SkeletonRows` | Use these instead of "No data" or spinners. |
| `TechnicalDetails`, `eventTechnicalFields` | The level-4 disclosure. Collapsed by default. |
| `AppHeader`, `JivaLogo`, `ConnectionPill`, `DemoBadge`, `PersonaSelect` | The shell. It has a skip link, app and context, optional search, connection state and an honesty marker. The persona switch is demo-only. |
| `describeEvent`, `humanizeReason` | Turn any canonical event into a sentence for an audience (`ops`, `crew`, `hospital`, `patient`). Engine reasons that contain ids become names. |
| `caseResponses`, `isAwaiting` | Replay the acceptance protocol to show who was asked, who answered and what is still open. This is for display only; it decides nothing. |

Do not create per-app copies of buttons, badges or cards. Extend the shared component instead.

---

## 5. Maps

- **Architecture is unchanged:** MapLibre GL, OpenStreetMap raster tiles, and Valhalla / OSRM / Mock routing behind the existing provider chain.
- **Basemap:** the same OSM tiles are re-toned on the GPU (saturation −0.9, contrast −0.2, raised blacks, 78% opacity over `#f7f8f7`). This follows the light grayscale styles (Snazzy Maps' *Subtle Grayscale* and *Ultra Light*) without changing provider or using Google Maps. Data on the map carries the only strong colour.

### Markers

Each marker type has its own shape, colour and label.

| Marker | Shape | Colour | Label and behaviour |
|---|---|---|---|
| Hospital | Rounded square with **H** | Acceptance tone. White with a gray outline when unknown | A corner glyph repeats the state |
| Ambulance on a job | Dark pill with call sign | Dark ink | Glides about 0.9 s between GPS fixes |
| Idle or arrived ambulance | Compact chip | — | Offset so it never hides a hospital |
| Emergency | Red dot | Red | Soft ring while the case is open |

Labels appear on hover, focus or selection. Markers are buttons with an `aria-label`.

### Routes

- The active route is `brand-800` over a white casing.
- Alternatives and the route abandoned in a reroute are dashed in `ink-400`.
- A provider chip always states *Synthetic route · mock provider · no live traffic* when that is the case.

### Overlay slots

The map is never covered by permanent panels.

| Slot | Contents |
|---|---|
| Top-left | Layers and filters |
| Top-right | Camera tools: recenter, fit route |
| Bottom-left | Legend (hidden on phones) and provider chip |
| Bottom-right | Zoom and OSM attribution |

### Interaction

- **Map and list are synchronised.** Clicking a marker selects it, opens a compact popup with the details and route actions, and shows the detail panel. Clicking a list row selects and flies to the marker.
- **Selection** is kept in the URL hash (`#hospital/HOSP-BLR-001`), so browser Back walks back through drill-downs.

---

## 6. Motion

- Durations: 150 ms for hover, press and colour changes; 180 ms fades; 240 ms panel entry (`animate-enter`, 4px rise); 260 ms toasts, drawers and dialogs. One easing: `--ease-out` (`cubic-bezier(0.22, 1, 0.36, 1)`).
- Motion explains change (a new entry slides in, a value flashes once, progress fills). Nothing pulses for decoration; the only loops are the live dot, the open-emergency ring on the map and skeleton shimmer.
- `prefers-reduced-motion` removes all of it (see §9). Motion never delays an action or blocks a click.

## 7. Patterns for clinical safety

- **Whose record is this?** The doctor workspace pins the selected patient (case id, reported symptoms, encounter, responsible doctor, status) and the section tabs under the header from tablets up. The selected patient row carries a green ring and a left bar.
- **Never carry edits to another patient.** Per-patient panels remount when the patient changes. Forms report unsaved edits (`apps/doctor-web/src/unsaved.tsx`); switching patients with edits open asks first, naming both patients ("Keep editing CASE-…" is the default; "Discard and open CASE-…"), and a reload or close warns.
- **What needs me now?** Each screen leads with its decision: open hospital requests (with the request time and a countdown), the crew's next action with the job's progress, drafts awaiting the doctor's authorisation, the patient's current care.
- **Honest estimates.** An ETA is labelled an estimate and says its basis (synthetic route, no live traffic, last known position when the unit has sent no GPS fix since the report).

## 8. Realtime feedback

When something changes, say so in context. Do not silently replace a number.

| Change | Feedback |
|---|---|
| Notable event (answer, reroute, arrival, ED unavailable) | Grouped toast with a *View* shortcut |
| Headline number or ETA changed | `Flash` on the value |
| New activity | Timeline entry slides in |
| GPS fix | Marker glides; no toast, no timeline row (GPS rows can be shown on demand) |
| Reroute (crew) | Persistent card: old destination → why → re-evaluated → new destination + ETA, until acknowledged |
| Answer sent (hospital) | Confirmation card stating the effect ("AMB-BLR-001 is now heading here") |
| Connection | `ConnectionPill`: Live / Connecting… / Reconnecting… / Offline — showing last known data |

Each app resyncs from the API about 120 ms after every event, and every 15 s as a safety net.

---

## 9. Empty, loading and error states

- **Empty** states say what is empty, why, and what will make something appear. Example: *"No active emergencies — All emergency cases are currently stable…"*.
- **Loading** uses skeletons that keep the layout's shape. There are no full-screen spinners.
- **Errors** say what happened, what it means and what to do. Example: *"Hospital response could not be submitted. This request is no longer open… Use the buttons above to try again."* Safety-critical failures are never hidden.

---

## 10. Voice

- Use plain, specific and active language with sentence case and no exclamation marks.
- **Patient screen:**
  - Use plain names: *Intensive care*, *Injury (trauma) care*, *Your hospital*.
  - Give no clinical interpretation and no "healthy/unhealthy" judgements.
  - Always offer *Call 108*.
- **Operations screens:** use short labels (*ICU*, *Trauma*, *Awaiting response*). IDs are allowed.
- **AI text** is always labelled *AI-generated · advisory only* and never presented as a decision.

---

## 11. Accessibility

- Every screen has a skip link, semantic landmarks (`header`, `main`, `aside`, labelled `section`s) and one `h1`/`h2` hierarchy per view.
- `:focus-visible` shows a 2px `brand-600` ring on everything. Map markers are focusable buttons.
- Text meets 4.5:1 contrast. Meaningful icons meet 3:1. Status is never colour-only.
- `prefers-reduced-motion` turns off animations, marker gliding, value flashes and map flights.
- Toasts and connection state use polite live regions. Countdowns are `role="timer"` and are not announced every second.
- The minimum target size is 24px, and primary decisions are 40–48px.
- Checked with axe-core (WCAG 2.1 A/AA) on all six apps, including open forms and dialogs: 0 violations at the time of the redesign. Map markers' accessible names start with their visible label.

## 12. Responsive

| Role | Phone | Desktop |
|---|---|---|
| Patient | Single column: journey, care team, what happens next, help, records, activity | Two columns: care and help on the left; records, summary and activity on the right |
| Hospital | Requests first, side panels below | Requests and patients on the left, facility, briefs and activity on the right |
| Ambulance | Decision bar (2×2), map, then job panel | Decision bar, map and job panel side by side |
| Command Center | KPIs scroll, map, collapsible demo bar, tabs | Map and demo controls with a 460px details panel |
| Doctor | Patient list, then the record (context scrolls away) | Patient list (stays in view) and the record with the pinned patient context |
| Demo portal | Scenario list, then steps | Scenario list beside the steps and the live case strip |

The header actions wrap. No screen scrolls horizontally at 390px.

## 13. Performance

- The map is created once. Markers update their attributes instead of re-mounting. Routes keep a stable reference per calculation, so GPS fixes never redraw them.
- Event lists are capped (Command Center: 400 in memory, 150 rendered). Search uses `useDeferredValue`. The clock re-renders every 1 s only while a deadline is visible, otherwise every 5 s.
