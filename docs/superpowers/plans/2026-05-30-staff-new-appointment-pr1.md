# Staff "+ New appointment" Slide-over (PR 1 / Feature A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let reception/admin create an appointment from inside `/staff/appointments` via a right-pinned slide-over (existing / new / walk-in patient, all four booking branches, relaxed timing, overridable conflict warning, optional SMS+email confirmation, self-book QR).

**Architecture:** Extract the public booking core into two shared server modules — `lib/patients/resolve.ts` (dedup) and `lib/appointments/{timing.ts,create.ts}` (branch→status/time decision + insert) — refactor the public `submitBookingAction` to call them (behavior preserved), then build the staff path on top: a relaxed `StaffBookingSchema`, three server actions, a reusable `Sheet` primitive, a `QrCode` component, and the client slide-over form. The pure decision logic is unit-tested with **vitest** (the repo's first unit runner).

**Tech Stack:** Next.js 16 (App Router, RSC + Server Actions), React 19, Supabase (service-role admin client for writes, RLS server client for staff reads), Zod v4, `@base-ui/react` 1.4.1 dialog primitive, `sonner` toasts, `qrcode.react` v4, vitest v3.

**Spec:** `docs/superpowers/specs/2026-05-30-staff-appointment-intake-design.md` (§5 = Feature A). Open items from §10 settled before this plan: §10.1 → vitest; §10.3 → include QR in PR1 via `qrcode.react`; §10.4 confirmed (`requireActiveStaff().user_id` = `auth.users.id`); §10.6 confirmed (Sheet = className swap on `DialogPrimitive.Popup`).

**No migration:** the `appointments` table already has every needed column (`patient_id`, `service_id`, `physician_id`, `scheduled_at`, `status`, `notes`, `booking_group_id`, `home_service_requested`, `walk_in_name`, `walk_in_phone`, `created_by`) — verified in `src/types/database.ts:217-262`.

---

## File Structure

**Create:**
- `vitest.config.ts` — vitest runner config with `@/` alias, node env.
- `src/lib/patients/resolve.ts` — `resolvePatientCore` (pure, injected deps) + `resolvePatient(admin, fields)` wrapper. Extracted from `schedule/actions.ts`.
- `src/lib/patients/resolve.test.ts` — unit tests for dedup.
- `src/lib/appointments/timing.ts` — pure `decideAppointmentTiming` (branch→status/time + conflict collection) + types. No DB, no `server-only`.
- `src/lib/appointments/timing.test.ts` — unit tests for the timing/conflict matrix.
- `src/lib/appointments/create.ts` — `loadServices` + `createAppointmentGroup(admin, input)` orchestrator (DB fetch → `decideAppointmentTiming` → patient thunk → insert).
- `src/lib/validations/staff-booking.ts` — `StaffBookingSchema` (relaxed timing, patient-mode discriminator, override + send_confirmation).
- `src/lib/validations/staff-booking.test.ts` — unit tests for relaxed slot + discriminator + branch refinements.
- `src/app/(staff)/staff/(dashboard)/appointments/new-appointment-actions.ts` — `createStaffAppointmentAction`, `searchPatientsAction`, `getPatientUpcomingAppointmentsAction`.
- `src/components/ui/sheet.tsx` — right-pinned (bottom on mobile) slide-over on the `@base-ui` dialog primitive.
- `src/components/ui/qr-code.tsx` — local SVG QR via `qrcode.react`.
- `src/app/(staff)/staff/(dashboard)/appointments/new-appointment-sheet.tsx` — client form (the slide-over).

**Modify:**
- `src/lib/validations/booking.ts` — add client-safe `KINDS_PER_BRANCH` export.
- `src/app/(marketing)/schedule/actions.ts` — refactor `submitBookingAction` to call the extracted modules; remove the now-local copies.
- `src/app/(staff)/staff/(dashboard)/appointments/page.tsx` — load services+physicians, render the slide-over in the header.
- `src/app/(staff)/staff/(dashboard)/layout.tsx` — mount `<Toaster/>`.
- `package.json` — add `vitest` (dev) + `qrcode.react` (dep) + `test`/`test:watch` scripts.
- `CLAUDE.md` — document the single-test command.

---

## Task 1: Vitest tooling

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (scripts), `CLAUDE.md`

- [ ] **Step 1: Install vitest**

Run:
```bash
npm install -D vitest@^3
```
Expected: `package.json` devDependencies now lists `vitest`.

- [ ] **Step 2: Create the vitest config**

Create `vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// First unit-test runner in the repo. Pure logic only (no DB / no RSC) —
// modules under test must not `import "server-only"`. The `@/` alias mirrors
// tsconfig.json so test files import the same way app code does.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 3: Add test scripts to package.json**

In `package.json`, add to `"scripts"` (after the `"lint"` line):
```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 4: Verify the runner loads**

Run:
```bash
npx vitest run --passWithNoTests
```
Expected: PASS — exits 0 with "No test files found" (config parsed, no tests yet).

- [ ] **Step 5: Document the command in CLAUDE.md**

In `CLAUDE.md`, replace this paragraph:
```
There is no unit-test runner — only the smoke scripts above. If adding
a test framework, document the single-test command here.
```
with:
```
Unit tests run on **vitest** (`npm test` / `npm run test:watch`). Single
file: `npx vitest run src/lib/appointments/timing.test.ts`. Single test by
name: `npx vitest run -t "reuses an existing patient"`. Coverage is the pure
logic only (no DB / no RSC) — modules under test must not `import "server-only"`.
The smoke scripts above still cover the render pipeline + integration paths.
```

Also add two rows to the Common commands table (after the `npm run lint` row):
```
| `npm test` | Run vitest unit tests once |
| `npm run test:watch` | Vitest in watch mode |
```

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json package-lock.json CLAUDE.md
git commit -m "chore(test): add vitest as the unit-test runner"
```

---

## Task 2: Pure timing decision (`lib/appointments/timing.ts`)

**Files:**
- Create: `src/lib/appointments/timing.ts`
- Test: `src/lib/appointments/timing.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/appointments/timing.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { decideAppointmentTiming, type ServiceRow } from "./timing";

function svc(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: "s1", name: "Test", kind: "lab_test", is_active: true,
    fasting_required: false, requires_time_slot: false, allow_concurrent: true,
    ...over,
  };
}

