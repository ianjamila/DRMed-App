# Emails-sent log — staff admin view

**Date:** 2026-06-16
**Branch:** `feat/emails-sent-log` (detached off `origin/main` @ `160d6e3`)
**Status:** Design — awaiting final review before plan + build

## Problem

Reception/admin partners want a single place to confirm what transactional
email the system has actually sent to patients — result-ready notifications,
booking confirmations, day-before reminders — and to spot failures or patients
with no email on file. Every send is **already** recorded in `audit_log`; there
is no separate send-tracking table and we are **not** adding one. This is a
read-only, filterable presentation layer over existing audit data, plus tiny
forward-looking metadata additions so future rows are an exact record.

This is **not** a new notification channel and **not** a delivery-confirmation
system. We only know what the email provider (Resend) accepted; there is no
inbox-delivery webhook.

## Source data (confirmed)

`audit_log` (defined in `0001_init.sql`): `id bigserial`, `actor_id uuid`,
`actor_type text` (`staff|patient|system|anonymous`), `patient_id uuid` (FK
patients), `action text`, `resource_type text`, `resource_id uuid`,
`metadata jsonb`, `ip_address inet`, `user_agent text`, `created_at timestamptz`.
Indexed on `action`, `patient_id`, `actor_id`, `created_at desc`.

Email outcome lives in `metadata.email` as a tagged shape written by
`sendEmail` (`src/lib/notifications/email.ts`):

- success: `{ ok: true, id: "<resend_id>" }`
- provider/HTTP error: `{ ok: false, error: "Resend 4xx: ..." }`
- skipped (no address / unconfigured): `{ ok: false, skipped: true, reason: "..." }`

### The email actions in scope

| `action` | Type label | Source file | `patient_id`? | Notes |
|---|---|---|---|---|
| `result.notified` | Result ready | `notify-released.ts:90` | always | `metadata.test_name`, `metadata.visit_id` |
| `appointment.booked.notified` | Booking confirmation | `notify-appointment-booked.ts:139` | when patient (else walk-in) | `metadata.email`, `metadata.sms` |
| `appointment.reminder.sent` | Appointment reminder | `notify-appointment-reminder.ts:68,89` | when patient | success **or** `email.skipped` (no email); `metadata.has_form` |
| `appointment.reminder.failed` | Appointment reminder | `cron/appointment-reminders/route.ts:58` | **added by this work** | cron-level exception; `metadata.error` only |
| `newsletter.campaign.sent` | Newsletter | `admin/newsletter/actions.ts:118` | none | aggregate: `subject`, `attempted`, `delivered`, `failed` |
| `patient.self_registered` | Registration welcome | `register/actions.ts:132` | always | email outcome **captured by this work** |
| `patient.self_register.matched` | Registration (existing) | `register/actions.ts:77` | always | email outcome **captured by this work** |

The `sms` branch of metadata is ignored everywhere — notifications are
email-only by decision, and SMS auto-skips.

## Decisions

- **Approach A — app-normalized, no migration** (chosen over a Postgres view).
  A pure TS function flattens each action's metadata into a normalized
  `EmailLogEntry`. Cheap filters (type, date, patient) and status filters run
  in-DB (status via JSONB operators) so pagination/counts stay correct. Keeps
  all logic in unit-testable TS and matches the project's "pure-logic tests"
  approach with zero schema change. *Fallback:* a `v_emails_sent` view if the
  status-filter JSONB conditions prove unwieldy.
- **Recipient = patient + snapshot-forward.** Show patient name + DRM-ID +
  email now (resolved via `patient_id` join). Additionally store the exact
  recipient address in `metadata.email.to` on **new** sends (JSONB add, no
  migration) so future rows are an exact historical record. Old rows fall back
  to the patient's current email.
- **Success status label = "Sent"** (green), meaning *accepted by the email
  provider*. A tooltip states inbox delivery is not separately confirmed. (Open
  for the reviewer to rename to "Delivered".)
- **Scope = maximal**: all 7 actions above, including newsletter aggregate
  rows, "no email on file" skip rows, and self-registration emails.
