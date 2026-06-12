---
name: drmed-booking-and-intake
description: Use when working on any DRMed patient intake — appointments, public bookings, the staff "+ New appointment" slide-over, or public self-registration — i.e. anywhere a patient enters the system ahead of or at a visit. Trigger whenever the user mentions appointment, appointments, booking, book, /schedule, schedule form, submitBookingAction, "+ New appointment", new-appointment-sheet, createStaffAppointmentAction, searchPatientsAction, getPatientUpcomingAppointmentsAction, /register, registration, self-registration, submitRegistrationAction, register-poster, RegistrationLinkButton, the shared booking core (lib/appointments/timing.ts, decideAppointmentTiming, lib/appointments/create.ts, createAppointmentGroup, loadServices, lib/patients/resolve.ts, resolvePatient, resolvePatientCore), KINDS_PER_BRANCH, BOOKING_BRANCHES, diagnostic_package, lab_request, doctor_appointment, home_service, manilaSlotFor, isValidSlot, minutesOfDayHHMM, dayWindowFor, physician availability, physician_schedules, physician_schedule_overrides, clinic_closures, scheduled_at, pending_callback, booking_group_id, walk_in_name, walk-in appointment, pre_registered, patient dedup, StaffBookingSchema, RegistrationSchema, booking conflict, "Book anyway", override, notifyAppointmentBooked, self-book QR, physician_slot_blocks, empty-slot hold, or any route under /staff/appointments, /staff/registration, /schedule, /register, /register-poster. Also trigger on "why didn't this appointment confirm", "add a booking branch", "the slot conflict", "a patient wants to register", or "hold a doctor's slot". Don't make Claude rediscover the shared booking core or the strict-vs-relaxed timing model from scratch.
---

# DRMed booking & patient intake

## What this is

Everything that gets a patient *into the system before/at a visit*: the public booking form (`/schedule`), the staff "+ New appointment" slide-over (`/staff/appointments`), and public self-registration (`/register`). All three share **one booking core** so behaviour can't drift between them. An appointment is *intent ahead of time*; a **visit** (`/staff/visits/new`) is the actual encounter — different subsystem (see `drmed-payments` for visits/payments).