describe("decideAppointmentTiming", () => {
  it("diagnostic_package is a confirmed walk-in: no time, no callback", () => {
    const r = decideAppointmentTiming({ branch: "diagnostic_package", services: [svc({ kind: "lab_package" })], scheduledAt: null });
    expect(r).toEqual({ ok: true, pendingCallback: false, scheduledAtIso: null, conflicts: [] });
  });

  it("home_service is always pending_callback", () => {
    const r = decideAppointmentTiming({ branch: "home_service", services: [svc()], scheduledAt: null });
    expect(r).toEqual({ ok: true, pendingCallback: true, scheduledAtIso: null, conflicts: [] });
  });

  it("lab_request with no requires_time_slot service is a confirmed walk-in", () => {
    const r = decideAppointmentTiming({ branch: "lab_request", services: [svc({ requires_time_slot: false })], scheduledAt: null });
    expect(r).toEqual({ ok: true, pendingCallback: false, scheduledAtIso: null, conflicts: [] });
  });

  it("lab_request needing a slot errors when none is given", () => {
    const r = decideAppointmentTiming({ branch: "lab_request", services: [svc({ requires_time_slot: true })], scheduledAt: null });
    expect(r.ok).toBe(false);
  });

  it("lab_request needing a slot accepts the given slot", () => {
    const r = decideAppointmentTiming({ branch: "lab_request", services: [svc({ requires_time_slot: true })], scheduledAt: "2026-06-01T01:00:00.000Z" });
    expect(r).toEqual({ ok: true, pendingCallback: false, scheduledAtIso: "2026-06-01T01:00:00.000Z", conflicts: [] });
  });

  it("doctor by-appointment (no schedule) is pending_callback", () => {
    const r = decideAppointmentTiming({
      branch: "doctor_appointment", services: [svc({ kind: "doctor_consultation" })], scheduledAt: null,
      doctor: { byAppointment: true, dayClosed: false, window: { available: false }, existingBookingCount: 0, allowConcurrent: true },
    });
    expect(r).toEqual({ ok: true, pendingCallback: true, scheduledAtIso: null, conflicts: [] });
  });

  it("doctor with a clear slot has no conflicts", () => {
    const r = decideAppointmentTiming({
      branch: "doctor_appointment", services: [svc({ kind: "doctor_consultation" })],
      scheduledAt: "2026-06-01T01:00:00.000Z", // 09:00 Manila
      doctor: { byAppointment: false, dayClosed: false, window: { available: true, start_time: "08:00", end_time: "17:00" }, existingBookingCount: 0, allowConcurrent: false },
    });
    expect(r.ok && r.conflicts).toEqual([]);
  });

  it("flags day_closed first, then outside_hours and slot_taken", () => {
    const r = decideAppointmentTiming({
      branch: "doctor_appointment", services: [svc({ kind: "doctor_consultation" })],
      scheduledAt: "2026-06-01T01:00:00.000Z", // 09:00 Manila
      doctor: { byAppointment: false, dayClosed: true, window: { available: true, start_time: "10:00", end_time: "12:00" }, existingBookingCount: 1, allowConcurrent: false },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.conflicts.map((c) => c.kind)).toEqual(["day_closed", "outside_hours", "slot_taken"]);
  });

  it("flags slot_taken only when allow_concurrent is false", () => {
    const r = decideAppointmentTiming({
      branch: "doctor_appointment", services: [svc({ kind: "doctor_consultation", allow_concurrent: true })],
      scheduledAt: "2026-06-01T01:00:00.000Z",
      doctor: { byAppointment: false, dayClosed: false, window: { available: true, start_time: "08:00", end_time: "17:00" }, existingBookingCount: 3, allowConcurrent: true },
    });
    expect(r.ok && r.conflicts).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run src/lib/appointments/timing.test.ts
```
Expected: FAIL — `Cannot find module './timing'`.

- [ ] **Step 3: Implement `timing.ts`**

Create `src/lib/appointments/timing.ts`:
```ts
import { manilaSlotFor, minutesOfDayHHMM, type BookingBranch } from "@/lib/validations/booking";

// One open window per date (mirrors lib/physicians/availability DayWindow).
export interface DayWindowLike {
  available: boolean;
  start_time?: string;
  end_time?: string;
  reason?: string;
}

export interface ServiceRow {
  id: string;
  name: string;
  kind: string;
  is_active: boolean;
  fasting_required: boolean;
  requires_time_slot: boolean;
  allow_concurrent: boolean;
}

export type ConflictKind =
  | "slot_taken"
  | "day_closed"
  | "outside_hours"
  | "doctor_unavailable";

export interface BookingConflict {
  kind: ConflictKind;
  message: string;
}

export interface TimingArgs {
  branch: BookingBranch;
  services: ServiceRow[];
  // A validated ISO string (real 30-min Manila slot) or null.
  scheduledAt: string | null;
  // Required only for the doctor branch — caller pre-fetches it so this stays DB-free.
  doctor?: {
    byAppointment: boolean; // physician has no recurring schedule rows
    dayClosed: boolean;
    window: DayWindowLike;
    existingBookingCount: number; // non-cancelled appts already at this physician+slot
    allowConcurrent: boolean;
  };
}

export type TimingDecision =
  | { ok: true; pendingCallback: boolean; scheduledAtIso: string | null; conflicts: BookingConflict[] }
  | { ok: false; error: string };

// Conflict messages are kept byte-identical to the public booking flow so the
// strict (public) caller's user-facing errors don't regress. The order pushed
// here mirrors the public flow's short-circuit order (closure → window → hours
// → concurrency), so a strict caller using conflicts[0] reproduces it exactly.
export function decideAppointmentTiming(args: TimingArgs): TimingDecision {
  const { branch, services, scheduledAt } = args;

  if (branch === "diagnostic_package") {
    return { ok: true, pendingCallback: false, scheduledAtIso: null, conflicts: [] };
  }
  if (branch === "home_service") {
    return { ok: true, pendingCallback: true, scheduledAtIso: null, conflicts: [] };
  }
  if (branch === "lab_request") {
    const slotRequired = services.some((s) => s.requires_time_slot);
    if (!slotRequired) {
      return { ok: true, pendingCallback: false, scheduledAtIso: null, conflicts: [] };
    }
    if (!scheduledAt) {
      return {
        ok: false,
        error: "One of the selected tests needs a specific time slot. Please pick a date and time.",
      };
    }
    return { ok: true, pendingCallback: false, scheduledAtIso: scheduledAt, conflicts: [] };
  }

  // doctor_appointment
  const doctor = args.doctor;
  if (!doctor) {
    return { ok: false, error: "Physician availability was not resolved." };
  }
  if (doctor.byAppointment) {
    return { ok: true, pendingCallback: true, scheduledAtIso: null, conflicts: [] };
  }
  if (!scheduledAt) {
    return { ok: false, error: "Please pick a date and time." };
  }

  const conflicts: BookingConflict[] = [];
  if (doctor.dayClosed) {
    conflicts.push({ kind: "day_closed", message: "That day is closed. Please pick another." });
  }
  if (!doctor.window.available) {
    conflicts.push({
      kind: "doctor_unavailable",
      message:
        doctor.window.reason === "full_day_override"
          ? "The doctor is unavailable that day. Please pick another slot."
          : "The doctor isn't scheduled that day. Please pick another slot.",
    });
  } else {
    const slot = manilaSlotFor(new Date(scheduledAt));
    const slotMinutes = slot.hour * 60 + slot.minute;
    const startMin = doctor.window.start_time ? minutesOfDayHHMM(doctor.window.start_time) : 8 * 60;
    const endMin = doctor.window.end_time ? minutesOfDayHHMM(doctor.window.end_time) : 16 * 60 + 30;
    if (slotMinutes < startMin || slotMinutes >= endMin) {
      conflicts.push({ kind: "outside_hours", message: "That time is outside the doctor's hours. Please pick another." });
    }
  }
  if (!doctor.allowConcurrent && doctor.existingBookingCount > 0) {
    conflicts.push({ kind: "slot_taken", message: "That slot was just taken. Please pick another time." });
  }

  return { ok: true, pendingCallback: false, scheduledAtIso: scheduledAt, conflicts };
}
```

- [ ] **Step 4: Add `minutesOfDayHHMM` to `booking.ts` (so timing.ts depends only on the verified-pure `booking.ts`)**

In `src/lib/validations/booking.ts`, after the `isValidSlot` function (line 38), add:
```ts
// Minutes-since-midnight for an "HH:MM" or "HH:MM:SS" string. Lives here (not
// in physicians/availability.ts) so timing.ts can stay dependency-light and
// vitest-importable without pulling availability internals.
export function minutesOfDayHHMM(t: string): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/lib/appointments/timing.test.ts
```
Expected: PASS — 9 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/appointments/timing.ts src/lib/appointments/timing.test.ts src/lib/validations/booking.ts
git commit -m "feat(appointments): pure timing/conflict decision + tests"
```

---

## Task 3: Patient resolution (`lib/patients/resolve.ts`)

**Files:**
- Create: `src/lib/patients/resolve.ts`
- Test: `src/lib/patients/resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/patients/resolve.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { resolvePatientCore, type ResolvePatientFields } from "./resolve";

const fields: ResolvePatientFields = {
  first_name: "Juan", last_name: "Dela Cruz", middle_name: null,
  birthdate: "1990-01-15", sex: "male", phone: "09171234567",
  email: "JUAN@example.com", address: null,
};

describe("resolvePatientCore", () => {
  it("reuses an existing patient and does not insert", async () => {
    const insertPatient = vi.fn();
    const r = await resolvePatientCore(
      { findExisting: async () => ({ id: "p1", drm_id: "DRM-0001" }), insertPatient },
      fields,
    );
    expect(r).toEqual({ ok: true, id: "p1", drm_id: "DRM-0001", reused: true });
    expect(insertPatient).not.toHaveBeenCalled();
  });

  it("lower-cases the email before the dedup lookup", async () => {
    const findExisting = vi.fn(async () => null);
    await resolvePatientCore(
      { findExisting, insertPatient: async () => ({ ok: true, id: "p2", drm_id: "DRM-0002" }) },
      fields,
    );
    expect(findExisting).toHaveBeenCalledWith({ email: "juan@example.com", last_name: "Dela Cruz", birthdate: "1990-01-15" });
  });

  it("inserts when no match, returning reused:false", async () => {
    const r = await resolvePatientCore(
      { findExisting: async () => null, insertPatient: async () => ({ ok: true, id: "p3", drm_id: "DRM-0003" }) },
      fields,
    );
    expect(r).toEqual({ ok: true, id: "p3", drm_id: "DRM-0003", reused: false });
  });

  it("propagates an insert error", async () => {
    const r = await resolvePatientCore(
      { findExisting: async () => null, insertPatient: async () => ({ ok: false, error: "boom" }) },
      fields,
    );
    expect(r).toEqual({ ok: false, error: "boom" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run src/lib/patients/resolve.test.ts
```
Expected: FAIL — `Cannot find module './resolve'`.

- [ ] **Step 3: Implement `resolve.ts`**

Create `src/lib/patients/resolve.ts`:
```ts
import type { createAdminClient } from "@/lib/supabase/admin";

// NOTE: no `import "server-only"` — the DB wrapper receives the admin client as
// a param (never imports the service-role key), so this module stays unit-testable.
// resolvePatient must only ever be called from server code (it is handed an admin client).

export interface ResolvePatientFields {
  first_name: string;
  last_name: string;
  middle_name: string | null;
  birthdate: string;
  sex: "male" | "female" | null;
  phone: string | null;
  email: string; // dedup key — required
  address: string | null;
}

export type ResolvePatientResult =
  | { ok: true; id: string; drm_id: string; reused: boolean }
  | { ok: false; error: string };

export interface ResolvePatientDeps {
  findExisting: (key: { email: string; last_name: string; birthdate: string }) => Promise<{ id: string; drm_id: string } | null>;
  insertPatient: (fields: ResolvePatientFields) => Promise<{ ok: true; id: string; drm_id: string } | { ok: false; error: string }>;
}

// Silent dedup: reuse the patient matched by (lower(email), last_name,
// birthdate); otherwise insert. Strict on purpose — these three rarely collide
// for unrelated people, and a family member differs on last_name or birthdate.
// Existing contact fields are NOT overwritten. Pure orchestration over injected
// deps so it's testable without a live DB.
export async function resolvePatientCore(
  deps: ResolvePatientDeps,
  fields: ResolvePatientFields,
): Promise<ResolvePatientResult> {
  const email = fields.email.trim().toLowerCase();
  const existing = await deps.findExisting({ email, last_name: fields.last_name, birthdate: fields.birthdate });
  if (existing) {
    return { ok: true, id: existing.id, drm_id: existing.drm_id, reused: true };
  }
  const inserted = await deps.insertPatient({ ...fields, email });
  if (!inserted.ok) return inserted;
  return { ok: true, id: inserted.id, drm_id: inserted.drm_id, reused: false };
}

type AdminClient = ReturnType<typeof createAdminClient>;

// Real wiring. Trigger trg_patients_normalise_email keeps stored emails
// lowercase so equality lookup hits idx_patients_dedup_lookup directly.
export async function resolvePatient(admin: AdminClient, fields: ResolvePatientFields): Promise<ResolvePatientResult> {
  return resolvePatientCore(
    {
      async findExisting(key) {
        const { data } = await admin
          .from("patients")
          .select("id, drm_id")
          .eq("email", key.email)
          .eq("last_name", key.last_name)
          .eq("birthdate", key.birthdate)
          .limit(1)
          .maybeSingle();
        return data ?? null;
      },
      async insertPatient(f) {
        const { data, error } = await admin
          .from("patients")
          .insert({ ...f, pre_registered: true })
          .select("id, drm_id")
          .single();
        if (error || !data) {
          return { ok: false, error: error?.message ?? "Could not save patient details." };
        }
        return { ok: true, id: data.id, drm_id: data.drm_id };
      },
    },
    fields,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/lib/patients/resolve.test.ts
```
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/patients/resolve.ts src/lib/patients/resolve.test.ts
git commit -m "feat(patients): extract resolvePatient with testable dedup core"
```

---

## Task 4: Booking-core orchestrator + refactor the public action

**Files:**
- Create: `src/lib/appointments/create.ts`
- Modify: `src/lib/validations/booking.ts` (add `KINDS_PER_BRANCH`)
- Modify: `src/app/(marketing)/schedule/actions.ts` (full rewrite of the action body — behavior preserved)

This task has no new unit test (the pure logic is covered in Task 2); it is verified by `typecheck` + `build` + a manual `/schedule` smoke.

- [ ] **Step 1: Add `KINDS_PER_BRANCH` to `booking.ts`**

In `src/lib/validations/booking.ts`, after the `BookingBranch` type (line 46), add:
```ts
// Allowed `services.kind` per booking branch. Single source of truth shared by
// the public action, the staff action, and the staff slide-over (client-safe).
export const KINDS_PER_BRANCH: Record<BookingBranch, ReadonlyArray<string>> = {
  diagnostic_package: ["lab_package"],
  lab_request: ["lab_test"],
  doctor_appointment: ["doctor_consultation"],
  home_service: ["lab_test", "lab_package"],
};
```

- [ ] **Step 2: Implement `create.ts`**

Create `src/lib/appointments/create.ts`:
```ts
import { randomUUID } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import { manilaSlotFor, KINDS_PER_BRANCH, type BookingBranch } from "@/lib/validations/booking";
import { dayWindowFor } from "@/lib/physicians/availability";
import { decideAppointmentTiming, type BookingConflict, type ServiceRow } from "@/lib/appointments/timing";

// Server-side orchestration. Receives the admin client as a param (no service-
// role import here), so it must only be called from server actions / route handlers.

type AdminClient = ReturnType<typeof createAdminClient>;

// The doctor-availability context shape expected by decideAppointmentTiming.
type DoctorCtx = NonNullable<Parameters<typeof decideAppointmentTiming>[0]["doctor"]>;

export interface PatientResolution {
  patientId: string | null;
  drmId: string | null;
  email: string | null;
  walkInName?: string | null;
  walkInPhone?: string | null;
  resolution: "existing" | "reused" | "created" | "walk_in";
}

export interface CreateAppointmentInput {
  branch: BookingBranch;
  // For doctor branch, a single-element array holding the consultation id.
  serviceIds: string[];
  physicianId: string | null;
  scheduledAt: string | null; // validated ISO or null
  notes: string | null;
  createdBy: string | null; // auth.users id (staff) or null (public)
  mode: "strict" | "relaxed"; // strict = hard-block conflicts (public); relaxed = warn (staff)
  override: boolean; // relaxed only: proceed despite conflicts
  // Resolve the patient ONLY after timing/conflicts pass, to avoid orphan rows on failure.
  resolvePatient: () => Promise<{ ok: true; patient: PatientResolution } | { ok: false; error: string }>;
}

export type CreateAppointmentResult =
  | {
      ok: true;
      bookingGroupId: string;
      appointmentIds: string[];
      scheduledAtIso: string | null;
      pendingCallback: boolean;
      conflicts: BookingConflict[];
      patient: PatientResolution;
      services: ServiceRow[];
    }
  | { ok: false; error: string }
  | { ok: false; code: "conflict"; error: string; conflicts: BookingConflict[] };

export async function loadServices(
  admin: AdminClient,
  ids: ReadonlyArray<string>,
): Promise<{ ok: true; rows: ServiceRow[] } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: false, error: "Pick at least one service." };
  const { data, error } = await admin
    .from("services")
    .select("id, name, kind, is_active, fasting_required, requires_time_slot, allow_concurrent")
    .in("id", ids);
  if (error) return { ok: false, error: error.message };
  if (!data || data.length !== ids.length) {
    return { ok: false, error: "One or more services are no longer available." };
  }
  for (const r of data) {
    if (!r.is_active) return { ok: false, error: "One of the selected services is no longer active." };
  }
  return { ok: true, rows: data };
}

export async function createAppointmentGroup(
  admin: AdminClient,
  input: CreateAppointmentInput,
): Promise<CreateAppointmentResult> {
  // 1. Load + validate services for the branch.
  const svc = await loadServices(admin, input.serviceIds);
  if (!svc.ok) return { ok: false, error: svc.error };
  const services = svc.rows;
  const allowedKinds = new Set(KINDS_PER_BRANCH[input.branch]);
  for (const s of services) {
    if (!allowedKinds.has(s.kind)) {
      return { ok: false, error: "One of the selected services doesn't match this booking type. Reload and try again." };
    }
  }

  // 2. For the doctor branch, resolve availability context (DB).
  let doctorCtx: DoctorCtx | undefined;
  if (input.branch === "doctor_appointment") {
    if (!input.physicianId) return { ok: false, error: "Pick a physician." };
    const { data: physician } = await admin
      .from("physicians")
      .select("id, is_active")
      .eq("id", input.physicianId)
      .maybeSingle();
    if (!physician || !physician.is_active) {
      return { ok: false, error: "Selected physician is no longer available." };
    }
    const { data: blocks } = await admin
      .from("physician_schedules")
      .select("day_of_week, start_time, end_time")
      .eq("physician_id", input.physicianId);
    const allowConcurrent = services[0]?.allow_concurrent ?? true;
    const byAppointment = (blocks ?? []).length === 0;
    if (byAppointment) {
      doctorCtx = { byAppointment: true, dayClosed: false, window: { available: false }, existingBookingCount: 0, allowConcurrent };
    } else if (input.scheduledAt) {
      const slot = manilaSlotFor(new Date(input.scheduledAt));
      const [{ data: closure }, { data: overrides }, { data: existing }] = await Promise.all([
        admin.from("clinic_closures").select("closed_on").eq("closed_on", slot.dateISO).maybeSingle(),
        admin.from("physician_schedule_overrides").select("override_on, start_time, end_time").eq("physician_id", input.physicianId).eq("override_on", slot.dateISO),
        admin.from("appointments").select("id").eq("physician_id", input.physicianId).eq("scheduled_at", input.scheduledAt).not("status", "in", "(cancelled,no_show)"),
      ]);
      const window = dayWindowFor(slot.dateISO, slot.dayOfWeek, { blocks: blocks ?? [], overrides: overrides ?? [] });
      doctorCtx = { byAppointment: false, dayClosed: !!closure, window, existingBookingCount: existing?.length ?? 0, allowConcurrent };
    } else {
      doctorCtx = { byAppointment: false, dayClosed: false, window: { available: true }, existingBookingCount: 0, allowConcurrent };
    }
  }

  // 3. Pure timing + conflict decision.
  const timing = decideAppointmentTiming({ branch: input.branch, services, scheduledAt: input.scheduledAt, doctor: doctorCtx });
  if (!timing.ok) return { ok: false, error: timing.error };

  // 4. Conflict handling differs by mode.
  if (timing.conflicts.length > 0) {
    if (input.mode === "strict") {
      return { ok: false, error: timing.conflicts[0]!.message };
    }
    if (!input.override) {
      return { ok: false, code: "conflict", error: "This time has a scheduling conflict.", conflicts: timing.conflicts };
    }
  }

  // 5. Resolve the patient only now that timing/conflicts have passed.
  const patientRes = await input.resolvePatient();
  if (!patientRes.ok) return { ok: false, error: patientRes.error };
  const patient = patientRes.patient;

  // 6. Insert one row per service sharing a booking_group_id.
  const bookingGroupId = randomUUID();
  const status = timing.pendingCallback ? "pending_callback" : "confirmed";
  const physicianId = input.branch === "doctor_appointment" ? input.physicianId : null;
  const homeServiceRequested = input.branch === "home_service";
  const rows = services.map((s) => ({
    patient_id: patient.patientId,
    service_id: s.id,
    physician_id: physicianId,
    scheduled_at: timing.scheduledAtIso,
    notes: input.notes,
    status,
    booking_group_id: bookingGroupId,
    home_service_requested: homeServiceRequested,
    walk_in_name: patient.walkInName ?? null,
    walk_in_phone: patient.walkInPhone ?? null,
    created_by: input.createdBy,
  }));
  const { data: created, error } = await admin.from("appointments").insert(rows).select("id");
  if (error || !created || created.length !== rows.length) {
    return { ok: false, error: error?.message ?? "Could not save the appointment." };
  }

  return {
    ok: true,
    bookingGroupId,
    appointmentIds: created.map((r) => r.id),
    scheduledAtIso: timing.scheduledAtIso,
    pendingCallback: timing.pendingCallback,
    conflicts: timing.conflicts,
    patient,
    services,
  };
}
```

- [ ] **Step 3: Rewrite `submitBookingAction` to use the extracted core**

Replace the entire body of `src/app/(marketing)/schedule/actions.ts` with the following. `lookupPatientAction`, `LookupPatientResult`, `PatientLookupSchema` usage, and `maybeSubscribe` are preserved; the local `resolvePatient`, `loadServices`, `KINDS_PER_BRANCH`, `ServiceRow`, and `AdminClient` interface are removed (now imported). Behavior is preserved: timing is still decided before the patient is created, so a failed booking never leaves an orphan patient row.

```ts
"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";
import {
  BookingSchema,
  ExistingPatientBookingSchema,
  PatientLookupSchema,
  type BookingInput,
  type ExistingPatientBookingInput,
} from "@/lib/validations/booking";
import { notifyAppointmentBooked } from "@/lib/notifications/notify-appointment-booked";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import { resolvePatient } from "@/lib/patients/resolve";
import { createAppointmentGroup, type PatientResolution } from "@/lib/appointments/create";

export type BookingResult =
  | {
      ok: true;
      drm_id: string;
      service_summary: string;
      scheduled_at: string | null;
      pending_callback: boolean;
      booking_group_id: string;
    }
  | { ok: false; error: string };

const HONEYPOT_OK: BookingResult = {
  ok: true,
  drm_id: "",
  service_summary: "",
  scheduled_at: null,
  pending_callback: false,
  booking_group_id: "",
};

type AdminClient = ReturnType<typeof createAdminClient>;

export type LookupPatientResult =
  | { ok: true; patient: { id: string; drm_id: string; first_name: string; last_name: string } }
  | { ok: false; error: string };

// Sanitised lookup for the "Are you an existing patient?" flow — returns enough
// to display "Booking as <First> <Last> · DRM-XXXX" but no contact info.
export async function lookupPatientAction(
  _prev: LookupPatientResult | null,
  formData: FormData,
): Promise<LookupPatientResult> {
  const headerStore = await headers();
  const requestIp = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headerStore.get("user-agent");

  if (requestIp) {
    const limit = await checkRateLimit({ bucket: "patient_lookup", identifier: requestIp, ...RATE_LIMITS.patient_lookup });
    if (!limit.allowed) {
      return { ok: false, error: `Too many lookups. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes, or call reception.` };
    }
  }

  const parsed = PatientLookupSchema.safeParse({ drm_id: formData.get("drm_id"), last_name: formData.get("last_name") });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the fields." };
  }

  const drmId = parsed.data.drm_id.toUpperCase();
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("patients")
    .select("id, drm_id, first_name, last_name")
    .eq("drm_id", drmId)
    .ilike("last_name", parsed.data.last_name)
    .maybeSingle();

  await audit({
    actor_id: null,
    actor_type: "anonymous",
    patient_id: row?.id ?? null,
    action: row ? "patient.lookup.matched" : "patient.lookup.no_match",
    resource_type: "patient",
    resource_id: row?.id ?? null,
    metadata: { drm_id_attempted: drmId, last_name_attempted: parsed.data.last_name },
    ip_address: requestIp,
    user_agent: userAgent,
  });

  if (!row) {
    return {
      ok: false,
      error: "We couldn't find a patient with that DRM-ID and last name. Double-check the receipt, or book as a new patient.",
    };
  }
  return { ok: true, patient: { id: row.id, drm_id: row.drm_id, first_name: row.first_name, last_name: row.last_name } };
}

async function maybeSubscribe(admin: AdminClient, email: string, ipAddress: string | null): Promise<void> {
  const lower = email.trim().toLowerCase();
  if (!lower) return;
  const { data: existing } = await admin.from("subscribers").select("id, unsubscribed_at").eq("email", lower).maybeSingle();
  if (existing) {
    if (existing.unsubscribed_at !== null) {
      // Re-subscribe: refresh consent but preserve original `source` (first-touch attribution).
      await admin
        .from("subscribers")
        .update({ unsubscribed_at: null, consent_at: new Date().toISOString(), consent_ip: ipAddress })
        .eq("id", existing.id);
    }
    return;
  }
  await admin.from("subscribers").insert({ email: lower, source: "schedule_form", consent_ip: ipAddress });
}

export async function submitBookingAction(_prev: BookingResult | null, formData: FormData): Promise<BookingResult> {
  if ((formData.get("website") ?? "") !== "") {
    return HONEYPOT_OK;
  }

  const headerStore = await headers();
  const requestIp = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headerStore.get("user-agent");

  if (requestIp) {
    const limit = await checkRateLimit({ bucket: "public_booking", identifier: requestIp, ...RATE_LIMITS.public_booking });
    if (!limit.allowed) {
      return { ok: false, error: `Too many booking attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes, or call reception.` };
    }
  }

  const branch = formData.get("branch");
  const sourceInput = formData.get("source");
  const isPortalSource = sourceInput === "portal";

  // Portal submissions ignore any client-supplied patient_id and re-derive it
  // from the session cookie — a logged-in patient can't book against another.
  let resolvedPatientIdFromSession: string | null = null;
  if (isPortalSource) {
    const session = await getPatientSession();
    if (!session) return { ok: false, error: "Your session expired. Please sign in again." };
    resolvedPatientIdFromSession = session.patient_id;
  }

  const patientIdInput = isPortalSource ? resolvedPatientIdFromSession : (formData.get("patient_id") as string | null);
  const isExistingPatient = typeof patientIdInput === "string" && patientIdInput.length > 0;

  let data: (BookingInput & { mode: "new" }) | (ExistingPatientBookingInput & { mode: "existing" });
  if (isExistingPatient) {
    const parsed = ExistingPatientBookingSchema.safeParse({
      branch,
      patient_id: patientIdInput,
      notes: formData.get("notes") ?? "",
      marketing_consent: formData.get("marketing_consent") ?? "off",
      service_agreement: isPortalSource ? "on" : (formData.get("service_agreement") ?? "off"),
      service_id: formData.get("service_id"),
      service_ids: formData.getAll("service_ids"),
      physician_id: formData.get("physician_id") ?? "",
      scheduled_at: formData.get("scheduled_at") ?? "",
    });
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
    data = { ...parsed.data, mode: "existing" };
  } else {
    const parsed = BookingSchema.safeParse({
      branch,
      first_name: formData.get("first_name"),
      last_name: formData.get("last_name"),
      middle_name: formData.get("middle_name") ?? "",
      birthdate: formData.get("birthdate"),
      sex: formData.get("sex") ?? "",
      phone: formData.get("phone"),
      email: formData.get("email"),
      address: formData.get("address") ?? "",
      notes: formData.get("notes") ?? "",
      marketing_consent: formData.get("marketing_consent") ?? "off",
      service_agreement: formData.get("service_agreement") ?? "off",
      service_id: formData.get("service_id"),
      service_ids: formData.getAll("service_ids"),
      physician_id: formData.get("physician_id") ?? "",
      scheduled_at: formData.get("scheduled_at") ?? "",
    });
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
    data = { ...parsed.data, mode: "new" };
  }

  const admin = createAdminClient();
  const scheduledAt = "scheduled_at" in data ? (data.scheduled_at ?? null) : null;
  const serviceIds = data.branch === "doctor_appointment" ? [data.service_id] : data.service_ids;
  const physicianId = data.branch === "doctor_appointment" ? data.physician_id : null;

  // Patient resolution deferred so a failed timing/conflict check never creates a patient.
  const resolveThunk = async (): Promise<{ ok: true; patient: PatientResolution } | { ok: false; error: string }> => {
    if (data.mode === "new") {
      const res = await resolvePatient(admin, {
        first_name: data.first_name,
        last_name: data.last_name,
        middle_name: data.middle_name,
        birthdate: data.birthdate,
        sex: data.sex,
        phone: data.phone,
        email: data.email,
        address: data.address,
      });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, patient: { patientId: res.id, drmId: res.drm_id, email: data.email, resolution: res.reused ? "reused" : "created" } };
    }
    const { data: row } = await admin.from("patients").select("id, drm_id, email").eq("id", data.patient_id).maybeSingle();
    if (!row) return { ok: false, error: "We couldn't find that patient. Please look up again." };
    return { ok: true, patient: { patientId: row.id, drmId: row.drm_id, email: row.email, resolution: "existing" } };
  };

  const result = await createAppointmentGroup(admin, {
    branch: data.branch,
    serviceIds,
    physicianId,
    scheduledAt,
    notes: data.notes,
    createdBy: null,
    mode: "strict",
    override: false,
    resolvePatient: resolveThunk,
  });

  if (!result.ok) {
    // Strict mode never returns the "conflict" code; both shapes carry `error`.
    return { ok: false, error: result.error };
  }

  await audit({
    actor_id: null,
    actor_type: isPortalSource ? "patient" : "anonymous",
    patient_id: result.patient.patientId,
    action: "appointment.booked",
    resource_type: "appointment_group",
    resource_id: result.bookingGroupId,
    metadata: {
      drm_id: result.patient.drmId,
      branch: data.branch,
      service_ids: result.services.map((s) => s.id),
      service_names: result.services.map((s) => s.name),
      pending_callback: result.pendingCallback,
      scheduled_at: result.scheduledAtIso,
      home_service_requested: data.branch === "home_service",
      physician_id: physicianId,
      patient_resolution: result.patient.resolution,
      via: isPortalSource ? "portal" : "schedule",
    },
    ip_address: requestIp,
    user_agent: userAgent,
  });

  if (data.marketing_consent && result.patient.email) {
    await maybeSubscribe(admin, result.patient.email, requestIp);
  }

  try {
    await notifyAppointmentBooked({ appointmentId: result.appointmentIds[0]!, patientId: result.patient.patientId });
  } catch (err) {
    console.error("notifyAppointmentBooked threw", err);
  }

  return {
    ok: true,
    drm_id: result.patient.drmId ?? "",
    service_summary: result.services.map((s) => s.name).join(", "),
    scheduled_at: result.scheduledAtIso,
    pending_callback: result.pendingCallback,
    booking_group_id: result.bookingGroupId,
  };
}
```

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: PASS (no errors). If `dayWindowFor`'s availability arg shape differs from `{ blocks, overrides }`, match the exact signature in `src/lib/physicians/availability.ts`.

- [ ] **Step 5: Build**

Run:
```bash
npm run build
```
Expected: PASS — RSC serialization is clean.

- [ ] **Step 6: Manual smoke of the public flow (regression guard)**

Run `npm run dev`, open `/schedule`, and complete one booking per branch (diagnostic package, lab request, doctor appointment, home service) as a NEW patient and confirm: the appointment appears on `/staff/appointments`, the DRM-ID is returned, and (for doctor) an out-of-hours/closed slot is still rejected with the same message as before. This guards "behavior preserved."

- [ ] **Step 7: Commit**

```bash
git add src/lib/appointments/create.ts src/lib/validations/booking.ts "src/app/(marketing)/schedule/actions.ts"
git commit -m "refactor(schedule): route public booking through shared appointment core"
```

---

## Task 5: `StaffBookingSchema` (relaxed timing + patient-mode discriminator)

**Files:**
- Create: `src/lib/validations/staff-booking.ts`
- Test: `src/lib/validations/staff-booking.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/validations/staff-booking.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StaffBookingSchema } from "./staff-booking";