- **No migration.** All changes are app code + JSONB metadata additions.

## Architecture

### Normalized entry (pure)

`src/lib/emails-log/types.ts`

```ts
export type EmailStatus = "sent" | "failed" | "no_email" | "bulk";
export type EmailType =
  | "result" | "booking" | "reminder"
  | "newsletter" | "registration_new" | "registration_existing";

export interface EmailLogEntry {
  id: number;                       // audit_log.id
  sentAt: string;                   // created_at ISO
  type: EmailType;
  typeLabel: string;
  status: EmailStatus;
  statusLabel: string;
  patientId: string | null;
  recipientEmail: string | null;    // metadata.email.to ?? patient.email
  resendId: string | null;          // metadata.email.id
  detail: string | null;            // test/service name, subject, or error message
  resourceType: string | null;
  resourceId: string | null;
  // newsletter only:
  bulk?: { attempted: number; delivered: number; failed: number };
}
```

`src/lib/emails-log/parse-row.ts` — `parseEmailLogRow(row, patient?) → EmailLogEntry`.
Pure (no `server-only`, no DB import) so it is unit-testable. Encapsulates the
per-action shape differences: type label, status derivation, detail string,
resend id extraction, newsletter aggregate. Status rules:

- `sent` — `metadata.email.ok === true`
- `no_email` — `metadata.email.skipped === true`
- `failed` — `metadata.email.error` present **or** `action === "appointment.reminder.failed"`
- `bulk` — newsletter (carries `bulk` counts; per-row failed/delivered shown)

### Query layer

`src/lib/emails-log/query.ts` (`server-only`) — `fetchEmailLog(filters) → { entries, total, failures7d }`.

- Base: `audit_log` where `action in (<7 actions>)`, `order created_at desc`,
  `{ count: "exact" }`, `.range(offset, offset + PAGE_SIZE - 1)` (PAGE_SIZE 50).
- Filters (all from `searchParams`, re-queried server-side):
  - **type** → maps to the action(s) for that type.
  - **status** → in-DB JSONB conditions:
    - `sent`: `metadata->email->>ok = 'true'`
    - `no_email`: `metadata->email->>skipped = 'true'`
    - `failed`: `.or("metadata->email->>error.not.is.null,action.eq.appointment.reminder.failed")`
    - When a status filter is applied, newsletter (bulk) rows are excluded
      (no per-recipient status); they appear under status = All or type =
      Newsletter. This rule is documented in the UI.
  - **date** from/to → Manila day window (`+08:00`), `gte`/`lte` on `created_at`
    (reuse the `manilaDateStartUtc`/`EndUtc` helpers pattern from the audit page).
  - **patient** → DRM-ID lookup → filter `patient_id`.
- Patient resolution: one batched lookup of the page's distinct `patient_id`s
  against `patients (id, drm_id, first_name, middle_name, last_name, email)`,
  then `formatPatientName`. Left-style (newsletter/failed rows may have none).
- `failures7d`: a `head: true, count: exact` query of failed actions in the
  last 7 Manila days for the top-of-page banner.
- Client choice: read via `createAdminClient()` (page is already
  `requireAdminStaff`-gated) — consistent admin read, avoids RLS surprises on a
  cross-patient audit view.

### Page

`src/app/(staff)/staff/(dashboard)/admin/emails-sent/page.tsx` — Server Component.

1. `await requireAdminStaff()`.
2. `await searchParams`; parse type/status/from/to/drm/page.
3. `fetchEmailLog(...)`.
4. Render: failures-7d banner (links to `?status=failed`), filter bar, table,
   pagination. Empty state via `EmptyState`. Container via `Panel`.

**Columns:** Sent (Manila date/time) · Type · Recipient (patient name + DRM-ID,
linked to `/staff/patients/[id]`; "All subscribers (N)" for newsletter; walk-in
fallback "—") · Email address · Status (badge) · Details (test/service name,
newsletter subject + counts, or error message; Resend id shown small/monospace
when present) · Resource (link: result→`/staff/visits/[visit_id]`,
appointment→`/staff/appointments`, newsletter→campaign).