**Foundational rule:** registration AND booking are **always optional**. A pure walk-in must work with zero online interaction (reception uses `/staff/patients/new` + `/staff/visits/new`, or the slide-over's walk-in mode). Keep public copy inviting, never coercive.

## The shared booking core (extracted PR1, 2026-05-30)

```
src/lib/appointments/
├── timing.ts     ← decideAppointmentTiming() — PURE, unit-tested, no DB, no server-only
│                   + types: ServiceRow, BookingConflict, ConflictKind, DayWindowLike, TimingArgs
└── create.ts     ← createAppointmentGroup(admin, input) — orchestrator (DB) + loadServices()
                    + PatientResolution, CreateAppointmentInput, CreateAppointmentResult
src/lib/patients/
└── resolve.ts    ← resolvePatientCore(deps, fields) PURE + resolvePatient(admin, fields) wrapper
src/lib/validations/
├── booking.ts        ← BOOKING_BRANCHES, KINDS_PER_BRANCH, manilaSlotFor, isValidSlot,
│                       minutesOfDayHHMM, BookingSchema/ExistingPatientBookingSchema (public, strict ≥1h)
├── staff-booking.ts  ← StaffBookingSchema (relaxed timing + patient-mode discriminator + override/send_confirmation)
└── registration.ts   ← RegistrationSchema (/register)
```

**Why the split:** `timing.ts` is pure (no DB, no `import "server-only"`) so it's vitest-tested cheaply; `create.ts` does the DB orchestration around it. Keep that boundary when extending — put decision logic in `timing.ts`, I/O in `create.ts`.

## The branch model — `KINDS_PER_BRANCH`

Four booking branches (`BOOKING_BRANCHES` in `booking.ts`), each maps to allowed `services.kind` and a status/time rule:

| Branch | Allowed `services.kind` | Result |
|---|---|---|
| `diagnostic_package` | `lab_package` | **confirmed**, no time (walk in during hours) |
| `lab_request` | `lab_test` | **confirmed**; a slot is required only if a picked service has `requires_time_slot` (else walk-in) |
| `doctor_appointment` | `doctor_consultation` | physician availability decides: by-appointment (no schedule rows) → **pending_callback**; else a real slot |
| `home_service` | `lab_test`, `lab_package` | always **pending_callback** (reception coordinates) |

`KINDS_PER_BRANCH` lives in `booking.ts` (client-safe) so the public form, the staff slide-over, AND the server all agree. One appointment row is inserted **per service**, all sharing a `booking_group_id` so reception sees a multi-service request as one card.

## `decideAppointmentTiming` — strict vs relaxed, and the conflict model

Pure function: given branch + loaded `ServiceRow[]` + a validated `scheduledAt` + (for doctor) a pre-fetched availability context, returns `{ pendingCallback, scheduledAtIso, conflicts[] }` or a structural error. It **collects conflicts, never hard-blocks** — the caller decides:

- **strict mode** (public `/schedule`): any conflict → return the first conflict's message as a hard error (byte-identical to the historical public messages, in closure → window → hours → concurrency order).
- **relaxed mode** (staff slide-over): conflicts are returned for an **overridable warning** ("⚠ … Book anyway"); on override the booking proceeds and the override is audit-logged.

`ConflictKind`: `day_closed`, `doctor_unavailable`, `outside_hours`, `slot_taken`. The doctor availability context (closure?, `dayWindowFor` window, existing-booking count, `allowConcurrent`) is fetched in `create.ts` and passed in — `timing.ts` stays DB-free.

**Slot validation:** `manilaSlotFor(date)` → `{dayOfWeek,hour,minute,dateISO}` in Asia/Manila (UTC+8, no DST); `isValidSlot` = Mon–Sat, 30-min boundary, 08:00–16:30. Public timing also enforces ≥1h-ahead + ≤60d; **staff relaxed timing drops the ≥1h rule** (same-day/short-notice allowed), keeps valid-slot + 60-day cap.

**Physician availability:** `dayWindowFor(dateISO, dayOfWeek, {blocks, overrides})` returns a **single** open window per day — it CANNOT express a midday hole. That's why the planned empty-slot-hold feature (PR3 / spec §7, table `physician_slot_blocks`, NOT built yet) needs its own overlap check wired into the conflict surfaces here, not into `dayWindowFor`.

## Patient resolution & dedup (`resolve.ts`)

`resolvePatient(admin, fields)` does **silent dedup**: match on `lower(email) + last_name + birthdate` → reuse; else insert with `pre_registered: true`. It never overwrites an existing row's contact fields. The pure core `resolvePatientCore({findExisting, insertPatient}, fields)` is dependency-injected so it's vitest-tested without a DB.

**No-orphan-patient pattern:** `createAppointmentGroup` resolves the patient via an injected **thunk it calls only after timing/conflicts pass** — so a failed booking never leaves a stray patient row. Preserve this when changing the order of operations.

Self-registered / publicly-booked patients carry `pre_registered: true` and **flow straight into reception's tools** — `searchPatientsAction` (slide-over), `/staff/patients`, and `/staff/visits/new` all find them, with a "Pre-reg" / "Pre-registered · verify" badge so reception knows to verify ID at the counter.

## The three surfaces

| Surface | Entry | Action | Mode |
|---|---|---|---|
| **Public booking** | `/schedule` (`booking-form.tsx`, ~1,000-line client form — do NOT refactor it) | `submitBookingAction` (honeypot, rate-limit `public_booking`, portal session) | strict |
| **Staff slide-over** | `/staff/appointments` header "+ New appointment" (`new-appointment-sheet.tsx`, `Sheet` right-panel) | `createStaffAppointmentAction` + `searchPatientsAction` + `getPatientUpcomingAppointmentsAction` (`new-appointment-actions.ts`) | relaxed + override |
| **Self-registration** | public `/register` (`register-form.tsx`) + reception QR poster `/register-poster` + `/staff/registration` page + `RegistrationLinkButton` on the appointments header | `submitRegistrationAction` (honeypot, rate-limit `patient_registration`) | n/a (no appointment) |

Patient modes in the staff slide-over: **Existing** (search → pick → shows upcoming), **New** (mini-form → `resolvePatient`, email required for dedup+confirmation), **Walk-in** (`walk_in_name`+`walk_in_phone`, no `patient_id` — so the "+ Start visit" button won't appear until reception registers them on arrival). `appointments.created_by` is stamped with `requireActiveStaff().user_id` (= `auth.users.id`).

`/register` records RA-10173 consent (`method: 'self_registration'`) for a **new** registrant only and emails the DRM-ID; a dedup match emails the DRM-ID to the on-file address and **does not show it on screen** (enumeration safety). Consent specifics → `drmed-rls-and-auth`.

Confirmations reuse `notifyAppointmentBooked({appointmentId, patientId})` (SMS via Semaphore + email via Resend; re-fetches the row itself, works for staff-created rows; skips gracefully when no phone/email). The slide-over's "Send confirmation" checkbox gates it.

## UI primitives this subsystem added

- `src/components/ui/sheet.tsx` — right-pinned slide-over (bottom sheet on mobile) on `@base-ui/react/dialog`; positioning is pure className, the primitive has no `side` prop.
- `src/components/ui/qr-code.tsx` — local SVG QR via `qrcode.react` (no third-party service → no privacy leak). Reused by the self-book QR, `/register-poster`, and `RegistrationLinkButton`.

## Testing

vitest (`npm test`) covers the pure logic: `timing.test.ts` (branch→status/time + conflict matrix), `resolve.test.ts` (dedup), `staff-booking.test.ts` + `registration.test.ts` (schema edges). Modules under test must not `import "server-only"`. The DB orchestration (`createAppointmentGroup`, the actions) is verified by `npm run typecheck` + `npm run build` + a manual/Playwright smoke against the **local** Supabase stack (see the local-UI-smoke recipe in memory).

## Hard rules

- **Registration & booking are optional.** Never gate service behind them; the walk-in path must work with no online step.
- **Don't refactor `booking-form.tsx`** (the public client form) — share server-side via the booking core instead; behaviour for the public flow must stay preserved.
- **Resolve the patient via the thunk, after timing passes** — no orphan patient rows on a failed booking.
- **`KINDS_PER_BRANCH` is the single source of truth** for branch↔service-kind; it lives in `booking.ts` (client-safe), imported by the form, the staff action, and the server.
- **A new booking branch** = update `BOOKING_BRANCHES` + `KINDS_PER_BRANCH` + `decideAppointmentTiming` + both schemas + the form/slide-over filters. Add a `timing.test.ts` case.
- **Enumeration safety on public surfaces** — never reveal a DRM-ID for a dedup match on a public page; email it to the on-file address only.

## Reference docs (deeper detail)

- Spec: `docs/superpowers/specs/2026-05-30-staff-appointment-intake-design.md` (Features A/C/B; §7 = the not-yet-built empty-slot holds).
- Plans: `docs/superpowers/plans/2026-05-30-staff-new-appointment-pr1.md` (Feature A), `…-register-self-registration-pr2.md` (Feature C).

## Related skills

- **`drmed-rls-and-auth`** — consent recording (`patient_consents`, the `self_registration` method, the release gate), audit obligations, rate-limit buckets, `requireActiveStaff`.
- **`drmed-migrations`** — schema changes (e.g. PR3's `physician_slot_blocks` table), the IPv6 remote-push gotcha, regen types.
- **`drmed-payments`** — what happens AFTER intake: visits, payment-gating, result release.

## When this skill should NOT trigger

- Visits / payments / cash drawer / result release — that's post-intake; use `drmed-payments`.
- Lab result entry or PDFs — use `drmed-result-templates`.
- Pure auth/RLS/consent-recording mechanics with no booking surface — use `drmed-rls-and-auth`.
- A migration with no booking logic — use `drmed-migrations`.
