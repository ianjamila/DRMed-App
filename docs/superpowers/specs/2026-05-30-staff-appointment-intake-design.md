# Staff Appointment Intake — Design Spec

- **Date:** 2026-05-30
- **Project:** DRMed (`drmed.ph`) — Next.js 16 + Supabase
- **Status:** Approved design. Brainstormed from an eaglewatch-rooted session against `~/Claude/DRMed`; **to be implemented from a DRMed-rooted session.**
- **Provenance note:** This file was written (not committed) from another session. It is currently **untracked** — `git add` it onto the correct branch in the DRMed session.

---

## 1. Context & problem

Appointments today can only be created through the public `/schedule` flow
(`submitBookingAction` in `src/app/(marketing)/schedule/actions.ts`), used by
anonymous visitors and logged-in patients (portal). Staff on
`/staff/appointments` can only **transition or delete** existing rows
(`transition-buttons.tsx` + `actions.ts`) — there is **no way to create an
appointment from inside the app**.

So reception that takes a phone-in booking, re-enters a booking from another
channel (Facebook/text), or wants to hold a doctor's slot has to leave the app
or use the public form. There is also no in-app patient self-registration
(currently a Google Form).

## 2. Goals

Three related features, built as **three separate PRs in order A → C → B**,
sharing this one design doc.

| | Feature | Surface |
|---|---|---|
| **A** | Staff "+ New appointment" (slide-over) | `/staff/appointments` |
| **C** | Registration-only self-service form + QR | new public route `/register` |
| **B** | Empty-slot hold (block a doctor time range, no patient) | physician schedule page |

### Use cases this serves
- **Phone-in booking** (future date/time, doctor consult, or pending callback).
- **Re-entering** a booking that arrived via another channel.
- **Holding a doctor slot** (feature B).
- **Self-service registration** without staff typing (feature C / the QR).

### Non-goals (explicitly deferred)
- **Same-day walk-in who is ready now** → use the existing **Create visit**
  flow (`/staff/visits/new`), not an appointment. An appointment is *intent
  ahead of time*; a visit is the encounter.
- **"+ Start visit" prefill from a walk-in appointment** — a nice enhancement
  (carry `walk_in_name`/`walk_in_phone` into the new-patient form on arrival)
  but it touches `visits/new`, which is under active change. Out of scope here.
- **Registration that also books** is already covered by `/schedule`; `/register`
  is details-only.

## 3. Decisions (locked during brainstorm)