**Filter bar** (journal-page pattern, plain GET `<form>`): Type `<select>` ·
Status `<select>` (All / Sent / Failed / No email on file) · Date from/to
(`<input type=date>`) · Patient DRM-ID `<input>` · "Failures only" quick chip
(link to `?status=failed`) · Apply + Clear. `buildHref(overrides)` helper
carries filters across pagination.

**Status badges** (inline Tailwind, audit-page pattern): Sent =
emerald, Failed = red/rose, No email on file = amber, Newsletter = slate with
"N sent · M failed".

### CSV export

`src/app/(staff)/staff/(dashboard)/admin/emails-sent/export/route.ts` — `GET`,
`requireAdminStaff`, same filters (no pagination → full filtered set, capped at
a sane max e.g. 10k rows with a logged note if exceeded). Returns
`text/csv` with `Content-Disposition: attachment`. Columns mirror the table.
Audit-logged as `emails_log.exported` with the filter set in metadata.

### Sidebar nav

`src/components/staff/staff-nav-config.ts` — add a `StaffNavItem` under the
**Admin tools** subgroup, next to "Audit log":

```ts
{ href: "/staff/admin/emails-sent", label: "Emails sent",
  description: "Every transactional email the system sent — result alerts, booking confirmations, reminders. Filter by type, status, date or patient.",
  roles: ["admin"] }
```

### Snapshot-forward + capture edits (no migration)

1. `notify-released.ts` — add `to: patient.email` into the `email` success +
   error metadata branches.
2. `notify-appointment-booked.ts` — add `to: email` into the `email`
   success + error branches.
3. `notify-appointment-reminder.ts` — add `to: email` into the `email`
   success + error branches.
4. `cron/appointment-reminders/route.ts` — add `patient_id: a.patient_id` to the
   `appointment.reminder.failed` audit call (recipient now resolves).
5. `register/actions.ts` — capture the `sendEmail` `SendResult` in **both**
   paths (`res.reused` matched, and new registrant) and add an `email`
   metadata object (`{ ok, id?|error?, to }`) to the existing
   `patient.self_register.matched` / `patient.self_registered` audit rows. No
   behavior change — purely records the outcome already produced.

### Tests

- `src/lib/emails-log/parse-row.test.ts` (vitest, pure): one fixture per action
  shape × status (sent / failed / no-email / newsletter aggregate / cron-failed /
  both self-reg). Assert type, typeLabel, status, recipientEmail fallback,
  resendId, detail.
- `npm run typecheck`, `npm run lint`, full `npm test` green.
- Manual: a build + a quick Playwright smoke of the page against existing prod
  data is out of scope for the plan unless the reviewer wants it (Docker is
  off; prod-smoke recipe exists if needed).

## Compliance (RA 10173)

- Page + export are `requireAdminStaff`-gated; CSV export is itself
  audit-logged (`emails_log.exported`).
- `metadata.email.to` stores a recipient email — contact info the clinic
  already holds and already in `patients`. It is written only for sends the
  clinic itself triggered. Low incremental exposure; admin-only surface.
- No plaintext PINs, no result contents, no service-role exposure to the client.

## Non-goals / out of scope

- A dedicated `emails` table or per-recipient newsletter rows (newsletter stays
  aggregate — that's all the source data has).
- Inbox-delivery confirmation / Resend webhooks.
- Re-send / retry actions from this page (read-only).
- SMS (email-only by decision).
- Backfilling `metadata.email.to` onto historical rows (forward-only).

## Files

**New:** `src/lib/emails-log/{types,parse-row,query}.ts`,
`src/lib/emails-log/parse-row.test.ts`,
`src/app/(staff)/staff/(dashboard)/admin/emails-sent/page.tsx`,
`.../emails-sent/export/route.ts`, plus small filter/table components under
`.../emails-sent/_components/` as needed.

**Edited:** `notify-released.ts`, `notify-appointment-booked.ts`,
`notify-appointment-reminder.ts`, `cron/appointment-reminders/route.ts`,
`register/actions.ts`, `staff-nav-config.ts`.
