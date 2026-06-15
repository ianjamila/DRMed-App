# Design — Lab-request-form upload at booking + marketing services-grid fixes

- **Date:** 2026-06-15
- **Status:** Approved-pending-review
- **Surfaces:** Marketing site (`/`) + public/portal booking wizard (`/schedule`)
- **Ships as:** two independent PRs (Part B first as a fast change, then Part A)

## Problem

1. **Booking friction.** When a patient books a lab visit, the Details step asks
   them to find each test by name in a list of ~250 services. Patients arriving
   with a doctor's hand-written request form can't realistically match every
   line item. They should be able to **photograph / upload the request form**
   and let reception order the exact tests — the digital version of handing the
   paper slip across the counter.

2. **Marketing services grid.** On the homepage "Everything under one roof"
   grid: tiles are uneven height; the "Inquire" tiles aren't clickable; and
   "Fit to Work / Pre-Employment" shows a misleading "from ₱400".

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Reception flow when a form replaces test selection | **Let the patient choose** — "I'll walk in" vs "Confirm tests/price with me first" |
| Which booking branches offer upload | **Lab + Home Service + Packages** (every non-doctor branch: `lab_request`, `home_service`, `diagnostic_package`) |
| Where "Inquire" tiles link | **Facebook Messenger** (`https://m.me/drmedcliniclab`, new tab) |
| Upload transport | **Inline** in the booking Server Action + **client-side image compression** + raised Server-Action body limit |

---

## Part A — Lab-request-form upload

> Naming note: the individual-lab-test booking branch is already called
> `lab_request` in code. To avoid confusion this feature is called the
> **request-form upload** throughout.

### A1. Booking wizard UX (Details step)

On the three non-doctor branches, add an **upload panel** above the test picker:

> **Have a doctor's request form?**
> Skip the test list — upload a photo or PDF and we'll order exactly what your
> doctor requested.

- Accepts **up to 5** files (multi-page request, front/back, multiple slips).
  Images + PDF.
- Each file shows a **thumbnail/file-chip preview** with a remove (✕) button.
- The picker stays available: a patient may upload a form, tick a few tests they
  know, or both. Uploading **lifts the "pick at least one test" requirement**.
- When ≥1 file is attached, a required radio appears:
  - ○ **I'll just walk in** — reception reads my form at the counter
  - ○ **Please confirm the tests and price with me first**
- The existing "Notes (optional)" field is unchanged.

The chosen `File[]` is held in React state (not a DOM file input) so it survives
step navigation and the React-19 form re-render. On submit a thin wrapper
appends the files to the FormData before delegating to the `useActionState`
dispatch:

```ts
const submitWithFiles = (formData: FormData) => {
  for (const f of labRequestFiles) formData.append("lab_request_files", f, f.name);
  formData.append("intake_preference", intakePreference); // "walk_in" | "callback"
  formData.append("lab_request_attached", labRequestFiles.length ? "1" : "");
  formAction(formData);
};
<form action={submitWithFiles}>
```

### A2. Client-side compression

Auto-compress on file selection (before the file enters form state) via a small
dependency-free helper (`src/lib/images/compress-image.ts`). A request form is a
**text document reception must read**, so settings prioritize legibility over
raw size:

- For JPEG/PNG/WebP: draw to a canvas, downscale **longest edge to ≤2200px**,
  export **JPEG quality 0.82**. (2200px — not 1600px — keeps small printed +
  handwritten lab-form text crisp; 0.82 avoids artifacts around text edges while
  still cutting size hard.)
- **Honor EXIF orientation** (e.g. `createImageBitmap(file, { imageOrientation:
  "from-image" })`) so a rotated phone photo doesn't reach reception sideways.
- **Skip compression** for: PDFs (pass through); images already ≤2200px and
  small (≈≤600 KB); and HEIC/HEIF the browser can't decode to a canvas (Chrome /
  Firefox) — pass the original through untouched.
- **Typical result:** a 3–8 MB phone photo → ~0.5–1.2 MB. Five files ≈ 3–6 MB.

Server-side normalization of HEIC → JPEG is **out of scope for v1** (noted as a
follow-up); the bucket accepts HEIC so iPhone uploads never bounce.

### A3. Server-Action body limit

Phone photos can exceed the 1 MB Server-Action default. Raise it in
`next.config.ts` (verify the exact Next 16 key against
`node_modules/next/dist/docs/` per AGENTS.md):

