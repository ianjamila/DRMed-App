# Lab-request-form upload + marketing services-grid — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let patients upload a doctor's lab-request form at booking instead of hunting through ~250 tests, and fix the homepage services grid (even tiles, clickable "Inquire" → Messenger, Fit-to-Work → "Inquire").

**Architecture:** Two independent PRs. **PR 1** is a self-contained marketing-grid change (no DB). **PR 2** adds a private storage bucket + `appointment_attachments` table, relaxes the booking schema so "tests **or** a form" is valid, sends compressed files inline through the existing booking Server Action, creates a null-service "lab-request only" appointment when no tests are picked, and surfaces the form to reception via an audit-logged signed URL.

**Tech Stack:** Next.js 16 (App Router, React 19 Server Actions + `useActionState`), Supabase (Postgres + Storage, service-role admin client), Zod, Vitest, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-06-15-lab-request-upload-and-marketing-grid-design.md`

**Branching:** We're in a detached HEAD at `51ffab6`. Start each PR from a fresh branch off `main`:
- PR 1: `git switch -c fix/marketing-services-grid main`
- PR 2: `git switch -c feat/lab-request-upload main`

**Do not** `git add -A` — the repo has untracked `Partner-Feedback-Delivery-Report.html` that must stay out of commits. Stage exact paths only.

---

# PR 1 — Marketing services grid

## Task B1: Data — Messenger constant + Fit-to-Work price

**Files:**
- Modify: `src/lib/marketing/site.ts`

- [ ] **Step 1: Add `messenger` to `SOCIAL`**

In `src/lib/marketing/site.ts`, replace the `SOCIAL` block:

```ts
export const SOCIAL = {
  facebook: "https://www.facebook.com/drmedcliniclab/",
  instagram:
    "https://www.instagram.com/drmed.ph?igsh=Yzl4eDY3bXFyMnQy&utm_source=qr",
  // Single source of truth for the Messenger deep-link. Both m.me/drmed.ph and
  // m.me/drmedcliniclab resolve to the page; keep drmed.ph (used by the FAB).
  messenger: "https://m.me/drmed.ph",
} as const;
```

- [ ] **Step 2: Change Fit-to-Work price to "Inquire"**

In the `SERVICE_HIGHLIGHTS` array, the `"Fit to Work / Pre-Employment"` entry — change `price: "from ₱400"` to:

```ts
    price: "Inquire",
```

- [ ] **Step 3: Typecheck**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/lib/marketing/site.ts
git commit -m "feat(marketing): add SOCIAL.messenger; Fit-to-Work price → Inquire"
```

---

## Task B2: Equal-height + clickable service tiles

**Files:**
- Modify: `src/components/marketing/home/Services.tsx`

Each tile must (a) be equal height within its row and (b) be a link — `"Inquire"` tiles → Facebook Messenger (new tab); all other tiles → `/schedule`.

- [ ] **Step 1: Add imports**

At the top of `src/components/marketing/home/Services.tsx`, alongside the existing imports, add `Link` and pull `SOCIAL` from `site`:

```tsx
import Link from "next/link";
```

And extend the existing `site` import:

```tsx
import { SERVICE_HIGHLIGHTS, SOCIAL } from "@/lib/marketing/site";
```

- [ ] **Step 2: Replace the grid `.map(...)` block**

Replace the whole `{SERVICE_HIGHLIGHTS.map((svc) => { ... })}` block (the grid children) with this. It makes the card `h-full flex flex-col`, pins the price with `mt-auto`, and wraps each card in the correct link element:

```tsx
          {SERVICE_HIGHLIGHTS.map((svc) => {
            const Icon = ICON_MAP[svc.name] ?? Stethoscope;
            const isInquire = svc.price === "Inquire";
            const href = isInquire ? SOCIAL.messenger : "/schedule";

            const card = (
              <div className="flex h-full flex-col rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-white p-[26px] shadow-[var(--shadow-warm-sm)] transition-[transform,box-shadow] duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-warm-lg)] focus-visible:-translate-y-1 focus-visible:shadow-[var(--shadow-warm-lg)]">
                {/* Icon chip */}
                <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]">
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>

                <h3 className="mt-[18px] font-sans text-[17px] font-bold text-[color:var(--color-brand-navy)]">
                  {svc.name}
                </h3>

                <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-ink-soft)]">
                  {svc.desc}
                </p>

                <div className="mt-auto pt-4 font-[family-name:var(--font-display)] italic text-[17px] text-[color:var(--color-brand-cyan-text)]">
                  {svc.price}
                </div>
              </div>
            );

            return (
              <Reveal key={svc.name} className="h-full">
                {isInquire ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Inquire about ${svc.name} on Facebook Messenger`}
                    className="block h-full rounded-[20px] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] focus-visible:ring-offset-2"
                  >
                    {card}
                  </a>
                ) : (
                  <Link
                    href={href}
                    aria-label={`Book ${svc.name}`}
                    className="block h-full rounded-[20px] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] focus-visible:ring-offset-2"
                  >
                    {card}
                  </Link>
                )}
              </Reveal>
            );
          })}
```

Note: `Reveal` already forwards `className` (used elsewhere in this file as `<Reveal className=...>`), so `className="h-full"` makes the motion wrapper fill the grid cell — required for `h-full` on the card to equalize heights.

- [ ] **Step 3: Verify `Reveal` accepts and applies `className`**

Run: `export PATH="/opt/homebrew/bin:$PATH" && grep -n "className" src/components/marketing/motion/Reveal.tsx`
Expected: `Reveal` spreads/applies a `className` prop onto its root element. If it does NOT, wrap the grid cell instead: change the grid container children so each card is wrapped in `<div className="h-full">` around `<Reveal>`. (Check before assuming.)

- [ ] **Step 4: Typecheck + lint**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Manual visual check**

Run `npm run dev`, open `http://localhost:3000/#services`. Confirm: all tiles in each row are equal height; hovering lifts the whole card; "Inquire" tiles open Messenger in a new tab; priced tiles navigate to `/schedule`. Resize to 390px wide — single column, still tidy.

- [ ] **Step 6: Commit**

