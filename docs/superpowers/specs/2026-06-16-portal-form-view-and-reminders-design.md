# Design — Patient-portal form view + day-before email reminders (+ folded-in polish)

- **Date:** 2026-06-16
- **Branch:** `feat/portal-form-view-and-reminders` (off `origin/main` @ `1a98cf1`)
- **Status:** Approved design, ready for implementation plan
- **Source backlog:** `project_drmed_post_upload_backlog` — the two ⭐ customer items, plus all four "out of scope" riders the user asked to fold into this one PR.

## 1. Goals

Two ⭐ features off the post-upload backlog, plus four polish riders, shipped as **one PR / one branch**:

1. **Portal view of uploaded request form** — a logged-in patient can see, preview, download, and remove the doctor's-request-form file(s) they attached at booking.
2. **Day-before email reminder** — a daily cron emails patients the evening before a confirmed appointment.

Folded-in riders:
- **A.** Email-honesty copy fix (5 spots that promise SMS we don't send).
- **B.** Upload thumbnails — booking success screen, portal row, + a receipt line in the confirmation email.
- **C.** Patient self-delete of a wrong upload.
- **D.** Reminder "request form on file" line.

## 2. Constraints & established patterns (load-bearing)

- **Email-only notifications.** No SMS/WhatsApp/Viber. `sms.ts` exists but auto-skips with no key; the reminder is **email-only** and does not call it. (`feedback_email_only_notifications`)
- **Two auth systems.** Patients auth via DRM-ID + receipt PIN → `drmed_patient_session` JWT; only patients who have *visited* (have a PIN) can log into the portal. The uploaded form attaches at *booking* (before any visit), so the portal view surfaces historical uploads once the patient has portal access.
- **Patient data-access pattern actually used by the portal:** the portal home (`loadResults`) and all three existing patient download actions (`getPatientResultDownloadUrl`, `getPatientConsolidatedResultDownloadUrl`, `getPackagePdfDownloadUrl`) read via the **service-role admin client + an app-level ownership check** (`visit.patient_id === session.patient_id`) + `audit()`. They do **not** call `set_patient_context()`. **This feature mirrors that sibling pattern exactly** — so it adds **no new RLS policy** on `appointment_attachments`. A patient-read RLS policy would be dead (admin client bypasses RLS) and inconsistent with the three existing actions. *This is intentional; not a missing-policy oversight.*
- **Patient storage access = 5-minute signed URLs minted by a Server Action that `audit()`s the access.** Never direct bucket access.
- **Manila is fixed UTC+8** (no DST) → a Manila calendar day maps to a UTC window via a `+08:00` literal.
- `appointment_attachments` (migration 0103): `id, booking_group_id (uuid, non-unique, not FK), patient_id (→patients, on delete set null), storage_path, filename, mime_type, size_bytes, kind, created_at`. Bucket `lab-request-forms` (private). Mime allowlist: jpeg/png/webp/heic/heif/pdf. The client compressor (`compress-image.ts`) outputs **JPEG**, so stored images are usually browser-renderable; PDFs and any HEIC are not.

## 3. Feature 1 — Portal view of uploaded request form

### 3.1 Placement
New **"Your uploaded request forms"** section on the portal home (`src/app/(patient)/portal/(authenticated)/page.tsx`), rendered **only when the patient has ≥1 attachment**, placed below the results list and above the "Download a copy of your data" box. Responsive: scrollable table on `sm+`, stacked cards on mobile — matching the existing results list.

### 3.2 Read path (`loadUploads(patientId)`, new function in `page.tsx`)
Admin client, `requirePatientProfile()` already gates the page. Query:
- `appointment_attachments` where `patient_id = patientId`, `order by created_at desc`.
- For appointment context, resolve `appointments` sharing the attachment's `booking_group_id` (join is non-unique → pick a representative: prefer a row with a `service_id`/`scheduled_at`, else the first) to derive a label like *"Lab request · Jun 18, 2026"* or the service name. Context is best-effort; never blocks the row.
- For each image-type attachment (`mime_type ∈ {jpeg,png,webp}`), mint a **5-min signed URL** for an inline thumbnail. PDF/HEIC → no URL; render a type icon. (Thumbnail render is the owner viewing their own page → **no per-render audit**; explicit Download/Remove audit.)

Row fields: `{ id, filename, mime_type, sizeBytes, createdAt, thumbUrl|null, isPdf, contextLabel }`.

### 3.3 Download action — `getPatientLabRequestFormUrl(attachmentId)` (in `(authenticated)/actions.ts`)
Mirrors `getPatientResultDownloadUrl` line-for-line:
1. `getPatientSession()` → 401-ish `{ok:false}` if missing.
2. Admin fetch attachment `id, storage_path, patient_id`.
3. **Ownership check:** `att.patient_id === session.patient_id`, else `{ok:false, error:"File not found."}`.
4. `admin.storage.from("lab-request-forms").createSignedUrl(storage_path, 300)`.
5. `audit({ actor_type:"patient", patient_id, action:"lab_request.viewed", resource_type:"appointment_attachment", resource_id:attachmentId, metadata:{drm_id, storage_path}, ip/ua from headers() })`.
6. Return `{ok:true, url}`.

Wired via a small client component (mirror `download-button.tsx` → `useTransition` + open URL in new tab).

### 3.4 Delete action — `deletePatientLabRequestUpload(attachmentId)` (in `(authenticated)/actions.ts`)
1–3 as above (session + ownership), then:
4. `admin.storage.from("lab-request-forms").remove([storage_path])` (best-effort; proceed even if the object is already gone).
5. `admin.from("appointment_attachments").delete().eq("id", attachmentId)`.
6. `audit({ actor_type:"patient", patient_id, action:"lab_request.deleted", resource_type:"appointment_attachment", resource_id:attachmentId, metadata:{filename, storage_path, booking_group_id} })`.
7. Return `{ok:true}`; client calls `router.refresh()`.

UI: a "Remove" button per row → `window.confirm("Remove this uploaded form? This can't be undone.")` (simple confirm, matching the portal's lightweight client patterns). **Rationale:** the form is a convenience artifact, not an official record (results are immutable + payment-gated; this isn't). The append-only audit preserves that it existed and was removed. No "consumed" guard — there's no such flag, and reception viewing is already audited separately.

### 3.5 Audit action strings (new)
- `lab_request.viewed` (also used by staff today — reused; actor distinguishes).
- `lab_request.deleted` (new).

## 4. Feature 2 — Day-before email reminder

### 4.1 Schema — migration `0104_appointment_reminder_sent.sql`
```sql
alter table public.appointments
  add column if not exists reminder_sent_at timestamptz;

create index if not exists idx_appointments_reminder_due
  on public.appointments (scheduled_at)
  where reminder_sent_at is null;
```
No RLS/audit/payment-gating concerns (nullable column add on an existing table). Then `npm run db:types`. Apply to prod via Supabase MCP per `feedback_remote_db_ops_ipv6` (direct DB host IPv6-unreachable).

### 4.2 Manila window helper — `manilaDayWindowUtc(offsetDays)` (in `src/lib/dates/manila.ts`)
```ts
/** UTC [start, end) ISO instants for the Manila calendar day `offsetDays` from today. */
export function manilaDayWindowUtc(offsetDays: number): { startIso: string; endIso: string } {
  const base = Date.parse(`${todayManilaISODate()}T00:00:00+08:00`); // Manila midnight today → UTC ms
  const start = base + offsetDays * 86_400_000;
  return { startIso: new Date(start).toISOString(), endIso: new Date(start + 86_400_000).toISOString() };
}
```
Cron uses `offsetDays = 1` (tomorrow). DST-free because PH is fixed UTC+8. Pure → unit-tested.

### 4.3 Notifier — `src/lib/notifications/notify-appointment-reminder.ts`
Mirrors `notify-appointment-booked.ts`:
- Input `{ appointmentId, patientId }`. Admin-load appt: `id, scheduled_at, status, booking_group_id, walk_in_name, services(name), patients(first_name, email)`.
- Recipient email = `patients.email`. No email → return `{ emailed:false, reason:"no email" }` (cron still marks `reminder_sent_at` so it isn't re-tried).
- `hasForm` = `count(*) from appointment_attachments where booking_group_id = appt.booking_group_id > 0`.
- Email body via a **pure** `buildReminderEmail({ greeting, serviceName, when, cancelUrl, hasForm })` → `{ subject, text }`:
  - Subject: `Reminder — ${serviceName} tomorrow, ${when}`.
  - Body: greeting · "This is a reminder for your appointment tomorrow." · Service · Date/time · (if `hasForm`) *"📎 We have your doctor's request form on file — no need to bring a printout."* · "Bring a valid ID. For HMO, please bring your card." · cancel/reschedule link (`${SITE.url}/appointments/cancel/${id}`) · sign-off.
- Send **email only** (`sendEmail`). Structured so an SMS mirror is a one-line add later, but not wired now.
- `audit({ actor_type:"system", patient_id, action:"appointment.reminder.sent", resource_type:"appointment", resource_id:appointmentId, metadata:{ email: <result>, has_form } })`.
- **Never throws** (best-effort, like the booked notifier). Returns `{ emailed:boolean, reason?:string }` for the cron summary.

### 4.4 Cron — `src/app/api/cron/appointment-reminders/route.ts`
Mirrors `recurring-bills/route.ts`:
- `export const dynamic = "force-dynamic"`. `GET` only.
- Auth: `Authorization: Bearer ${process.env.CRON_SECRET}` → 401 otherwise.
- `const { startIso, endIso } = manilaDayWindowUtc(1)`.
- Query: `appointments` where `status = 'confirmed'` AND `scheduled_at >= startIso` AND `scheduled_at < endIso` AND `reminder_sent_at is null`. Select `id, patient_id, scheduled_at`.
- Per-row, isolated `try/catch` (one failure doesn't stop the batch):
  - `const r = await notifyAppointmentReminder({ appointmentId, patientId })`.
  - `admin.from("appointments").update({ reminder_sent_at: new Date().toISOString() }).eq("id", id)` — set **after the attempt** (sent or skipped-no-email) so it's processed once; on an exception leave null to allow re-run.
  - Tally `emailed` / `skipped_no_email`.
  - On exception: `reportError(...)` + `audit("appointment.reminder.failed")` + push to `failures` (mirror recurring-bills).
- Return `{ window:{startIso,endIso}, processed, emailed, skipped_no_email, failures }`.

> `pending_callback` appointments have `scheduled_at = null` → never match the window → correctly skipped (no time to remind for).

### 4.5 `vercel.json`
Add a 4th cron:
```json
{ "path": "/api/cron/appointment-reminders", "schedule": "0 10 * * *" }
```
`10:00 UTC = 6 PM Manila` (the day before). (Note: this makes 4 crons — confirm the Vercel plan allows it; the project already runs 3.)

## 5. Rider A — Email-honesty copy fixes (SMS → email)

Five user-facing strings promise SMS we don't send. Each → email-only wording:

| File:line | Current | Fixed |
|---|---|---|
| `portal/(authenticated)/page.tsx:422` | "We'll text and email you" | "We'll email you" |
| `portal/(authenticated)/page.tsx:506` | "We'll text and email you" | "We'll email you" |
| `portal/(authenticated)/help/page.tsx:32` | "text and email you the moment…" | "email you the moment…" |
| `(marketing)/schedule/booking-form.tsx:818` | "you'll receive SMS and email confirmation" | "you'll receive an email confirmation" |
| `(marketing)/home/Faq.tsx:20` | "We text and email you when they're ready" | "We email you when they're ready" |

## 6. Rider B — Upload thumbnails (three surfaces, right mechanism each)

- **Booking success screen** (`SuccessPanel.tsx`): add optional prop `uploadedFiles?: File[]`; `booking-form.tsx` passes `labRequestFiles` (already in state, line 175; SuccessPanel rendered at line 310). SuccessPanel renders image previews via `URL.createObjectURL` (revoked on unmount via `useEffect` cleanup); PDFs → filename chip. **Zero server cost** — files are already in memory.
- **Portal row:** server-minted 5-min signed-URL `<img>` thumbnail for browser-renderable images (see §3.2); PDF/HEIC → type icon.
- **Confirmation email — receipt line, NOT embedded image** (privacy/deliverability judgment call, ratified): in `notify-appointment-booked.ts`, add `booking_group_id` to the appt select, count `appointment_attachments` for it, and if `>0` add a line to both the pending-callback and confirmed bodies: *"📎 We received your doctor's request form (N file(s))."* The form is PHI and email is insecure — the results email already links rather than attaching PHI, so we keep that posture.

## 7. Rider C / D
- **C** = §3.4 (self-delete).
- **D** = the `hasForm` line in §4.3 (reminder "form on file").

## 8. Data-model summary
- One new nullable column + partial index on `appointments` (migration 0104). No other schema change. No new table, no new RLS policy, no bucket change.

## 9. Security & RA 10173
- New patient actions: ownership-checked (`patient_id === session.patient_id`), 5-min signed URLs, audited (`lab_request.viewed` / `lab_request.deleted`).
- Cron: `CRON_SECRET` bearer; notifier best-effort + never throws; every send/skip audited (`appointment.reminder.sent`), failures audited (`appointment.reminder.failed`).
- No `set_patient_context()` — consistent with the three existing patient download actions (documented in §2).
- Emails carry no PHI attachments (receipt line only).

## 10. Testing
- **Unit (vitest, pure only — no `server-only` imports):**
  - `manilaDayWindowUtc` — offset 0/1, month/year boundary, the +08:00 mapping.
  - `buildReminderEmail` — with/without `hasForm`, subject + date/time formatting.
- **Local-stack smoke** (per `feedback_local_ui_smoke_recipe` / `feedback_prod_ui_smoke_recipe`):
  - *Reminders:* seed a `confirmed` appt scheduled tomorrow (Manila) with a patient that has an email → `curl -H "Authorization: Bearer $CRON_SECRET" .../api/cron/appointment-reminders` → assert one `appointment.reminder.sent` audit + `reminder_sent_at` set; re-run → `processed:0` (idempotent).
  - *Portal:* seed an `appointment_attachments` row with a known `patient_id` → load portal home → section renders + thumbnail/icon; call download action → signed URL + `lab_request.viewed` audit; call delete → row gone + object removed + `lab_request.deleted` audit.
- `npm test` + `npm run typecheck` + `npm run build` green before merge.

## 11. Out of scope (genuinely later)
- OCR of the request form → auto-suggest tests (backlog L).
- Admin-side replace/delete + inline thumbnails on the staff Appointments card (backlog S — staff side; this PR is patient-side).
- Booking-funnel analytics (backlog M).
- A portal "appointments / re-book" surface — this PR only adds the uploaded-forms view.

## 12. Build map (file-by-file)
**New**
- `supabase/migrations/0104_appointment_reminder_sent.sql`
- `src/lib/notifications/notify-appointment-reminder.ts` (+ pure `buildReminderEmail`)
- `src/lib/notifications/notify-appointment-reminder.test.ts`
- `src/app/api/cron/appointment-reminders/route.ts`
- portal uploads UI: a `lab-request-uploads.tsx` client component (download + remove buttons) under `(authenticated)/`

**Modified**
- `src/lib/dates/manila.ts` (+ `manilaDayWindowUtc`) + `manila.test.ts`
- `src/app/(patient)/portal/(authenticated)/page.tsx` (loadUploads + section)
- `src/app/(patient)/portal/(authenticated)/actions.ts` (`getPatientLabRequestFormUrl`, `deletePatientLabRequestUpload`)
- `src/lib/notifications/notify-appointment-booked.ts` (receipt line + `booking_group_id` select)
- `src/components/marketing/booking-wizard/SuccessPanel.tsx` (+ `uploadedFiles` previews)
- `src/app/(marketing)/schedule/booking-form.tsx` (pass `labRequestFiles` to SuccessPanel; copy fix line 818)
- `src/app/(patient)/portal/(authenticated)/page.tsx` + `help/page.tsx` + `src/components/marketing/home/Faq.tsx` (copy fixes)
- `vercel.json` (4th cron)
- `src/types/database.ts` (regen after 0104)