// Freeze time so the 60-day cap + slot validity are deterministic.
// 2026-06-01 is a Monday in Manila.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T08:00:00+08:00"));
});
afterEach(() => vi.useRealTimers());

const baseExisting = {
  patient: { mode: "existing", patient_id: "11111111-1111-1111-1111-111111111111" },
  branch: "diagnostic_package",
  service_ids: ["22222222-2222-2222-2222-222222222222"],
  send_confirmation: true,
  override: false,
};

describe("StaffBookingSchema", () => {
  it("accepts an existing-patient diagnostic package with no time", () => {
    const r = StaffBookingSchema.safeParse(baseExisting);
    expect(r.success).toBe(true);
  });

  it("allows a same-day / <1h-ahead slot (relaxed timing)", () => {
    // 08:30 Manila today, only 30 min ahead — the public ≥1h rule is dropped.
    const r = StaffBookingSchema.safeParse({
      ...baseExisting,
      branch: "lab_request",
      scheduled_at: "2026-06-01T08:30:00+08:00",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-slot time (Sunday)", () => {
    const r = StaffBookingSchema.safeParse({
      ...baseExisting,
      branch: "lab_request",
      scheduled_at: "2026-06-07T09:00:00+08:00", // Sunday
    });
    expect(r.success).toBe(false);
  });

  it("rejects a slot more than 60 days out", () => {
    const r = StaffBookingSchema.safeParse({
      ...baseExisting,
      branch: "lab_request",
      scheduled_at: "2026-09-01T09:00:00+08:00",
    });
    expect(r.success).toBe(false);
  });

  it("requires service_id + physician_id for the doctor branch", () => {
    const r = StaffBookingSchema.safeParse({
      patient: { mode: "existing", patient_id: "11111111-1111-1111-1111-111111111111" },
      branch: "doctor_appointment",
      send_confirmation: true,
      override: false,
    });
    expect(r.success).toBe(false);
  });

  it("requires at least one service for non-doctor branches", () => {
    const r = StaffBookingSchema.safeParse({ ...baseExisting, service_ids: [] });
    expect(r.success).toBe(false);
  });

  it("validates the new-patient sub-form and requires email", () => {
    const ok = StaffBookingSchema.safeParse({
      ...baseExisting,
      patient: {
        mode: "new", first_name: "Ana", last_name: "Reyes", middle_name: "",
        birthdate: "1995-03-10", sex: "female", email: "ana@example.com", phone: "0917", address: "",
      },
    });
    expect(ok.success).toBe(true);

    const noEmail = StaffBookingSchema.safeParse({
      ...baseExisting,
      patient: { mode: "new", first_name: "Ana", last_name: "Reyes", middle_name: "", birthdate: "1995-03-10", sex: "female", email: "", phone: "0917", address: "" },
    });
    expect(noEmail.success).toBe(false);
  });

  it("validates the walk-in sub-form (name + phone)", () => {
    const r = StaffBookingSchema.safeParse({
      ...baseExisting,
      patient: { mode: "walk_in", walk_in_name: "Juan", walk_in_phone: "09171234567" },
    });
    expect(r.success).toBe(true);
  });

  it("defaults send_confirmation and override", () => {
    const r = StaffBookingSchema.safeParse({
      patient: { mode: "existing", patient_id: "11111111-1111-1111-1111-111111111111" },
      branch: "diagnostic_package",
      service_ids: ["22222222-2222-2222-2222-222222222222"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.send_confirmation).toBe(true);
      expect(r.data.override).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run src/lib/validations/staff-booking.test.ts
```
Expected: FAIL — `Cannot find module './staff-booking'`.

- [ ] **Step 3: Implement `staff-booking.ts`**

Create `src/lib/validations/staff-booking.ts`:
```ts
import { z } from "zod";
import { manilaSlotFor, isValidSlot } from "@/lib/validations/booking";

const optionalText = (max: number) =>
  z.string().trim().max(max).or(z.literal("")).transform((v) => (v === "" ? null : v)).nullable();

// Staff timing is RELAXED vs the public form: the "≥1 hour ahead" lead-time rule
// is dropped (same-day / short-notice / re-entered bookings are allowed). It must
// still be a real 30-min Mon–Sat 08:00–16:30 slot, and no more than 60 days out.
const relaxedScheduledAt = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    const t = (v ?? "").toString().trim();
    if (t.length === 0) return null;
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date/time." });
      return z.NEVER;
    }
    if (d.getTime() > Date.now() + 60 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Bookings up to 60 days in advance." });
      return z.NEVER;
    }
    if (!isValidSlot(manilaSlotFor(d))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick a 30-minute slot Mon–Sat between 8:00 AM and 4:30 PM." });
      return z.NEVER;
    }
    return d.toISOString();
  });

const StaffPatientUnion = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("existing"), patient_id: z.string().uuid("Pick a patient.") }),
  z.object({
    mode: z.literal("new"),
    first_name: z.string().trim().min(1, "First name is required.").max(80),
    last_name: z.string().trim().min(1, "Last name is required.").max(80),
    middle_name: optionalText(80),
    birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Birthdate must be YYYY-MM-DD."),
    sex: z.union([z.literal(""), z.enum(["male", "female"])]).transform((v) => (v === "" ? null : v)).nullable(),
    // Email required: it's the dedup key for resolvePatient + the confirmation channel.
    email: z.string().trim().email("Valid email required.").max(160),
    phone: optionalText(40),
    address: optionalText(200),
  }),
  z.object({
    mode: z.literal("walk_in"),
    walk_in_name: z.string().trim().min(1, "Walk-in name is required.").max(120),
    walk_in_phone: z.string().trim().min(7, "Walk-in phone is required.").max(40),
  }),
]);

export const StaffBookingSchema = z
  .object({
    patient: StaffPatientUnion,
    branch: z.enum(["diagnostic_package", "lab_request", "doctor_appointment", "home_service"]),
    service_id: z.string().uuid().optional(),
    service_ids: z.array(z.string().uuid()).optional(),
    physician_id: z.string().uuid().optional(),
    scheduled_at: relaxedScheduledAt,
    notes: optionalText(2000),
    send_confirmation: z.boolean().default(true),
    override: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    if (val.branch === "doctor_appointment") {
      if (!val.service_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["service_id"], message: "Pick a consultation." });
      if (!val.physician_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["physician_id"], message: "Pick a physician." });
    } else if (!val.service_ids || val.service_ids.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["service_ids"], message: "Pick at least one service." });
    }
  });