```bash
git add src/components/marketing/home/Services.tsx
git commit -m "feat(marketing): equal-height + clickable service tiles (Inquire → Messenger)"
```

---

## Task B3: Point the Messenger FAB at the shared constant

**Files:**
- Modify: `src/components/marketing/messenger-fab.tsx`

- [ ] **Step 1: Remove the stale placeholder comment**

Delete line 3:

```tsx
// PLACEHOLDER/VERIFY: confirm m.me/drmed.ph is the live page handle before launch (see DESIGN-NOTES.md).
```

- [ ] **Step 2: Import `SOCIAL` and use it for the href**

Add to the imports:

```tsx
import { SOCIAL } from "@/lib/marketing/site";
```

Change the anchor's `href="https://m.me/drmed.ph"` to:

```tsx
      href={SOCIAL.messenger}
```

- [ ] **Step 3: Typecheck**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/marketing/messenger-fab.tsx
git commit -m "refactor(marketing): MessengerFab reads SOCIAL.messenger (DRY)"
```

- [ ] **Step 5: Build + open PR 1**

```bash
export PATH="/opt/homebrew/bin:$PATH"
npm run build
git push -u origin fix/marketing-services-grid
gh pr create --base main --title "fix(marketing): even + clickable service tiles, Fit-to-Work → Inquire" \
  --body "Equal-height service tiles; every tile clickable (Inquire → Messenger, bookable → /schedule); Fit-to-Work price → Inquire; Messenger handle centralized into SOCIAL.messenger."
```

---

# PR 2 — Lab-request-form upload

> Start from a fresh branch: `git switch -c feat/lab-request-upload main`

## Task A1: Migration — bucket + `appointment_attachments` table

**Files:**
- Create: `supabase/migrations/0103_lab_request_attachments.sql`

- [ ] **Step 1: Write the migration**

```sql
-- =============================================================================
-- 0103_lab_request_attachments.sql
-- =============================================================================
-- Lets a patient attach a photo/PDF of their doctor's lab-request form at
-- booking time (public /schedule + portal) instead of itemizing every test.
-- Files live in a private bucket; reception views them via short-lived signed
-- URLs minted by a service-role server action (no per-row storage RLS, same
-- pattern as the result-images bucket in 0038). The table is keyed by
-- appointments.booking_group_id (a shared, non-unique column — not a FK).
-- =============================================================================

-- Storage bucket: lab-request-forms ------------------------------------------
-- Accepts JPEG/PNG/WebP + HEIC/HEIF (iPhone) + PDF. 10 MB per-file cap.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lab-request-forms',
  'lab-request-forms',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
on conflict (id) do nothing;

-- Table: appointment_attachments --------------------------------------------
create table public.appointment_attachments (
  id                uuid primary key default gen_random_uuid(),
  booking_group_id  uuid not null,
  patient_id        uuid references public.patients(id) on delete set null,
  storage_path      text not null,
  filename          text not null,
  mime_type         text not null,
  size_bytes        int  not null,
  kind              text not null default 'lab_request',
  created_at        timestamptz not null default now(),
  constraint appointment_attachments_mime_allowlist
    check (mime_type in ('image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf')),
  constraint appointment_attachments_size_cap
    check (size_bytes > 0 and size_bytes <= 10485760)
);

create index idx_appt_attachments_group
  on public.appointment_attachments (booking_group_id);

-- RLS: active staff may read; writes are service-role only (no policy).
alter table public.appointment_attachments enable row level security;

create policy "appointment_attachments: staff read"
  on public.appointment_attachments for select to authenticated
  using (public.is_staff());
```

- [ ] **Step 2: Apply + verify locally**

Run:
```bash
export PATH="/opt/homebrew/bin:$PATH"
supabase start
supabase db reset   # applies all migrations incl. 0103 to the local stack
```
Expected: reset completes without error; `0103_lab_request_attachments.sql` is listed.

> Remote apply (staging/prod) is done by the user later via the Supabase MCP
> (`execute_sql` + record the `0103` row in `schema_migrations`) — the direct DB
> host is IPv6-only/unreachable here. Do not attempt `supabase db push`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0103_lab_request_attachments.sql
git commit -m "feat(db): lab-request-forms bucket + appointment_attachments (0103)"
```

---

## Task A2: Regenerate database types

**Files:**
- Modify: `src/types/database.ts` (generated)

- [ ] **Step 1: Regenerate against the local stack**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run db:types`
Expected: `src/types/database.ts` now contains an `appointment_attachments` row type (Row/Insert/Update).

- [ ] **Step 2: Verify the type exists**

Run: `grep -n "appointment_attachments" src/types/database.ts | head`
Expected: at least one match.

- [ ] **Step 3: Commit**

```bash
git add src/types/database.ts
git commit -m "chore(db): regenerate types for appointment_attachments"
```

---

## Task A3: Pure lab-request helpers (status + gate) — TDD

**Files:**
- Create: `src/lib/appointments/lab-request.ts`
- Test: `src/lib/appointments/lab-request.test.ts`

These are pure (no server-only imports) so they're unit-testable and reusable by the Server Action.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { labRequestStatus, validateLabRequestGate } from "./lab-request";

describe("labRequestStatus", () => {
  it("maps callback → pending_callback", () => {
    expect(labRequestStatus("callback")).toEqual({
      status: "pending_callback",
      pendingCallback: true,
    });
  });
  it("maps walk_in → confirmed", () => {
    expect(labRequestStatus("walk_in")).toEqual({
      status: "confirmed",
      pendingCallback: false,
    });
  });
});

describe("validateLabRequestGate", () => {
  it("passes when tests are selected and no form", () => {
    expect(
      validateLabRequestGate({ serviceCount: 2, hasForm: false, preference: null }),
    ).toEqual({ ok: true });
  });
  it("passes when a form is attached with a preference and no tests", () => {
    expect(
      validateLabRequestGate({ serviceCount: 0, hasForm: true, preference: "walk_in" }),
    ).toEqual({ ok: true });
  });
  it("fails when nothing is selected and no form", () => {
    const r = validateLabRequestGate({ serviceCount: 0, hasForm: false, preference: null });
    expect(r.ok).toBe(false);
  });
  it("fails when a form is attached but no preference chosen", () => {
    const r = validateLabRequestGate({ serviceCount: 0, hasForm: true, preference: null });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/appointments/lab-request.test.ts`