1. **Placement:** slide-over panel on `/staff/appointments` ("while already in
   the page"), **not** a dedicated page.
2. **RBAC:** reception + admin (matches the page's existing gate).
3. **Patient modes:** Existing (search) · New (full record + dedup) · **Walk-in
   (name+phone, no record)** — kept, with the documented limitation that a
   walk-in appointment has no `patient_id`, so the existing "+ Start visit"
   button won't show until reception creates the patient at arrival.
4. **Booking types:** all four branches (diagnostic package, lab request, doctor
   appointment, home service), same as the public form.
5. **Timing:** **relaxed** for staff (same-day / short-notice allowed; the
   public "≥1 hour ahead" rule is dropped).
6. **Conflict warning — "warn at the right moments"** (NOT live-as-you-type):
   - On selecting an existing patient → show their upcoming appointments inline.
   - On submit, if a doctor+time is taken (or a slot is blocked — feature B) →
     show the conflict and require a **"Book anyway" confirm**; the override is
     audit-logged. Not a hard block.
7. **Confirmation:** reuse `notifyAppointmentBooked` (sends **both SMS and
   email**) with a "Send confirmation" checkbox (default ON). Walk-ins with a
   phone get an SMS.
8. **Slide-over self-book QR → `/schedule?src=staff_qr`** (the clean "let them
   do the whole thing themselves" escape hatch).
9. **Registration form (C):** show DRM-ID on screen + email it for a **new**
   registrant; for a **dedup match**, do **not** print the existing DRM-ID on a
   public page — email it to the address on file (enumeration safety).
10. **`/register` gets its own shareable QR/link** (poster / send-ahead), not
    buried in the slide-over.
11. **Empty-slot hold (B):** a dedicated `physician_slot_blocks` table; block a
    **time range** with a reason; **reception + admin** can create/remove.
12. **Extraction is server-side only:** share booking core + patient resolution;
    do **not** refactor the 1,038-line public client form `booking-form.tsx`.

## 4. Shared foundations (per DRMed `CLAUDE.md`)

- Gate writes with `requireActiveStaff` (`src/lib/auth/require-staff.ts`).
- **`audit()` on every write** (`src/lib/audit/log.ts`) — RA 10173.
- Server-only admin client (`src/lib/supabase/admin.ts`); never client-side.
- Server Action return shape: `{ ok: true, data } | { ok: false, error }`.
- Reuse helpers: `ipAndAgent` / `firstIssue` (`src/lib/server/action-helpers.ts`),
  `translatePgError`, `lib/rate-limit/check.ts`, Manila date helpers
  (`src/lib/dates/manila.ts`), and the availability helpers
  (`src/lib/physicians/availability.ts`: `dayWindowFor`, `minutesOfDay`;
  `manilaSlotFor` / `isValidSlot` in `src/lib/validations/booking.ts`).

### New shared server modules (the moderate extraction — PR 1)
- **`src/lib/patients/resolve.ts`** — `resolvePatient(admin, fields)`: silent
  dedup by `lower(email) + last_name + birthdate`, else insert
  (`pre_registered: true`). Extracted from `schedule/actions.ts`. Imported by
  the public action, the staff action, and `/register`.
- **`src/lib/appointments/create.ts`** — the booking core: branch → status /
  `scheduled_at` decision, slot validation, the physician conflict check, and
  the `insert one row per service with a shared booking_group_id`. The public
  `submitBookingAction` is refactored to call this; **behavior preserved**. The
  public action keeps its anonymous-only concerns in place (rate-limit,
  honeypot, marketing subscribe, portal session).

> Verified facts that shaped this: `dialog.tsx` is a small **centered** modal
> (`@base-ui/react/dialog`, `max-w-sm`) and `mobile-drawer.tsx` is the
> **left-hand mobile nav** (`md:hidden`) — neither is a reusable right-side
> sheet. `notifyAppointmentBooked` already sends **SMS + email** and re-fetches
> the row itself (works for staff-created rows). `appointments.created_by` →
> `auth.users(id)`. `dayWindowFor` reads a **single** window per date (a
> midday hole cannot be expressed via overrides → feature B needs its own
> table + a separate overlap check). No QR library is installed. `/privacy` and
> `/terms` exist; a `patient_consent` table exists (migration 0086) and a
> `feat/patient-consent-form` branch is **in flight**.

---

## 5. Feature A — Staff "+ New appointment" slide-over (PR 1)

### UI
- **New `src/components/ui/sheet.tsx`** — a small Sheet/SlideOver wrapping the
  `@base-ui/react/dialog` primitive (reuse `DialogOverlay`/`DialogPortal`):
  right-pinned, full-height, ~`max-w-md` on desktop; bottom sheet on mobile.
  ~50 lines. (Confirm the Popup accepts position overrides via `className` — it
  should, it's just a positioned popup.)
- `/staff/appointments/page.tsx` (Server Component) loads active **services**
  and **physicians** and passes them to a new client component
  **`new-appointment-sheet.tsx`** that renders the header `+ New appointment`
  button + the Sheet + the form. On success: close, `sonner` toast, refresh
  (page already has realtime, so the row appears).

### Form (progressive sections)
1. **Patient** — toggle Existing / New / Walk-in:
   - *Existing*: search box → `searchPatientsAction(q)` (ilike on
     `drm_id/first_name/last_name/phone/email`, limit 25). On pick →
     `getPatientUpcomingAppointmentsAction(patientId)` shows their upcoming
     appointments inline.
   - *New*: mini-form (first/last/middle name, birthdate, sex, phone, email,
     address), validated by the shared patient schema.
   - *Walk-in*: `walk_in_name` + `walk_in_phone` only.
2. **Booking type** (branch) — service list filters via `KINDS_PER_BRANCH`.
3. **Service(s) / Doctor** — multi-select services, or single consultation +
   physician for the doctor branch.
4. **When** — date + time, shown only when the branch can take a time. Relaxed.
5. **Footer** — "Send confirmation (SMS + email)" checkbox (default ON) +
   Cancel / Create. Plus the **self-book QR → `/schedule?src=staff_qr`**.

### Server action
`createStaffAppointmentAction(input)` in the appointments folder:
- `requireActiveStaff` + reception/admin gate.
- Validate with a **`StaffBookingSchema`** (relaxed-timing variant: same-day
  allowed, no `service_agreement`; carries the patient-mode discriminator +
  `override` + `skipConfirmation` flags).
- Resolve patient via `lib/patients/resolve.ts` (existing → fetch by id; new →
  dedup+insert; walk-in → none).
- Call `lib/appointments/create.ts` (branch → status/time, slot validation
  [relaxed], conflict check, insert rows sharing a `booking_group_id`,
  `created_by = session.user_id`).
- On conflict and `!override` → return `{ ok:false, error, code:'conflict',
  data:{ conflicts } }`; client shows it + "Book anyway" → resubmit with
  `override:true`. Override recorded in audit metadata.
- Audit `appointment.created_by_staff` (metadata: `via:'staff'`, `actor_role`,
  `patient_resolution`, `override_conflict`, `group_appointment_ids`).
- If `!skipConfirmation` → `notifyAppointmentBooked({ appointmentId: firstRow,
  patientId })` (skips gracefully when no phone/email).
- `revalidatePath('/staff/appointments')`; return `{ ok:true, data:{
  booking_group_id } }`.

### Migration
**None.** The `appointments` table already has every needed column
(`patient_id` nullable, `service_id` nullable, `walk_in_name/phone`,
`booking_group_id`, `home_service_requested`, `physician_id`, `scheduled_at`,
`status`, **`created_by`**).

---

## 6. Feature C — Registration-only self-service form (PR 2)

### Public route
`src/app/(marketing)/register/` — `page.tsx` + `register-form.tsx` (client) +
`actions.ts`:
- Fields: name/birthdate/sex/phone/email/address + **required RA-10173
  data-privacy consent** (links `/privacy`) + optional marketing consent.
- `submitRegistrationAction`: honeypot + **new `patient_registration`
  rate-limit bucket** → validate `RegistrationSchema` → `resolvePatient`
  (shared):
  - **New** → return DRM-ID for on-screen display **+ email it**;
    `pre_registered: true`; record consent on the existing `patient_consent`
    infrastructure; audit `patient.self_registered`.
  - **Dedup match** → **do not** return the DRM-ID to the client; email it to
    the on-file address; return `{ ok:true, data:{ matched:true } }` → success
    screen says "We found your record — we've emailed your DRM-ID"; audit
    `patient.self_register.matched`.
- Success screen: DRM-ID (new only) + "show this at the clinic" + next steps.

### QR component
`src/components/ui/qr-code.tsx` (client) renders QR **locally** (add
`qrcode.react`, or generate an SVG/data-URL via `qrcode` — no third-party
service → no privacy leak). Used by:
- A's slide-over self-book QR (`/schedule?src=staff_qr`).
- A **"Registration link"** button (QR + copy) on the appointments page header
  and/or `/staff/patients` (`/register?src=staff_qr`).

### Consent + migration
Build on the **existing `patient_consent` table (migration 0086)** and
`/privacy`; **do not** create a parallel consent system. **Coordinate with the
in-flight `feat/patient-consent-form` branch** — likely no new migration; confirm
the consent-recording shape in the DRMed session.

---

## 7. Feature B — Empty-slot hold (PR 3)

### Migration `supabase/migrations/00NN_physician_slot_blocks.sql`
- Table `physician_slot_blocks`: `id uuid pk`, `physician_id uuid not null
  references physicians(id)`, `starts_at timestamptz not null`, `ends_at
  timestamptz not null`, `reason text`, `created_by uuid references
  staff_profiles(id)` (newer-table convention), `created_at timestamptz default
  now()`. `check (ends_at > starts_at)`. Index `(physician_id, starts_at)`.
- **RLS + GRANTs + audit** per the `drmed-migrations` skill checklist. Decide
  the read path for the booking availability check (admin client vs an anon/staff
  SELECT policy). Regenerate types (`npm run db:types`).

### UI
On `/staff/.../admin/physicians/[id]/schedule`: a "Block time" form (date +
start/end + reason) → `createSlotBlockAction` (reception + admin); list future
blocks with remove → `removeSlotBlockAction`. Audit both.

### Booking integration
`dayWindowFor` returns a **single** open window and cannot express a midday
hole, so a **separate overlap check** is added: after the slot passes the open
window, reject/flag if it overlaps any `physician_slot_blocks` row for that
physician. Wire this into (a) the public doctor-branch booking, (b) the staff
submit conflict check, and (c) A's pre-submit conflict surface ("⚠ This time is
blocked — <reason>"). Store/compare in the **Manila** frame consistently
(`timestamptz`).

---

## 8. Testing & tooling

DRMed has **no unit-test runner** (only smoke scripts + `typecheck`/`build`).
- **Recommended:** add a minimal **vitest** setup (document the command in
  `CLAUDE.md`) to cover the pure logic in `lib/appointments/create.ts`
  (branch→status/time, slot validation, relaxed-timing + conflict edges) and
  `lib/patients/resolve.ts` (dedup). **Open decision** — settle in the DRMed
  session; fallback is a smoke script + manual walk.
- Always run **`npm run typecheck` + `npm run build`** before each PR (RSC
  serialization isn't caught by `tsc` alone).

## 9. Sequencing & coordination risk

- Build order **A → C → B**; each is its own branch off `main` + its own PR.
- A's extraction touches `schedule/actions.ts`; C touches consent. **Both
  overlap the in-flight `feat/patient-consent-form` work and the live edits to
  `visits/new` observed in another session.** → **Let that branch land first,
  rebase onto updated `main`, and do this work from a DRMed-rooted session.**

## 10. Open items to settle in the DRMed session

1. Vitest vs smoke-only (testing approach).
2. Exact consent recording for `/register` — reuse `patient_consent` (0086);
   confirm columns; coordinate with `feat/patient-consent-form`.
3. QR lib: `qrcode.react` (client) vs `qrcode` (server → SVG/data-URL).
4. Confirm `requireActiveStaff().user_id` is the `auth.users` id to stamp
   `appointments.created_by`.
5. RLS read path for `physician_slot_blocks` from the public availability check.
6. Confirm the `@base-ui/react/dialog` Popup accepts right/bottom positioning
   via `className` for the Sheet.