// z.input (raw) — the client builds this shape; the action re-parses to z.output.
export type StaffBookingInput = z.input<typeof StaffBookingSchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run src/lib/validations/staff-booking.test.ts
```
Expected: PASS — 9 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validations/staff-booking.ts src/lib/validations/staff-booking.test.ts
git commit -m "feat(validations): relaxed StaffBookingSchema + tests"
```

---

## Task 6: Staff server actions

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/appointments/new-appointment-actions.ts`

- [ ] **Step 1: Implement the three actions**

Create `src/app/(staff)/staff/(dashboard)/appointments/new-appointment-actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { StaffBookingSchema, type StaffBookingInput } from "@/lib/validations/staff-booking";
import { createAppointmentGroup, type PatientResolution } from "@/lib/appointments/create";
import type { BookingConflict } from "@/lib/appointments/timing";
import { resolvePatient } from "@/lib/patients/resolve";
import { notifyAppointmentBooked } from "@/lib/notifications/notify-appointment-booked";

export type StaffAppointmentResult =
  | { ok: true; data: { booking_group_id: string } }
  | { ok: false; error: string }
  | { ok: false; code: "conflict"; error: string; data: { conflicts: BookingConflict[] } };

export interface PatientSearchRow {
  id: string;
  drm_id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  birthdate: string | null;
}