```ts
experimental: { serverActions: { bodySizeLimit: "20mb" } }
```

Five compressed files (~3–6 MB) stay well under this; 20 MB is headroom for the
occasional uncompressed HEIC/PDF in a 5-file submission. The per-file 10 MB
bucket limit (A4) rejects any single pathological file.

### A4. Data model (one migration)

**Storage bucket** `lab-request-forms` — private, ~10 MB file-size limit, MIME
allowlist `image/jpeg, image/png, image/webp, image/heic, image/heif,
application/pdf`. Service-role access only, **no per-row storage RLS** — mirrors
the existing `result-images` bucket (migration 0038).

**Table** `appointment_attachments`:

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `booking_group_id` | uuid not null | indexed; ties to `appointments.booking_group_id` (shared column, not a FK) |
| `patient_id` | uuid null → set | FK `patients(id)`; populated after patient resolution |
| `storage_path` | text not null | `lab_requests/<booking_group_id>/<uuid>-<sanitized_name>` |
| `filename` | text not null | sanitized original name |
| `mime_type` | text not null | |
| `size_bytes` | int not null | post-compression |
| `kind` | text not null default `'lab_request'` | future-proofing |
| `created_at` | timestamptz default now() | |

RLS: **active staff may SELECT**; writes are service-role only (no INSERT/UPDATE
policy). Mirror `bill_attachments` policies (confirm exact policy shape during
planning). Patients have no direct policy — they never query this table.

### A5. Server-Action flow (`submitBookingAction`)

After existing validation passes and before/around appointment creation:

1. Read `formData.getAll("lab_request_files")` (Files), `intake_preference`,
   `lab_request_attached`.
2. **Validate files server-side** (count ≤5, each ≤10 MB, MIME in allowlist).
   Reject with a friendly message on violation.
3. Resolve `serviceIds` (may now be empty on the three non-doctor branches).
4. **Gate:** require `serviceIds.length > 0` **OR** a valid uploaded form. Else
   → "Pick at least one test, or upload your doctor's request form."
5. **Booking creation:**
   - *Tests selected* → existing `createAppointmentGroup` path unchanged.
   - *Form only, no tests* → new path inserts **one** `appointments` row with
     `service_id = null` (column is already nullable), `scheduled_at = null`,
     and `status` from the radio: `walk_in` → `confirmed`, `callback` →
     `pending_callback`. Both already render in reception's existing queues.
     Implemented as a small sibling helper (`createLabRequestOnlyBooking`) or a
     `serviceIds.length === 0` branch inside `createAppointmentGroup` that skips
     `loadServices`/branch-kind validation.
6. **Upload + record:** for each file, upload to the bucket via the service-role
   admin client, insert an `appointment_attachments` row (with the resolved
   `patient_id` and `booking_group_id`). Best-effort cleanup of uploaded blobs
   if the row insert fails — mirrors `uploadBillAttachmentAction`.
7. **Audit:** booking audit metadata gains `lab_request_attached: true`,
   `lab_request_count`, `intake_preference`; plus one
   `lab_request.uploaded` audit row per file.

`service_summary` on the result becomes "Tests from your uploaded request form"
when form-only, so the success screen and notification read sensibly.

### A6. Validation schema (`src/lib/validations/booking.ts`)

- Relax `service_ids` on the three non-doctor branch field groups
  (`DiagnosticPackageBranchFields`, `LabRequestBranchFields`,
  `HomeServiceBranchFields`) to **allow an empty array**.
- Add to those branch groups: `lab_request_attached` (coerced bool) and
  `intake_preference` (`z.enum(["walk_in","callback"]).optional()`).
- Branch-level `superRefine`: if `!lab_request_attached` and `service_ids` empty
  → issue "Pick at least one test or upload your request form"; if
  `lab_request_attached` then `intake_preference` is required.
- Doctor branch is untouched. Both `BookingSchema` and
  `ExistingPatientBookingSchema` reuse the same relaxed branch groups, so portal
  + existing-patient bookings get the feature for free.

### A7. Reception / staff side (so the feature is usable)

- New staff action `getLabRequestFormUrlAction(attachmentId)` —
  active-staff-gated, returns a 5-minute signed URL, **audit-logs the view**
  (`lab_request.viewed`). Mirrors `getBillAttachmentDownloadUrlAction`.