Expected: FAIL ("Cannot find module './lab-request'").

- [ ] **Step 3: Implement**

```ts
// Pure helpers for the "doctor's request form instead of itemized tests"
// booking path. No server-only imports — safe to unit-test and to import from
// the booking Server Action.

export type IntakePreference = "walk_in" | "callback";

export function labRequestStatus(pref: IntakePreference): {
  status: "confirmed" | "pending_callback";
  pendingCallback: boolean;
} {
  return pref === "callback"
    ? { status: "pending_callback", pendingCallback: true }
    : { status: "confirmed", pendingCallback: false };
}

export function validateLabRequestGate(input: {
  serviceCount: number;
  hasForm: boolean;
  preference: IntakePreference | null;
}): { ok: true } | { ok: false; error: string } {
  if (input.serviceCount === 0 && !input.hasForm) {
    return {
      ok: false,
      error: "Pick at least one test, or upload your doctor's request form.",
    };
  }
  if (input.hasForm && input.preference === null) {
    return {
      ok: false,
      error: "Tell us whether you'll walk in or want us to confirm first.",
    };
  }
  return { ok: true };
}

export function parseIntakePreference(raw: unknown): IntakePreference | null {
  return raw === "walk_in" || raw === "callback" ? raw : null;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/lib/appointments/lab-request.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/appointments/lab-request.ts src/lib/appointments/lab-request.test.ts
git commit -m "feat(booking): pure lab-request status + gate helpers"
```

---

## Task A4: Relax the booking schema for the form path — TDD

**Files:**
- Modify: `src/lib/validations/booking.ts`
- Test: `src/lib/validations/booking.test.ts` (create)

The three non-doctor branches must accept an **empty** `service_ids` (the "form only" case). The cross-field "tests-or-form" gate is enforced in the Server Action (Task A7) via `validateLabRequestGate`, because `discriminatedUnion` members can't carry `superRefine`. Here we only relax `service_ids`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BookingSchema } from "./booking";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-01T08:00:00+08:00")); // Monday
});
afterEach(() => vi.useRealTimers());

const basePatient = {
  first_name: "Ana",
  last_name: "Cruz",
  middle_name: "",
  birthdate: "1990-01-01",
  sex: "female",
  phone: "09171234567",
  email: "ana@example.com",
  address: "",
  notes: "",
  marketing_consent: "off",
  service_agreement: "on",
};