export interface UpcomingApptRow {
  id: string;
  scheduled_at: string | null;
  status: string;
  service_name: string | null;
  physician_name: string | null;
}

async function gateReceptionAdmin() {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false as const, error: "You don't have access to create appointments." };
  }
  return { ok: true as const, session };
}

export async function createStaffAppointmentAction(input: StaffBookingInput): Promise<StaffAppointmentResult> {
  const gate = await gateReceptionAdmin();
  if (!gate.ok) return { ok: false, error: gate.error };
  const { session } = gate;
  const { ip, ua } = await ipAndAgent();

  const parsed = StaffBookingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;

  const admin = createAdminClient();

  const resolveThunk = async (): Promise<{ ok: true; patient: PatientResolution } | { ok: false; error: string }> => {
    if (data.patient.mode === "existing") {
      const { data: row } = await admin.from("patients").select("id, drm_id, email").eq("id", data.patient.patient_id).maybeSingle();
      if (!row) return { ok: false, error: "We couldn't find that patient. Search again." };
      return { ok: true, patient: { patientId: row.id, drmId: row.drm_id, email: row.email, resolution: "existing" } };
    }
    if (data.patient.mode === "new") {
      const r = await resolvePatient(admin, {
        first_name: data.patient.first_name,
        last_name: data.patient.last_name,
        middle_name: data.patient.middle_name,
        birthdate: data.patient.birthdate,
        sex: data.patient.sex,
        phone: data.patient.phone,
        email: data.patient.email,
        address: data.patient.address,
      });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, patient: { patientId: r.id, drmId: r.drm_id, email: data.patient.email, resolution: r.reused ? "reused" : "created" } };
    }
    // walk_in — no patient record
    return {
      ok: true,
      patient: { patientId: null, drmId: null, email: null, walkInName: data.patient.walk_in_name, walkInPhone: data.patient.walk_in_phone, resolution: "walk_in" },
    };
  };

  const result = await createAppointmentGroup(admin, {
    branch: data.branch,
    serviceIds: data.branch === "doctor_appointment" ? [data.service_id!] : data.service_ids!,
    physicianId: data.branch === "doctor_appointment" ? data.physician_id! : null,
    scheduledAt: data.scheduled_at,
    notes: data.notes,
    createdBy: session.user_id,
    mode: "relaxed",
    override: data.override,
    resolvePatient: resolveThunk,
  });

  if (!result.ok) {
    if ("code" in result && result.code === "conflict") {
      return { ok: false, code: "conflict", error: result.error, data: { conflicts: result.conflicts } };
    }
    return { ok: false, error: result.error };
  }

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: result.patient.patientId,
    action: "appointment.created_by_staff",
    resource_type: "appointment_group",
    resource_id: result.bookingGroupId,
    metadata: {
      via: "staff",
      actor_role: session.role,
      branch: data.branch,
      service_ids: result.services.map((s) => s.id),
      service_names: result.services.map((s) => s.name),
      scheduled_at: result.scheduledAtIso,
      pending_callback: result.pendingCallback,
      patient_resolution: result.patient.resolution,
      override_conflict: data.override && result.conflicts.length > 0,
      conflicts: result.conflicts.map((c) => c.kind),
      group_appointment_ids: result.appointmentIds,
      drm_id: result.patient.drmId,
    },
    ip_address: ip,
    user_agent: ua,
  });

  if (data.send_confirmation) {
    try {
      await notifyAppointmentBooked({ appointmentId: result.appointmentIds[0]!, patientId: result.patient.patientId });
    } catch (err) {
      console.error("notifyAppointmentBooked threw", err);
    }
  }

  revalidatePath("/staff/appointments");
  return { ok: true, data: { booking_group_id: result.bookingGroupId } };
}