- Staff **Appointments** list/detail: show a **"📎 Request form"** affordance on
  bookings whose `booking_group_id` has attachment rows; clicking opens each
  file via the signed URL. Also surface the `intake_preference` so reception
  knows whether the patient expects a callback. (Confirm exact component during
  planning — `src/app/(staff)/staff/(dashboard)/appointments/page.tsx`.)

### A8. Review step + success panel

- **Review step:** add a "Request form" row — "1 file attached · reception will
  confirm your tests" + the chosen walk-in/callback preference.
- **Success panel:** when form-only, show "Reception will review your doctor's
  request form and confirm your tests" instead of an itemized service list.

### A9. Edge cases

- Honeypot bots: file handling runs after the honeypot short-circuit — unchanged.
- Rate limiting: existing per-IP / per-patient limits already bound abuse;
  file-count + size caps bound payload.
- Doctor branch never shows the upload panel and its schema is unchanged.
- Mixed (tests + form): both persist; per-service appointment rows + attachments
  on the shared group.

### A10. Files touched (Part A)

- `supabase/migrations/0103_lab_request_attachments.sql` (new) + `db:types`
- `src/lib/validations/booking.ts`
- `src/app/(marketing)/schedule/actions.ts`
- `src/lib/appointments/create.ts` (no-service path)
- `src/app/(marketing)/schedule/booking-form.tsx` (upload panel, preview, radio,
  wrapped action, review row, success copy)
- `src/lib/images/compress-image.ts` (new)
- `next.config.ts` (body-size limit)
- New staff action for signed-URL viewing + staff Appointments display
- Audit action strings; tests (schema + no-service booking path)

---

## Part B — Marketing services grid

**Files:** `src/components/marketing/home/Services.tsx`, `src/lib/marketing/site.ts`, `src/components/marketing/messenger-fab.tsx` (point it at the new `SOCIAL.messenger` constant)

1. **Even tile heights.** Make each card `h-full flex flex-col`; push the price
   line down with `mt-auto`. Cards in a row equalize regardless of copy length.
2. **Fit to Work / Pre-Employment** price `"from ₱400"` → `"Inquire"` in
   `SERVICE_HIGHLIGHTS`.
3. **Clickable tiles.** Tiles whose price is `"Inquire"` (ECG, Ultrasound,
   Fit-to-Work, Home Service, Mobile Clinic) become links → Facebook Messenger
   (new tab, `rel="noopener noreferrer"`). **Proposed default:** the remaining
   tiles (Doctor's Consultation, Laboratory Tests, X-Ray) — currently inert
   despite a hover-lift that implies clickability — link to `/schedule`. So
   every tile is clickable: Inquire → Messenger, bookable → booking. *(Revert to
   "only Inquire tiles clickable" if preferred.)*
   - Accessibility: whole-card link wrapping the existing markup; keep the
     hover-lift; ensure focus-visible ring; aria-label per card.

   **Messenger handle (single source of truth).** A `MessengerFab` component
   already links Messenger via a **hard-coded** `https://m.me/drmed.ph`. Partner
   confirmed **both `m.me/drmed.ph` and `m.me/drmedcliniclab` resolve to the
   page**, so we keep the existing `drmed.ph` value (no regression) but lift it
   into a single `SOCIAL.messenger` constant and refactor `MessengerFab` to read
   it (small DRY fix to code we're touching). The new tile links read the same
   constant — one place to change the handle in future. The stale
   "PLACEHOLDER/VERIFY" comment on the FAB is removed.

---

## Out of scope / follow-ups

- Server-side HEIC → JPEG normalization (v1 accepts HEIC as-is).
- Patient portal view of their own uploaded request form (table already carries
  `patient_id`, so a future portal policy + page is a small add).
- OCR / auto-mapping the request form to services (manual reception entry for now).

## Testing

- **Unit (vitest):** booking schema — services-or-form gate, intake_preference
  requirement, empty-services acceptance with form; `compress-image` size/format
  branches (logic-only, no DOM heavy paths).
- **Integration:** no-service `createLabRequestOnlyBooking` inserts one
  null-service appointment with the right status.
- **Manual/Playwright smoke:** upload a photo on the Lab branch, both radio
  choices, verify the appointment + attachment land and reception can open the
  signed URL. Part B: visual check of equal tiles + Messenger link at 390×844
  and desktop.

## Rollout

- **PR 1 (Part B):** marketing grid — no migration, fast, low-risk.
- **PR 2 (Part A):** migration 0103 first (apply to staging → prod via MCP per
  the remote-DB-ops note), then code; `db:types` regen; smoke on staging.