describe("BookingSchema — lab-request form path", () => {
  it("accepts a lab_request booking with NO services (form-only)", () => {
    const r = BookingSchema.safeParse({
      ...basePatient,
      branch: "lab_request",
      service_ids: [],
      scheduled_at: "",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a home_service booking with NO services", () => {
    const r = BookingSchema.safeParse({
      ...basePatient,
      branch: "home_service",
      service_ids: [],
    });
    expect(r.success).toBe(true);
  });

  it("still accepts a lab_request booking WITH services", () => {
    const r = BookingSchema.safeParse({
      ...basePatient,
      branch: "lab_request",
      service_ids: ["22222222-2222-4222-8222-222222222222"],
      scheduled_at: "",
    });
    expect(r.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/validations/booking.test.ts`
Expected: FAIL (empty `service_ids` rejected by the `min(1)` rule).

- [ ] **Step 3: Add a `service_ids`-allows-empty variant**

In `src/lib/validations/booking.ts`, directly after the existing `serviceIds` const (ends line ~104), add:

```ts
// Like `serviceIds` but allows an empty array — used by the non-doctor
// branches where a patient may upload a doctor's request form instead of
// itemizing tests. The "must pick a test OR attach a form" rule is enforced
// server-side in submitBookingAction (validateLabRequestGate).
const serviceIdsAllowEmpty = z
  .union([z.array(z.string()), z.string(), z.undefined()])
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]))
  .pipe(z.array(z.string().uuid("Invalid service id.")));
```

- [ ] **Step 4: Point the three non-doctor branch field groups at it**

Change `service_ids: serviceIds` to `service_ids: serviceIdsAllowEmpty` in **all three** of these field groups (leave `DoctorAppointmentBranchFields` untouched — it uses `service_id`):

```ts
const DiagnosticPackageBranchFields = {
  branch: z.literal("diagnostic_package"),
  service_ids: serviceIdsAllowEmpty,
};
const LabRequestBranchFields = {
  branch: z.literal("lab_request"),
  service_ids: serviceIdsAllowEmpty,
  scheduled_at: optionalScheduledAt,
};
// DoctorAppointmentBranchFields — unchanged
const HomeServiceBranchFields = {
  branch: z.literal("home_service"),
  service_ids: serviceIdsAllowEmpty,
};
```

- [ ] **Step 5: Run the new test + the full suite**

Run: `npx vitest run src/lib/validations/booking.test.ts && npx vitest run`
Expected: new file PASS (3 tests); whole suite green (the existing `staff-booking.test.ts` is unaffected — it imports `StaffBookingSchema`, a different schema).

- [ ] **Step 6: Commit**

```bash
git add src/lib/validations/booking.ts src/lib/validations/booking.test.ts
git commit -m "feat(booking): allow empty service_ids on non-doctor branches (form path)"
```

---

## Task A5: Client-side image compression helper — TDD on the pure bit

**Files:**
- Create: `src/lib/images/compress-image.ts`
- Test: `src/lib/images/compress-image.test.ts`

The canvas work needs the DOM (not unit-testable here), so the size math is split into a pure `fitWithin` function that IS tested.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { fitWithin } from "./compress-image";

describe("fitWithin", () => {
  it("leaves small images untouched", () => {
    expect(fitWithin(1200, 900, 2200)).toEqual({ width: 1200, height: 900 });
  });
  it("scales a landscape image to the max long edge", () => {
    expect(fitWithin(4400, 2200, 2200)).toEqual({ width: 2200, height: 1100 });
  });
  it("scales a portrait image to the max long edge", () => {
    expect(fitWithin(3000, 6000, 2200)).toEqual({ width: 1100, height: 2200 });
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run src/lib/images/compress-image.test.ts`
Expected: FAIL ("Cannot find module './compress-image'").

- [ ] **Step 3: Implement**

```ts
// Client-side compression for doctor's request-form photos. Optimized for
// LEGIBILITY (small printed + handwritten text reception must read), not for
// minimum bytes: downscale the long edge to <=2200px and re-encode JPEG q0.82.
// PDFs, HEIC/HEIF the browser can't decode, and already-small images pass
// through untouched. Runs in the browser ('use client' callers only).

const MAX_EDGE = 2200;
const JPEG_QUALITY = 0.82;
const SKIP_IF_UNDER_BYTES = 600 * 1024;

/** Pure: target dimensions preserving aspect ratio within `maxEdge`. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

function canTryCanvas(file: File): boolean {
  // HEIC/HEIF only decode on Safari; PDFs never. Pass those through.
  return file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/webp";
}

/**
 * Returns a (possibly) compressed File. Never throws — on any failure it
 * resolves to the original file so a booking is never blocked by compression.
 */
export async function compressImage(file: File): Promise<File> {
  if (!canTryCanvas(file)) return file;
  if (file.size <= SKIP_IF_UNDER_BYTES) return file;

  try {
    // `imageOrientation: "from-image"` bakes EXIF rotation into the pixels so
    // a sideways phone photo doesn't reach reception rotated.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file; // don't upsize

    const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], newName, { type: "image/jpeg" });
  } catch {
    return file;
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx vitest run src/lib/images/compress-image.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/images/compress-image.ts src/lib/images/compress-image.test.ts
git commit -m "feat(images): legibility-first client image compression helper"
```

---

## Task A6: No-service "lab-request only" booking path

**Files:**
- Modify: `src/lib/appointments/create.ts`

Add a function that creates a single null-service appointment when a patient uploads a form but picks no tests. It reuses the existing `PatientResolution` + resolve thunk pattern.

- [ ] **Step 1: Add the import**

At the top of `src/lib/appointments/create.ts`, add `labRequestStatus` to the imports (next to the existing imports):

```ts
import { labRequestStatus, type IntakePreference } from "@/lib/appointments/lab-request";
```

- [ ] **Step 2: Add the function** (after `createAppointmentGroup`, at end of file)

```ts
export interface CreateLabRequestOnlyInput {
  branch: BookingBranch;
  intakePreference: IntakePreference;
  notes: string | null;
  createdBy: string | null;
  resolvePatient: () => Promise<{ ok: true; patient: PatientResolution } | { ok: false; error: string }>;
}

// A booking where the patient uploaded a doctor's request form instead of
// itemizing tests. One appointment row, service_id = null (column is nullable),
// scheduled_at = null. Status follows the patient's choice: walk-in →
// 'confirmed' (today's walk-in queue), callback → 'pending_callback'.
export async function createLabRequestOnlyBooking(
  admin: AdminClient,
  input: CreateLabRequestOnlyInput,
): Promise<
  | {
      ok: true;
      bookingGroupId: string;
      appointmentIds: string[];
      pendingCallback: boolean;
      patient: PatientResolution;
    }
  | { ok: false; error: string }
> {
  const patientRes = await input.resolvePatient();
  if (!patientRes.ok) return { ok: false, error: patientRes.error };
  const patient = patientRes.patient;

  const bookingGroupId = randomUUID();
  const { status, pendingCallback } = labRequestStatus(input.intakePreference);

  const { data: created, error } = await admin
    .from("appointments")
    .insert({
      patient_id: patient.patientId,
      service_id: null,
      physician_id: null,
      scheduled_at: null,
      notes: input.notes,
      status,
      booking_group_id: bookingGroupId,
      home_service_requested: input.branch === "home_service",
      walk_in_name: patient.walkInName ?? null,
      walk_in_phone: patient.walkInPhone ?? null,
      created_by: input.createdBy,
    })
    .select("id");

  if (error || !created || created.length !== 1) {
    return { ok: false, error: error?.message ?? "Could not save the request." };
  }

  return {
    ok: true,
    bookingGroupId,
    appointmentIds: created.map((r) => r.id),
    pendingCallback,
    patient,
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/appointments/create.ts
git commit -m "feat(booking): createLabRequestOnlyBooking (null-service appointment)"
```

---

## Task A7: Server Action — validate files, gate, upload, audit

**Files:**
- Modify: `src/app/(marketing)/schedule/actions.ts`

- [ ] **Step 1: Add imports + constants**

At the top of `actions.ts`, add to the imports:

```ts
import { createAppointmentGroup, createLabRequestOnlyBooking, type PatientResolution } from "@/lib/appointments/create";
import { validateLabRequestGate, parseIntakePreference } from "@/lib/appointments/lab-request";
```

(Replace the existing `createAppointmentGroup` import line so the symbols come from one import.)

Below the `HONEYPOT_OK` const, add:

```ts
const LAB_REQUEST_BUCKET = "lab-request-forms";
const LAB_REQUEST_MAX_FILES = 5;
const LAB_REQUEST_MAX_BYTES = 10 * 1024 * 1024;
const LAB_REQUEST_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

type LabRequestFile = { file: File; bytes: Uint8Array };

// Pull + validate uploaded request-form files from the FormData. Metadata
// checks only (count/size/mime) — bytes are read for the later upload.
async function collectLabRequestFiles(
  formData: FormData,
): Promise<{ ok: true; files: LabRequestFile[] } | { ok: false; error: string }> {
  const raw = formData.getAll("lab_request_files").filter((v): v is File => v instanceof File && v.size > 0);
  if (raw.length === 0) return { ok: true, files: [] };
  if (raw.length > LAB_REQUEST_MAX_FILES) {
    return { ok: false, error: `Please attach at most ${LAB_REQUEST_MAX_FILES} files.` };
  }
  const files: LabRequestFile[] = [];
  for (const file of raw) {
    if (file.size > LAB_REQUEST_MAX_BYTES) {
      return { ok: false, error: "Each file must be 10 MB or smaller." };
    }
    if (!LAB_REQUEST_MIME.has(file.type)) {
      return { ok: false, error: "Upload a photo (JPG/PNG/HEIC) or PDF of your request form." };
    }
    files.push({ file, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return { ok: true, files };
}

// Best-effort upload + record. Booking already succeeded; never throw.
async function storeLabRequestFiles(
  admin: AdminClient,
  files: LabRequestFile[],
  bookingGroupId: string,
  patientId: string | null,
): Promise<void> {
  for (const { file, bytes } of files) {
    const path = `lab_requests/${bookingGroupId}/${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
    const { error: upErr } = await admin.storage
      .from(LAB_REQUEST_BUCKET)
      .upload(path, bytes, { contentType: file.type, upsert: false });
    if (upErr) {
      console.error("lab-request upload failed", upErr);
      continue;
    }
    const { error: insErr } = await admin.from("appointment_attachments").insert({
      booking_group_id: bookingGroupId,
      patient_id: patientId,
      storage_path: path,
      filename: sanitizeFilename(file.name),
      mime_type: file.type,
      size_bytes: file.size,
      kind: "lab_request",
    });
    if (insErr) {
      console.error("lab-request attachment insert failed", insErr);
      await admin.storage.from(LAB_REQUEST_BUCKET).remove([path]);
    }
  }
}
```

- [ ] **Step 2: Wire the file flow into `submitBookingAction`**

In `submitBookingAction`, **after** the Zod parse populates `data` (after line ~199, before `const admin = createAdminClient();`), insert:

```ts
  // Doctor's request-form upload (non-doctor branches only). Validate file
  // metadata before doing any DB work so a bad file never creates a booking.
  const isNonDoctor = data.branch !== "doctor_appointment";
  const collected = isNonDoctor
    ? await collectLabRequestFiles(formData)
    : ({ ok: true, files: [] } as const);
  if (!collected.ok) return { ok: false, error: collected.error };
  const labRequestFiles = collected.files;
  const intakePreference = parseIntakePreference(formData.get("intake_preference"));

  // "Tests OR a form" gate (server source of truth).
  if (isNonDoctor) {
    const serviceCount =
      "service_ids" in data ? data.service_ids.length : 0;
    const gate = validateLabRequestGate({
      serviceCount,
      hasForm: labRequestFiles.length > 0,
      preference: intakePreference,
    });
    if (!gate.ok) return { ok: false, error: gate.error };
  }
```

- [ ] **Step 3: Branch booking creation on form-only**

Find the existing block (line ~201-242) that computes `serviceIds`, builds `resolveThunk`, and calls `createAppointmentGroup`. The `const admin`, `scheduledAt`, `serviceIds`, `physicianId`, and `resolveThunk` definitions stay. Replace **only** the `const result = await createAppointmentGroup(...)` call and the lines down to its error check with a branch that routes form-only bookings to the new path:

```ts
  const isFormOnly =
    isNonDoctor && serviceIds.filter((id): id is string => !!id).length === 0;

  const result = isFormOnly
    ? await createLabRequestOnlyBooking(admin, {
        branch: data.branch,
        intakePreference: intakePreference ?? "callback",
        notes: data.notes,
        createdBy: null,
        resolvePatient: resolveThunk,
      })
    : await createAppointmentGroup(admin, {
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
    return { ok: false, error: result.error };
  }

  // Upload the form(s) now that we have a booking_group_id + resolved patient.
  if (labRequestFiles.length > 0) {
    await storeLabRequestFiles(
      admin,
      labRequestFiles,
      result.bookingGroupId,
      result.patient.patientId,
    );
  }
```

> Note: `createLabRequestOnlyBooking`'s result has no `services`/`scheduledAtIso`. The
> sections below that read `result.services` / `result.scheduledAtIso` must be
> made form-only-safe — see Step 4.

- [ ] **Step 4: Make the audit + return blocks form-only-safe**

The existing audit call and the final `return` read `result.services` and `result.scheduledAtIso`. Add fallbacks. Replace the audit `metadata` service fields and the final return's `service_summary`/`scheduled_at` so both shapes work. Define once, just before the `await audit({...})` call:

```ts
  const resultServices = "services" in result ? result.services : [];
  const scheduledAtIso = "scheduledAtIso" in result ? result.scheduledAtIso : null;
  const serviceSummary =
    resultServices.length > 0
      ? resultServices.map((s) => s.name).join(", ")
      : "Tests from your uploaded request form";
```

Then in the `audit({ ... metadata: { ... } })` call, change the service fields and add the form fields:

```ts
      service_ids: resultServices.map((s) => s.id),
      service_names: resultServices.map((s) => s.name),
      pending_callback: result.pendingCallback,
      scheduled_at: scheduledAtIso,
      home_service_requested: data.branch === "home_service",
      physician_id: physicianId,
      patient_resolution: result.patient.resolution,
      via: isPortalSource ? "portal" : "schedule",
      lab_request_attached: labRequestFiles.length > 0,
      lab_request_count: labRequestFiles.length,
      intake_preference: intakePreference,
```

And in the final `return`:

```ts
  return {
    ok: true,
    drm_id: result.patient.drmId ?? "",
    service_summary: serviceSummary,
    scheduled_at: scheduledAtIso,
    pending_callback: result.pendingCallback,
    booking_group_id: result.bookingGroupId,
  };
```

> Also: the `notifyAppointmentBooked` call uses `result.appointmentIds[0]` — both result shapes expose `appointmentIds`, so it's unchanged.

- [ ] **Step 5: Typecheck**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run typecheck`
Expected: PASS. (If TS complains that `physicianId`/`scheduledAt`/`serviceIds` are declared after the new gate block uses `data`, keep those `const` declarations where they already are — line ~202-204 — they only need to precede the `isFormOnly`/`createAppointmentGroup` usage, not the gate.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(marketing)/schedule/actions.ts"
git commit -m "feat(booking): accept doctor's request-form upload in submitBookingAction"
```

---

## Task A8: Upload UI component

**Files:**
- Create: `src/components/marketing/booking-wizard/LabRequestUpload.tsx`

A focused client component: file input → compress on select → preview chips → remove, plus the walk-in/callback radio. Kept out of the 1,492-line `booking-form.tsx`.

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { useRef } from "react";
import { Upload, X, FileText } from "lucide-react";
import { compressImage } from "@/lib/images/compress-image";
import type { IntakePreference } from "@/lib/appointments/lab-request";

const MAX_FILES = 5;
const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf";

export function LabRequestUpload({
  files,
  onFilesChange,
  preference,
  onPreferenceChange,
  error,
}: {
  files: File[];
  onFilesChange: (next: File[]) => void;
  preference: IntakePreference | null;
  onPreferenceChange: (p: IntakePreference) => void;
  error?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    if (picked.length === 0) return;
    const room = MAX_FILES - files.length;
    const compressed = await Promise.all(picked.slice(0, room).map((f) => compressImage(f)));
    onFilesChange([...files, ...compressed]);
  }

  function removeAt(i: number) {
    onFilesChange(files.filter((_, idx) => idx !== i));
  }

  return (
    <div className="mt-5 rounded-[18px] border border-dashed border-[color:var(--color-warm-line)] bg-[color:var(--color-warm-sand)] p-5">
      <h4 className="font-[family-name:var(--font-display)] text-[19px] text-[color:var(--color-brand-navy)]">
        Have a doctor&apos;s request form?
      </h4>
      <p className="mt-1 text-[13.5px] text-[color:var(--color-ink-mid)]">
        Skip the test list — upload a photo or PDF and we&apos;ll order exactly
        what your doctor requested. You can still tick tests below if you like.
      </p>

      {files.length > 0 ? (
        <ul className="mt-3 grid gap-2">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="flex items-center justify-between gap-3 rounded-[12px] border border-[color:var(--color-warm-line)] bg-white px-3 py-2 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileText className="h-4 w-4 shrink-0 text-[color:var(--color-brand-cyan-text)]" />
                <span className="truncate text-[color:var(--color-ink)]">{f.name}</span>
                <span className="shrink-0 text-xs text-[color:var(--color-ink-soft)]">
                  {(f.size / 1024).toFixed(0)} KB
                </span>
              </span>
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label={`Remove ${f.name}`}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[color:var(--color-ink-soft)] transition hover:bg-[color:var(--color-warm-sand)] hover:text-[color:var(--color-danger)]"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {files.length < MAX_FILES ? (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-full border-[1.5px] border-[color:var(--color-brand-navy)] bg-white px-5 py-2.5 text-sm font-bold text-[color:var(--color-brand-navy)] transition hover:bg-[color:var(--color-brand-navy)] hover:text-white"
        >
          <Upload className="h-4 w-4" />
          {files.length === 0 ? "Upload request form" : "Add another"}
        </button>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        onChange={handlePick}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />
      <p className="mt-2 text-xs text-[color:var(--color-ink-soft)]">
        Up to {MAX_FILES} photos/PDFs · 10 MB each · photos are optimized
        automatically.
      </p>

      {files.length > 0 ? (
        <fieldset className="mt-4">
          <legend className="text-[13.5px] font-semibold text-[color:var(--color-ink)]">
            How should we handle this?{" "}
            <span className="text-[color:var(--color-danger)]">*</span>
          </legend>
          <div className="mt-2 grid gap-2">
            {(
              [
                { value: "walk_in", label: "I'll just walk in — read my form at the counter" },
                { value: "callback", label: "Please confirm the tests and price with me first" },
              ] as const
            ).map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-2.5 rounded-[12px] border-[1.5px] bg-white p-3 text-sm transition ${
                  preference === opt.value
                    ? "border-[color:var(--color-brand-cyan)]"
                    : "border-[color:var(--color-warm-line)]"
                }`}
              >
                <input
                  type="radio"
                  name="lab_request_intake"
                  checked={preference === opt.value}
                  onChange={() => onPreferenceChange(opt.value)}
                  className="mt-0.5 h-5 w-5 accent-[color:var(--color-brand-cyan)]"
                />
                <span className="text-[color:var(--color-ink-mid)]">{opt.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {error ? (
        <p className="mt-2 text-[12.5px] text-[color:var(--color-danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/marketing/booking-wizard/LabRequestUpload.tsx
git commit -m "feat(booking): LabRequestUpload component (compress + preview + intake radio)"
```

---

## Task A9: Wire upload into the booking wizard

**Files:**
- Modify: `src/app/(marketing)/schedule/booking-form.tsx`

- [ ] **Step 1: Import the component + type**

Near the other component imports at the top of `booking-form.tsx`, add:

```tsx
import { LabRequestUpload } from "@/components/marketing/booking-wizard/LabRequestUpload";
import type { IntakePreference } from "@/lib/appointments/lab-request";
```

- [ ] **Step 2: Add state** (after `const [notes, setNotes] = useState("");`, line ~172)

```tsx
  const [labRequestFiles, setLabRequestFiles] = useState<File[]>([]);
  const [intakePreference, setIntakePreference] = useState<IntakePreference | null>(null);
```

- [ ] **Step 3: Reset upload state when the branch changes**

In the Booking-step `ChoiceCard` `onSelect` (line ~546-553), add two resets alongside the existing ones:

```tsx
                          onSelect={() => {
                            setBranch(b);
                            setSelectedServiceIds(new Set());
                            setSingleServiceId("");
                            setSpecialtyCode("");
                            setPhysicianId("");
                            setSlot({ date: null, time: null });
                            setLabRequestFiles([]);
                            setIntakePreference(null);
                          }}
```

- [ ] **Step 4: Wrap the form action to append files + preference**

Replace `<form action={formAction}>` (line ~503) with a wrapper that appends the state-held files. Add this `const` just before the `return (` of `BookingForm` (near line ~378, after `jumpTo`):

```tsx
  // Files live in React state (not a DOM <input type=file>) so they survive
  // step navigation + the React-19 form re-render. Append them at submit time.
  const submitWithFiles = (formData: FormData) => {
    for (const f of labRequestFiles) formData.append("lab_request_files", f, f.name);
    if (intakePreference) formData.append("intake_preference", intakePreference);
    return formAction(formData);
  };
```

Then change the form tag:

```tsx
          <form action={submitWithFiles}>
```

- [ ] **Step 5: Pass upload props into `DetailsStep`**

In the `<DetailsStep ... />` call (line ~564-605), add these props (anywhere in the prop list):

```tsx
                    showLabRequestUpload={branch !== "doctor_appointment"}
                    labRequestFiles={labRequestFiles}
                    onLabRequestFilesChange={setLabRequestFiles}
                    intakePreference={intakePreference}
                    onIntakePreferenceChange={setIntakePreference}
```

- [ ] **Step 6: Extend `DetailsStep`'s prop type + destructure**

In `function DetailsStep(props: { ... })` (line ~898), add to the prop type (before `errors: Record<string, string>;`):

```tsx
  showLabRequestUpload: boolean;
  labRequestFiles: File[];
  onLabRequestFilesChange: (next: File[]) => void;
  intakePreference: IntakePreference | null;
  onIntakePreferenceChange: (p: IntakePreference) => void;
```

And add them to the destructure block (line ~929-958):

```tsx
    showLabRequestUpload,
    labRequestFiles,
    onLabRequestFilesChange,
    intakePreference,
    onIntakePreferenceChange,
```

- [ ] **Step 7: Render the upload panel in `DetailsStep`**

In `DetailsStep`'s JSX, the non-doctor branches render `<ServiceMultiPicker .../>` (line ~1131-1141, the `: (` branch of the `branch === "doctor_appointment" ? ... : (...)`). Wrap so the upload appears **above** the picker. Replace that `: (` ... `)` ServiceMultiPicker block with:

```tsx
      ) : (
        <>
          {showLabRequestUpload ? (
            <LabRequestUpload
              files={labRequestFiles}
              onFilesChange={onLabRequestFilesChange}
              preference={intakePreference}
              onPreferenceChange={onIntakePreferenceChange}
              error={errors.intake}
            />
          ) : null}
          <ServiceMultiPicker
            isPackages={branch === "diagnostic_package"}
            query={serviceQuery}
            onQueryChange={onServiceQuery}
            services={filteredServices}
            selectedIds={selectedServiceIds}
            onToggle={onToggleService}
            error={errors.services}
          />
        </>
      )}
```

- [ ] **Step 8: Update per-step validation for the form path**

In `validate()` (line ~317-341), the `key === "details"` non-doctor branch currently errors when `selectedServiceIds.size === 0`. Replace that `else if` so a form satisfies the requirement and an attached form requires a preference:

```ts
      } else {
        const hasForm = labRequestFiles.length > 0;
        if (selectedServiceIds.size === 0 && !hasForm) {
          e.services = "Pick at least one test, or upload your doctor's request form.";
        }
        if (hasForm && !intakePreference) {
          e.intake = "Tell us whether you'll walk in or want us to confirm first.";
        }
      }
```

- [ ] **Step 9: Show the form on the Review step**

Pass two props into `<ReviewStep ... />` (line ~714-742):

```tsx
                    labRequestCount={labRequestFiles.length}
                    intakePreference={intakePreference}
```

Add them to `ReviewStep`'s prop type (line ~1182-1206, before `errors:`):

```tsx
  labRequestCount: number;
  intakePreference: IntakePreference | null;
```

Destructure them (line ~1207-1228):

```tsx
    labRequestCount,
    intakePreference,
```

And add a row to the `rows` array (line ~1250-1273), after the `Services` row entry — append before the `notes` spread:

```tsx
    ...(labRequestCount > 0
      ? [
          {
            label: "Request form",
            value: `${labRequestCount} file${labRequestCount > 1 ? "s" : ""} attached · ${
              intakePreference === "callback"
                ? "we'll confirm tests/price with you"
                : "walk in — reception reads it at the counter"
            }`,
            onEdit: () => onJump("details"),
          },
        ]
      : []),
```

(Make sure `onJump` is in `ReviewStep`'s destructure — it already is.)

- [ ] **Step 10: Typecheck + lint**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add "src/app/(marketing)/schedule/booking-form.tsx"
git commit -m "feat(booking): wire request-form upload into the /schedule wizard"
```

---

## Task A10: Raise the Server-Action body limit

**Files:**
- Modify: `next.config.ts`

- [ ] **Step 1: Confirm the Next 16 config key**

Run: `export PATH="/opt/homebrew/bin:$PATH" && grep -rn "bodySizeLimit" node_modules/next/dist/ | head`
Expected: confirms `serverActions.bodySizeLimit` lives under `experimental`. (Per AGENTS.md, verify before editing.)

- [ ] **Step 2: Add the limit to `nextConfig`**

In `next.config.ts`, add an `experimental` block to the `nextConfig` object (alongside `allowedDevOrigins` / `headers`):

```ts
const nextConfig: NextConfig = {
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  experimental: {
    // Lab-request-form uploads ride inline in the booking Server Action.
    // Compressed photos are small, but allow headroom for a 5-file submission.
    serverActions: { bodySizeLimit: "20mb" },
  },
  async headers() {
```

- [ ] **Step 3: Typecheck + build**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run typecheck && npm run build`
Expected: PASS; build completes.

- [ ] **Step 4: Commit**

```bash
git add next.config.ts
git commit -m "chore(config): raise Server Action body limit to 20mb for form uploads"
```

---

## Task A11: Reception — signed-URL action + appointments badge

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/appointments/lab-request-actions.ts`
- Create: `src/app/(staff)/staff/(dashboard)/appointments/lab-request-links.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/page.tsx`

- [ ] **Step 1: Server action — audit-logged signed URL**

Create `lab-request-actions.ts`:

```ts
"use server";

import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

const BUCKET = "lab-request-forms";

type Result = { ok: true; url: string } | { ok: false; error: string };

export async function getLabRequestFormUrlAction(attachmentId: string): Promise<Result> {
  const profile = await requireActiveStaff();
  const admin = createAdminClient();

  const { data: att } = await admin
    .from("appointment_attachments")
    .select("storage_path")
    .eq("id", attachmentId)
    .maybeSingle();

  if (!att) return { ok: false, error: "Attachment not found." };

  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(att.storage_path, 300);
  if (error || !data) return { ok: false, error: "Could not open the file." };

  await audit({
    actor_id: profile.user_id,
    actor_type: "staff",
    action: "lab_request.viewed",
    resource_type: "appointment_attachment",
    resource_id: attachmentId,
    metadata: { storage_path: att.storage_path },
  });

  return { ok: true, url: data.signedUrl };
}
```

> Verify `requireActiveStaff()` returns a `user_id` field — it's used the same way in
> other staff actions. If the property differs (e.g. `id`), match it.

- [ ] **Step 2: Client links component**

Create `lab-request-links.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { Paperclip } from "lucide-react";
import { getLabRequestFormUrlAction } from "./lab-request-actions";

export type LabRequestAttachment = { id: string; filename: string };

export function LabRequestLinks({ attachments }: { attachments: LabRequestAttachment[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  function open(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await getLabRequestFormUrlAction(id);
      if (res.ok) window.open(res.url, "_blank", "noopener,noreferrer");
      else setError(res.error);
    });
  }

  return (
    <div className="mt-1">
      <p className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-violet-900">
        <Paperclip className="h-3 w-3" /> Request form
      </p>
      <ul className="mt-1 space-y-0.5">
        {attachments.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => open(a.id)}
              disabled={pending}
              className="max-w-[180px] truncate text-left text-xs text-[color:var(--color-brand-cyan)] underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
            >
              {a.filename}
            </button>
          </li>
        ))}
      </ul>
      {error ? <p className="text-[10px] text-red-700">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 3: Load attachments in the page + thread to `GroupRow`**

In `page.tsx`:

(a) Add the import near the top:

```tsx
import { LabRequestLinks, type LabRequestAttachment } from "./lab-request-links";
```

(b) After `const allUpcomingGroups = ...` (line ~264), load attachments for every visible group's `booking_group_id` and build a map. Add:

```tsx
  const groupIds = Array.from(
    new Set(
      [...allPendingGroups, ...allTodayGroups, ...allUpcomingGroups]
        .map((g) => g.lead.booking_group_id)
        .filter((id): id is string => !!id),
    ),
  );
  const attachmentsByGroup = new Map<string, LabRequestAttachment[]>();
  if (groupIds.length > 0) {
    const { data: attachRows } = await supabase
      .from("appointment_attachments")
      .select("id, filename, booking_group_id")
      .in("booking_group_id", groupIds);
    for (const a of attachRows ?? []) {
      const list = attachmentsByGroup.get(a.booking_group_id) ?? [];
      list.push({ id: a.id, filename: a.filename });
      attachmentsByGroup.set(a.booking_group_id, list);
    }
  }
```

(c) Pass the map into each `<Section ... />` (lines ~316-333) by adding a prop:

```tsx
        attachmentsByGroup={attachmentsByGroup}
```

to all three `<Section>` calls.

(d) Thread it through `Section` → `GroupRow`. Update `Section`'s signature (line ~338-348) to accept and forward it:

```tsx
function Section({
  title,
  groups,
  empty,
  isAdmin,
  attachmentsByGroup,
}: {
  title: string;
  groups: ApptGroup[];
  empty: string;
  isAdmin: boolean;
  attachmentsByGroup: Map<string, LabRequestAttachment[]>;
}) {
```

and in its `groups.map`:

```tsx
                <GroupRow
                  key={g.key}
                  group={g}
                  isAdmin={isAdmin}
                  attachments={
                    g.lead.booking_group_id
                      ? attachmentsByGroup.get(g.lead.booking_group_id) ?? []
                      : []
                  }
                />
```

(e) Update `GroupRow` (line ~388-394) to accept `attachments` and render the links under the Patient cell. Change its signature:

```tsx
function GroupRow({
  group,
  isAdmin,
  attachments,
}: {
  group: ApptGroup;
  isAdmin: boolean;
  attachments: LabRequestAttachment[];
}) {
```

and inside the Patient `<td>` (after the `home_service_requested` block, line ~438-442), add:

```tsx
        <LabRequestLinks attachments={attachments} />
```

- [ ] **Step 4: Typecheck + lint**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/appointments/lab-request-actions.ts" \
        "src/app/(staff)/staff/(dashboard)/appointments/lab-request-links.tsx" \
        "src/app/(staff)/staff/(dashboard)/appointments/page.tsx"
git commit -m "feat(staff): show + open uploaded request forms on Appointments"
```

---

## Task A12: Full suite + build + smoke

- [ ] **Step 1: Run the full unit suite**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm test`
Expected: all green (incl. the new `lab-request`, `booking`, `compress-image` tests).

- [ ] **Step 2: Production build**

Run: `export PATH="/opt/homebrew/bin:$PATH" && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Manual smoke (local dev against the local Supabase stack)**

With `supabase start` running and `npm run dev`:
1. `/schedule` → "Lab Tests" → Details: upload a photo. Confirm a compressed preview chip appears, the "pick at least one test" error is gone, and the walk-in/callback radio shows.
2. Pick "walk in", finish booking. Confirm success screen says the form will be reviewed.
3. As staff, open `/staff/appointments` → confirm a "Request form" link appears under the patient; clicking opens the image in a new tab.
4. Repeat choosing "confirm first" → confirm the booking lands under "Pending callback".
5. Repeat with tests selected **and** a file → both the services and the form attach.

- [ ] **Step 4: Push + open PR 2**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git push -u origin feat/lab-request-upload
gh pr create --base main --title "feat(booking): upload doctor's lab-request form at booking" \
  --body "Patients can attach up to 5 photos/PDFs of a doctor's request form on the Lab/Home/Package branches instead of itemizing tests; client-compressed, sent inline; form-only bookings create a null-service appointment (walk-in or callback per patient choice); reception opens the form via an audit-logged signed URL. Migration 0103 (apply to staging/prod via Supabase MCP)."
```

---

## Self-review notes (coverage map)

- Spec A1 (UX) → A8 + A9. Spec A2 (compression) → A5. Spec A3 (body limit) → A10.
  Spec A4 (bucket + table + RLS) → A1. Spec A5 (action flow + gate + no-service) →
  A3, A6, A7. Spec A6 (schema) → A4. Spec A7 (reception) → A11. Spec A8 (review +
  success copy) → A9 (review row) + A7 (`service_summary` for success). Spec A9
  (edge cases) → A7 (honeypot precedes; mixed path). Part B → B1–B3.
- After remote migration apply, re-run `npm run db:types:remote` if the prod
  type shape must match (the committed types come from the local stack — same DDL).