// Staff-only patient search for the slide-over. RLS server client (reads are
// RLS-gated; we additionally gate by role). No audit — consistent with the
// existing inline searches on /staff/visits/new and /staff/patients.
export async function searchPatientsAction(q: string): Promise<{ ok: true; data: PatientSearchRow[] } | { ok: false; error: string }> {
  const gate = await gateReceptionAdmin();
  if (!gate.ok) return { ok: false, error: gate.error };
  const term = q.trim();
  if (term.length < 2) return { ok: true, data: [] };
  const supabase = await createClient();
  const like = `%${term.replace(/[%_,]/g, "")}%`;
  const { data, error } = await supabase
    .from("patients")
    .select("id, drm_id, first_name, last_name, phone, email, birthdate")
    .or([`drm_id.ilike.${like}`, `first_name.ilike.${like}`, `last_name.ilike.${like}`, `phone.ilike.${like}`, `email.ilike.${like}`].join(","))
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: data ?? [] };
}

export async function getPatientUpcomingAppointmentsAction(patientId: string): Promise<{ ok: true; data: UpcomingApptRow[] } | { ok: false; error: string }> {
  const gate = await gateReceptionAdmin();
  if (!gate.ok) return { ok: false, error: gate.error };
  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("appointments")
    .select("id, scheduled_at, status, services(name), physicians(full_name)")
    .eq("patient_id", patientId)
    .not("status", "in", "(cancelled,no_show,completed)")
    .or(`scheduled_at.gte.${nowIso},scheduled_at.is.null`)
    .order("scheduled_at", { ascending: true })
    .limit(10);
  if (error) return { ok: false, error: error.message };
  const rows: UpcomingApptRow[] = (data ?? []).map((a) => {
    const s = Array.isArray(a.services) ? a.services[0] : a.services;
    const ph = Array.isArray(a.physicians) ? a.physicians[0] : a.physicians;
    return { id: a.id, scheduled_at: a.scheduled_at, status: a.status, service_name: s?.name ?? null, physician_name: ph?.full_name ?? null };
  });
  return { ok: true, data: rows };
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: PASS. If the `patients` row type lacks `birthdate` in the select inference, confirm the column exists in `src/types/database.ts` (it does) — no change needed.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/appointments/new-appointment-actions.ts"
git commit -m "feat(appointments): staff create + patient-search + upcoming actions"
```

---

## Task 7: `Sheet` primitive (right-pinned slide-over)

**Files:**
- Create: `src/components/ui/sheet.tsx`

- [ ] **Step 1: Implement the Sheet**

Create `src/components/ui/sheet.tsx`:
```tsx
"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DialogOverlay, DialogPortal } from "@/components/ui/dialog";

// A right-pinned slide-over built on the same @base-ui dialog primitive as
// dialog.tsx — positioning is purely className (the primitive has no `side`
// prop). Docks to the bottom as a sheet on mobile. Reuses the dialog's
// DialogOverlay + DialogPortal so backdrop/animation stay consistent.

function Sheet({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="sheet-content"
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none duration-150 sm:max-w-md",
          "data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
          // Mobile: dock to the bottom as a sheet instead of a full-height right panel.
          "max-sm:inset-x-0 max-sm:inset-y-auto max-sm:bottom-0 max-sm:max-h-[90vh] max-sm:w-full max-sm:max-w-full max-sm:rounded-t-xl max-sm:data-open:slide-in-from-bottom max-sm:data-closed:slide-out-to-bottom",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="sheet-close"
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-1", className)} {...props} />;
}

function SheetTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-[family-name:var(--font-heading)] text-lg font-semibold", className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="sheet-description" className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 border-t pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end", className)}
      {...props}
    />
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter };
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: PASS. If `slide-in-from-right` / `slide-out-to-right` / `slide-in-from-bottom` classes aren't recognized, confirm `tw-animate-css` is imported in the global stylesheet (it is a dependency — `package.json:66`); these utilities ship with it.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/sheet.tsx
git commit -m "feat(ui): right-pinned Sheet slide-over on the dialog primitive"
```

---

## Task 8: `QrCode` component

**Files:**
- Create: `src/components/ui/qr-code.tsx`
- Modify: `package.json`

- [ ] **Step 1: Install qrcode.react**

Run:
```bash
npm install qrcode.react@^4
```
Expected: `package.json` dependencies now lists `qrcode.react` (v4 supports React 19 and exports `QRCodeSVG`).

- [ ] **Step 2: Implement the component**

Create `src/components/ui/qr-code.tsx`:
```tsx
"use client";

import { QRCodeSVG } from "qrcode.react";
import { cn } from "@/lib/utils";

// Renders the QR locally as vector SVG — no third-party QR service, so no
// privacy leak. Reused in PR2 for the /register link QR.
export function QrCode({ value, size = 160, className }: { value: string; size?: number; className?: string }) {
  return (
    <div className={cn("inline-flex rounded-lg bg-white p-3 ring-1 ring-foreground/10", className)}>
      <QRCodeSVG value={value} size={size} level="M" marginSize={0} />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: PASS. `qrcode.react` ships its own types.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/qr-code.tsx package.json package-lock.json
git commit -m "feat(ui): local QrCode component via qrcode.react"
```

---

## Task 9: The slide-over client form

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/appointments/new-appointment-sheet.tsx`

- [ ] **Step 1: Implement the form**

Create `src/app/(staff)/staff/(dashboard)/appointments/new-appointment-sheet.tsx`:
```tsx
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { QrCode } from "@/components/ui/qr-code";
import { KINDS_PER_BRANCH, BOOKING_BRANCHES, type BookingBranch } from "@/lib/validations/booking";
import type { StaffBookingInput } from "@/lib/validations/staff-booking";
import type { BookingConflict } from "@/lib/appointments/timing";
import {
  createStaffAppointmentAction,
  searchPatientsAction,
  getPatientUpcomingAppointmentsAction,
  type PatientSearchRow,
  type UpcomingApptRow,
} from "./new-appointment-actions";

export interface ServiceOption {
  id: string;
  name: string;
  kind: string;
  requires_time_slot: boolean;
}
export interface PhysicianOption {
  id: string;
  full_name: string;
}

const BRANCH_LABELS: Record<BookingBranch, string> = {
  diagnostic_package: "Diagnostic package",
  lab_request: "Lab request",
  doctor_appointment: "Doctor appointment",
  home_service: "Home service",
};

type PatientMode = "existing" | "new" | "walk_in";

const INPUT_CLS = "rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm";

// datetime-local has no zone; staff + clinic are Asia/Manila (UTC+8, no DST).
function toManilaIso(localValue: string): string | null {
  if (!localValue) return null;
  const d = new Date(`${localValue}:00+08:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function NewAppointmentSheet({
  services,
  physicians,
  selfBookUrl,
}: {
  services: ServiceOption[];
  physicians: PhysicianOption[];
  selfBookUrl: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  // Patient
  const [mode, setMode] = React.useState<PatientMode>("existing");
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PatientSearchRow[]>([]);
  const [selected, setSelected] = React.useState<PatientSearchRow | null>(null);
  const [upcoming, setUpcoming] = React.useState<UpcomingApptRow[]>([]);
  const [newP, setNewP] = React.useState({
    first_name: "",
    last_name: "",
    middle_name: "",
    birthdate: "",
    sex: "" as "" | "male" | "female",
    phone: "",
    email: "",
    address: "",
  });
  const [walkIn, setWalkIn] = React.useState({ walk_in_name: "", walk_in_phone: "" });

  // Booking
  const [branch, setBranch] = React.useState<BookingBranch>("diagnostic_package");
  const [serviceIds, setServiceIds] = React.useState<string[]>([]);
  const [serviceId, setServiceId] = React.useState(""); // doctor consultation
  const [physicianId, setPhysicianId] = React.useState("");
  const [scheduledAtLocal, setScheduledAtLocal] = React.useState("");
  const [sendConfirmation, setSendConfirmation] = React.useState(true);
  const [showQr, setShowQr] = React.useState(false);

  const [conflicts, setConflicts] = React.useState<BookingConflict[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  const allowedKinds = KINDS_PER_BRANCH[branch];
  const branchServices = services.filter((s) => allowedKinds.includes(s.kind));
  const takesTime = branch === "lab_request" || branch === "doctor_appointment";

  // Debounced patient search.
  React.useEffect(() => {
    if (mode !== "existing") return;
    const term = query.trim();
    if (selected || term.length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      searchPatientsAction(term).then((r) => {
        if (r.ok) setResults(r.data);
      });
    }, 250);
    return () => clearTimeout(handle);
  }, [query, mode, selected]);

  function resetAll() {
    setMode("existing");
    setQuery("");
    setResults([]);
    setSelected(null);
    setUpcoming([]);
    setNewP({ first_name: "", last_name: "", middle_name: "", birthdate: "", sex: "", phone: "", email: "", address: "" });
    setWalkIn({ walk_in_name: "", walk_in_phone: "" });
    setBranch("diagnostic_package");
    setServiceIds([]);
    setServiceId("");
    setPhysicianId("");
    setScheduledAtLocal("");
    setSendConfirmation(true);
    setShowQr(false);
    setConflicts([]);
    setError(null);
  }

  function pickPatient(p: PatientSearchRow) {
    setSelected(p);
    setResults([]);
    setQuery(`${p.last_name}, ${p.first_name} · ${p.drm_id}`);
    getPatientUpcomingAppointmentsAction(p.id).then((r) => setUpcoming(r.ok ? r.data : []));
  }

  function buildPatient(): StaffBookingInput["patient"] | { error: string } {
    if (mode === "existing") {
      if (!selected) return { error: "Search and pick a patient first." };
      return { mode: "existing", patient_id: selected.id };
    }
    if (mode === "new") {
      return {
        mode: "new",
        first_name: newP.first_name,
        last_name: newP.last_name,
        middle_name: newP.middle_name,
        birthdate: newP.birthdate,
        sex: newP.sex,
        email: newP.email,
        phone: newP.phone,
        address: newP.address,
      };
    }
    return { mode: "walk_in", walk_in_name: walkIn.walk_in_name, walk_in_phone: walkIn.walk_in_phone };
  }

  function submit(override: boolean) {
    setError(null);
    const patient = buildPatient();
    if ("error" in patient) {
      setError(patient.error);
      return;
    }
    const input: StaffBookingInput = {
      patient,
      branch,
      service_id: branch === "doctor_appointment" ? serviceId : undefined,
      service_ids: branch === "doctor_appointment" ? undefined : serviceIds,
      physician_id: branch === "doctor_appointment" ? physicianId : undefined,
      scheduled_at: takesTime ? toManilaIso(scheduledAtLocal) : null,
      notes: null,
      send_confirmation: sendConfirmation,
      override,
    };

    startTransition(async () => {
      const result = await createStaffAppointmentAction(input);
      if (result.ok) {
        toast.success("Appointment created.");
        setOpen(false);
        resetAll();
        router.refresh();
        return;
      }
      if ("code" in result && result.code === "conflict") {
        setConflicts(result.data.conflicts);
        setError(null);
        return;
      }
      setConflicts([]);
      setError(result.error);
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) resetAll();
      }}
    >
      <SheetTrigger
        render={<Button className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]" />}
      >
        + New appointment
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>New appointment</SheetTitle>
          <SheetDescription>
            Phone-in or re-entered bookings. For a walk-in who is ready now, use Create visit instead.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5">
          {/* 1. Patient */}
          <section className="flex flex-col gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Patient</p>
            <div className="flex gap-1">
              {(["existing", "new", "walk_in"] as PatientMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setSelected(null);
                    setUpcoming([]);
                    setQuery("");
                    setResults([]);
                  }}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                    mode === m ? "bg-[color:var(--color-brand-navy)] text-white" : "bg-muted text-foreground"
                  }`}
                >
                  {m === "existing" ? "Existing" : m === "new" ? "New" : "Walk-in"}
                </button>
              ))}
            </div>

            {mode === "existing" && (
              <div className="flex flex-col gap-1">
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSelected(null);
                  }}
                  placeholder="Search DRM-ID, name, phone, email…"
                  className={INPUT_CLS}
                />
                {results.length > 0 && !selected && (
                  <ul className="max-h-44 overflow-y-auto rounded-md border border-[color:var(--color-brand-bg-mid)]">
                    {results.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => pickPatient(p)}
                          className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          <span className="font-semibold">
                            {p.last_name}, {p.first_name}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {p.drm_id} · {p.phone ?? p.email ?? "—"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {selected && upcoming.length > 0 && (
                  <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-900">
                    <p className="font-semibold">Upcoming for this patient:</p>
                    <ul className="mt-1 list-disc pl-4">
                      {upcoming.map((u) => (
                        <li key={u.id}>
                          {u.scheduled_at
                            ? new Date(u.scheduled_at).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })
                            : "Pending callback"}
                          {u.service_name ? ` · ${u.service_name}` : ""}
                          {u.physician_name ? ` · ${u.physician_name}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {mode === "new" && (
              <div className="grid grid-cols-2 gap-2">
                <input value={newP.first_name} onChange={(e) => setNewP({ ...newP, first_name: e.target.value })} placeholder="First name" className={INPUT_CLS} />
                <input value={newP.last_name} onChange={(e) => setNewP({ ...newP, last_name: e.target.value })} placeholder="Last name" className={INPUT_CLS} />
                <input value={newP.middle_name} onChange={(e) => setNewP({ ...newP, middle_name: e.target.value })} placeholder="Middle name (optional)" className={INPUT_CLS} />
                <input type="date" value={newP.birthdate} onChange={(e) => setNewP({ ...newP, birthdate: e.target.value })} className={INPUT_CLS} />
                <select value={newP.sex} onChange={(e) => setNewP({ ...newP, sex: e.target.value as "" | "male" | "female" })} className={INPUT_CLS}>
                  <option value="">Sex (optional)</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
                <input value={newP.phone} onChange={(e) => setNewP({ ...newP, phone: e.target.value })} placeholder="Phone" className={INPUT_CLS} />
                <input value={newP.email} onChange={(e) => setNewP({ ...newP, email: e.target.value })} placeholder="Email (required)" className={`col-span-2 ${INPUT_CLS}`} />
                <input value={newP.address} onChange={(e) => setNewP({ ...newP, address: e.target.value })} placeholder="Address (optional)" className={`col-span-2 ${INPUT_CLS}`} />
              </div>
            )}

            {mode === "walk_in" && (
              <div className="flex flex-col gap-2">
                <input value={walkIn.walk_in_name} onChange={(e) => setWalkIn({ ...walkIn, walk_in_name: e.target.value })} placeholder="Walk-in name" className={INPUT_CLS} />
                <input value={walkIn.walk_in_phone} onChange={(e) => setWalkIn({ ...walkIn, walk_in_phone: e.target.value })} placeholder="Walk-in phone" className={INPUT_CLS} />
                <p className="text-xs text-muted-foreground">
                  No patient record is created. The “+ Start visit” button only appears once reception registers them on arrival.
                </p>
              </div>
            )}
          </section>

          {/* 2. Booking type */}
          <section className="flex flex-col gap-2">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Booking type</p>
            <select
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value as BookingBranch);
                setServiceIds([]);
                setServiceId("");
                setPhysicianId("");
                setConflicts([]);
              }}
              className={INPUT_CLS}
            >
              {BOOKING_BRANCHES.map((b) => (
                <option key={b} value={b}>
                  {BRANCH_LABELS[b]}
                </option>
              ))}
            </select>
          </section>

          {/* 3. Services / Doctor */}
          <section className="flex flex-col gap-2">
            {branch === "doctor_appointment" ? (
              <>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Consultation &amp; doctor</p>
                <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={INPUT_CLS}>
                  <option value="">Pick a consultation…</option>
                  {branchServices.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <select value={physicianId} onChange={(e) => setPhysicianId(e.target.value)} className={INPUT_CLS}>
                  <option value="">Pick a physician…</option>
                  {physicians.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.full_name}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Service(s)</p>
                <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border border-[color:var(--color-brand-bg-mid)] p-2">
                  {branchServices.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">No services for this type.</p>
                  ) : (
                    branchServices.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={serviceIds.includes(s.id)}
                          onChange={(e) => setServiceIds(e.target.checked ? [...serviceIds, s.id] : serviceIds.filter((id) => id !== s.id))}
                        />
                        {s.name}
                      </label>
                    ))
                  )}
                </div>
              </>
            )}
          </section>

          {/* 4. When */}
          {takesTime && (
            <section className="flex flex-col gap-2">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">When (optional)</p>
              <input type="datetime-local" value={scheduledAtLocal} onChange={(e) => setScheduledAtLocal(e.target.value)} className={INPUT_CLS} />
              <p className="text-xs text-muted-foreground">30-minute slots, Mon–Sat 8:00 AM–4:30 PM. Same-day is allowed.</p>
            </section>
          )}

          {/* Conflicts (overridable) */}
          {conflicts.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-semibold">⚠ Scheduling conflict</p>
              <ul className="mt-1 list-disc pl-4">
                {conflicts.map((c, i) => (
                  <li key={i}>{c.message}</li>
                ))}
              </ul>
              <Button type="button" size="sm" disabled={pending} onClick={() => submit(true)} className="mt-2 bg-amber-600 text-white hover:bg-amber-700">
                {pending ? "…" : "Book anyway"}
              </Button>
            </div>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          {/* Self-book QR */}
          <div>
            <button type="button" onClick={() => setShowQr((v) => !v)} className="text-xs font-semibold text-[color:var(--color-brand-cyan)] underline">
              {showQr ? "Hide self-book QR" : "Patient prefers to book themselves? Show QR"}
            </button>
            {showQr && (
              <div className="mt-2 flex flex-col items-center gap-1">
                <QrCode value={selfBookUrl} size={150} />
                <span className="font-mono text-[10px] break-all text-muted-foreground">{selfBookUrl}</span>
              </div>
            )}
          </div>
        </div>

        <SheetFooter>
          <label className="mr-auto flex items-center gap-2 text-sm">
            <input type="checkbox" checked={sendConfirmation} onChange={(e) => setSendConfirmation(e.target.checked)} />
            Send confirmation (SMS + email)
          </label>
          <SheetClose render={<Button variant="outline" disabled={pending} />}>Cancel</SheetClose>
          <Button type="button" disabled={pending} onClick={() => submit(false)} className="bg-[color:var(--color-brand-navy)] text-white hover:bg-[color:var(--color-brand-cyan)]">
            {pending ? "Creating…" : "Create"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
npm run typecheck
```
Expected: PASS. Note `StaffBookingInput` is the `z.input` shape, so the raw object built here (string `sex`, optional `service_id`/`service_ids`, etc.) is assignable.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/appointments/new-appointment-sheet.tsx"
git commit -m "feat(appointments): + New appointment slide-over form"
```

---

## Task 10: Wire into the appointments page + mount Toaster

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/page.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/layout.tsx`

- [ ] **Step 1: Mount the Toaster in the staff dashboard layout**

`sonner` is installed but no `<Toaster/>` is mounted anywhere yet. Replace the whole body of `src/app/(staff)/staff/(dashboard)/layout.tsx` with:
```tsx
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { StaffShell } from "@/components/staff/staff-shell";
import { Toaster } from "@/components/ui/sonner";

export default async function StaffDashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await requireActiveStaff();
  return (
    <>
      <StaffShell session={session}>{children}</StaffShell>
      <Toaster position="top-right" richColors />
    </>
  );
}
```

- [ ] **Step 2: Add imports + data loading to the appointments page**

In `src/app/(staff)/staff/(dashboard)/appointments/page.tsx`, update the imports at the top — add `headers` and the slide-over import alongside the existing imports (after line 6 `import { TransitionButtons } from "./transition-buttons";`):
```tsx
import { headers } from "next/headers";
import { NewAppointmentSheet, type ServiceOption, type PhysicianOption } from "./new-appointment-sheet";
```

- [ ] **Step 3: Load services + physicians + build the self-book URL**

In `AppointmentsPage`, immediately after the existing `Promise.all([...])` block that resolves `[todayScheduled, todayWalkIns, upcoming, pending]` (ends at line 201) and before `const todayRows = ...` (line 203), insert:
```tsx
  const supabase = await createClient();
  const [{ data: serviceRows }, { data: physicianRows }] = await Promise.all([
    supabase.from("services").select("id, name, kind, requires_time_slot").eq("is_active", true).order("name", { ascending: true }),
    supabase.from("physicians").select("id, full_name").eq("is_active", true).order("full_name", { ascending: true }),
  ]);
  const services: ServiceOption[] = serviceRows ?? [];
  const physicians: PhysicianOption[] = physicianRows ?? [];

  const host = (await headers()).get("host") ?? "drmed.ph";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const selfBookUrl = `${proto}://${host}/schedule?src=staff_qr`;
```

- [ ] **Step 4: Render the slide-over in the page header**

Replace the existing `<header className="mb-6">…</header>` block (lines 214-223) with:
```tsx
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Appointments
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Public bookings from /schedule plus staff-created appointments.
            Multi-service requests are grouped — one card with all picked
            tests, single set of action buttons.
          </p>
        </div>
        <NewAppointmentSheet services={services} physicians={physicians} selfBookUrl={selfBookUrl} />
      </header>
```

- [ ] **Step 5: Typecheck + build**

Run:
```bash
npm run typecheck && npm run build
```
Expected: PASS for both. The build confirms RSC/client serialization across the new server-component → client-component boundary.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/appointments/page.tsx" "src/app/(staff)/staff/(dashboard)/layout.tsx"
git commit -m "feat(appointments): mount + New appointment slide-over + Toaster"
```

---

## Task 11: Full verification + manual walk-through

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run:
```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: vitest green (timing 9 + resolve 4 + staff-booking 9), typecheck clean, lint clean, build succeeds.

- [ ] **Step 2: Manual walk-through (`npm run dev`, sign in as reception)**

Verify on `/staff/appointments`:
1. **Existing + diagnostic package**: search → pick a patient → upcoming list shows (if any) → Create → toast → row appears, status `confirmed`, no time.
2. **New + lab request with a time-slot test**: fill the new-patient sub-form (with email) → pick a service requiring a slot → pick a same-day slot 30 min out → Create succeeds (relaxed timing — the public ≥1h rule is gone). Re-running the exact same new-patient details reuses the row (dedup) rather than creating a second patient.
3. **Walk-in + home service**: name + phone → Create → row shows `pending_callback`, "Home service" tag, patient column shows the walk-in name; the `+ Start visit` button does NOT appear (no patient_id).
4. **Doctor appointment conflict**: pick a doctor + a slot already taken (or outside hours) → "⚠ Scheduling conflict" with "Book anyway" → confirm it creates the row and the audit row has `override_conflict: true`.
5. **Send confirmation OFF**: uncheck → Create → no SMS/email fired (check logs); audit row still written.
6. **Self-book QR**: toggle → QR renders, scanning opens `/schedule?src=staff_qr`.
7. **Mobile (390×844)**: the sheet docks to the bottom and is usable; tap targets ≥ 44px.
8. **RBAC**: confirm a medtech/pathologist/xray account cannot reach the action (the page already redirects non-reception/admin; the action's gate returns an error if called directly).

- [ ] **Step 3: Confirm audit rows (RA 10173)**

In Supabase, confirm `audit_log` has an `appointment.created_by_staff` row per booking group with `actor_type='staff'`, `actor_id` = the signing user, and the expected metadata. Confirm the public `/schedule` path still logs `appointment.booked` unchanged.

- [ ] **Step 4: Push the branch + open the PR**

```bash
git push -u origin feat/staff-new-appointment
gh pr create --title "feat(appointments): staff + New appointment slide-over (PR1 / Feature A)" --body "$(cat <<'BODY'
Implements Feature A from docs/superpowers/specs/2026-05-30-staff-appointment-intake-design.md.

- Extracts the public booking core into shared modules (lib/patients/resolve.ts, lib/appointments/{timing,create}.ts); public submitBookingAction refactored to use them, behavior preserved.
- Adds a relaxed StaffBookingSchema, three staff server actions, a Sheet primitive, a QrCode component, and the + New appointment slide-over.
- Adds vitest (repo's first unit runner) covering the pure timing + dedup + schema logic.
- No migration — appointments already has every needed column.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Spec coverage map (§5 → tasks)

| Spec §5 requirement | Task |
|---|---|
| New `Sheet` on `@base-ui` dialog, right-pinned / bottom on mobile | Task 7 |
| Page loads services + physicians, renders `+ New appointment` + Sheet + form; success closes + toasts + refresh | Tasks 9, 10 |
| Patient toggle Existing / New / Walk-in | Task 9 |
| Existing: `searchPatientsAction` + upcoming-appts inline on pick | Tasks 6, 9 |
| New: mini-form validated by shared patient schema | Tasks 5 (StaffBookingSchema new-patient sub-form), 9 |
| Walk-in: name + phone only | Tasks 5, 9 |
| Booking type branch filters via `KINDS_PER_BRANCH` | Tasks 4, 9 |
| Multi-select services / single consult + physician | Task 9 |
| When (relaxed timing) shown only for time-taking branches | Tasks 5, 9 |
| Footer: Send confirmation (default ON) + Cancel/Create + self-book QR | Tasks 8, 9 |
| `createStaffAppointmentAction`: gate, StaffBookingSchema, resolve patient, create core, conflict/override, audit, notify, revalidate | Tasks 4, 6 |
| Conflict → `code:'conflict'` + "Book anyway" → resubmit `override:true`; override audited | Tasks 4, 6, 9 |
| No migration | (verified — none) |
| §8 testing → vitest on the pure logic | Tasks 1, 2, 3, 5 |

---

## Self-review notes (for the executor)

- **Type consistency:** `BookingConflict` lives in `timing.ts` and is imported by `create.ts`, the staff action, and the client form. `PatientResolution` lives in `create.ts`. `StaffBookingInput` = `z.input` (client builds it raw; action re-parses). `ServiceRow` (7 fields incl. `requires_time_slot`/`allow_concurrent`) lives in `timing.ts`; the client's lighter `ServiceOption` (4 fields) is separate by design.
- **`doctorCtx` type:** declared as `DoctorCtx | undefined` (alias defined at the top of `create.ts`); `decideAppointmentTiming` treats a missing `doctor` as an error for the doctor branch only, so the `undefined` default is safe for the other three branches.
- **No orphan patients:** the patient is resolved via a thunk that `createAppointmentGroup` calls only after timing/conflicts pass — same ordering as the original public flow.
- **`server-only` discipline:** `timing.ts`, `resolve.ts`, `create.ts`, `staff-booking.ts`, `booking.ts` must NOT `import "server-only"` (vitest imports them). The service-role key only enters via the admin client passed as a param, and only the `"use server"` action files import `createAdminClient` as a value.
- **Behavior-preserved check:** the public conflict messages in `timing.ts` are byte-identical to the originals and pushed in the same short-circuit order, so strict-mode `conflicts[0]` reproduces the old single-error behavior.
