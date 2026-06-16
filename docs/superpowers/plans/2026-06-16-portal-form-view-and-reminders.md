# Portal Form-View + Day-Before Email Reminders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let logged-in patients view/download/remove the doctor's-request-form they uploaded at booking, send a day-before email reminder for confirmed appointments, and fold in 5 SMS→email copy fixes + upload thumbnails + a reminder "form on file" line.

**Architecture:** Two pure helpers (Manila day-window, reminder-email builder) are TDD'd with vitest. The reminder runs as a daily Vercel cron (`/api/cron/appointment-reminders`, `CRON_SECRET` bearer) that calls an email-only notifier and stamps a new idempotency column. The portal additions mirror the three existing patient-download actions exactly (admin client + app-level ownership check + `audit()`, **no new RLS policy**). Thumbnails reuse in-memory files on the booking success screen and 5-min signed URLs in the portal.

**Tech Stack:** Next.js 16 (App Router, Server Actions, RSC), Supabase (service-role admin client), `@supabase/ssr`, vitest, Resend (`sendEmail`), Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-06-16-portal-form-view-and-reminders-design.md`

**Branch:** `feat/portal-form-view-and-reminders` (already created off `origin/main`).

---

## File structure

**New files**
- `supabase/migrations/0104_appointment_reminder_sent.sql` — idempotency column + partial index.
- `src/lib/dates/manila.test.ts` — tests for the new window helper.
- `src/lib/notifications/reminder-email.ts` — pure `buildReminderEmail` (no `server-only`).
- `src/lib/notifications/reminder-email.test.ts` — tests for it.
- `src/lib/notifications/notify-appointment-reminder.ts` — server-only notifier.
- `src/app/api/cron/appointment-reminders/route.ts` — daily cron.
- `src/app/(patient)/portal/(authenticated)/lab-request-uploads.tsx` — client list (view + remove).

**Modified files**
- `src/lib/dates/manila.ts` — `+ manilaDayWindowUtc`.
- `src/app/(patient)/portal/(authenticated)/actions.ts` — `+ getPatientLabRequestFormUrl`, `+ deletePatientLabRequestUpload`.
- `src/app/(patient)/portal/(authenticated)/page.tsx` — `loadUploads` + new section.
- `src/lib/notifications/notify-appointment-booked.ts` — receipt line + `booking_group_id`.
- `src/components/marketing/booking-wizard/SuccessPanel.tsx` — `uploadedFiles` previews.
- `src/app/(marketing)/schedule/booking-form.tsx` — pass `labRequestFiles` to SuccessPanel.
- `vercel.json` — 4th cron entry.
- Copy fixes: `portal/(authenticated)/page.tsx`, `portal/(authenticated)/help/page.tsx`, `components/marketing/home/Faq.tsx`, `(marketing)/schedule/booking-form.tsx`.
- `src/types/database.ts` — regenerated after 0104.

---

## Task 1: Manila day-window helper (pure, TDD)

**Files:**
- Modify: `src/lib/dates/manila.ts`
- Test: `src/lib/dates/manila.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/dates/manila.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { manilaDayWindowUtc } from "./manila";

describe("manilaDayWindowUtc", () => {
  afterEach(() => vi.useRealTimers());

  it("maps tomorrow's Manila day to a fixed +08:00 UTC window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T09:00:00Z")); // 17:00 Manila on 06-16
    const { startIso, endIso } = manilaDayWindowUtc(1);
    // Manila 2026-06-17 00:00 = UTC 2026-06-16 16:00; +24h = 2026-06-17 16:00.
    expect(startIso).toBe("2026-06-16T16:00:00.000Z");
    expect(endIso).toBe("2026-06-17T16:00:00.000Z");
  });

  it("offset 0 is today's Manila day and the window is exactly 24h", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T09:00:00Z"));
    const { startIso, endIso } = manilaDayWindowUtc(0);
    expect(startIso).toBe("2026-06-15T16:00:00.000Z");
    expect(new Date(endIso).getTime() - new Date(startIso).getTime()).toBe(86_400_000);
  });

  it("crosses a month boundary correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T15:00:00Z")); // 23:00 Manila on 06-30
    const { startIso } = manilaDayWindowUtc(1); // tomorrow Manila = 2026-07-01
    expect(startIso).toBe("2026-06-30T16:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/dates/manila.test.ts`
Expected: FAIL — `manilaDayWindowUtc is not a function` / not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/lib/dates/manila.ts` (after `isOnOrBeforeTodayManila`):

```ts
/**
 * UTC [start, end) ISO instants for the Manila calendar day `offsetDays` from
 * today. PH is a fixed UTC+8 (no DST), so a Manila midnight maps via a literal
 * +08:00 offset. Used by the day-before reminder cron (offsetDays = 1).
 */
export function manilaDayWindowUtc(offsetDays: number): {
  startIso: string;
  endIso: string;
} {
  const base = Date.parse(`${todayManilaISODate()}T00:00:00+08:00`);
  const start = base + offsetDays * 86_400_000;
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(start + 86_400_000).toISOString(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/dates/manila.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/dates/manila.ts src/lib/dates/manila.test.ts
git commit -m "feat(dates): manilaDayWindowUtc helper for the reminder cron"
```

---

## Task 2: Reminder-email builder (pure, TDD)

**Files:**
- Create: `src/lib/notifications/reminder-email.ts`
- Test: `src/lib/notifications/reminder-email.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/notifications/reminder-email.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildReminderEmail } from "./reminder-email";

const base = {
  greeting: "Maria",
  serviceName: "Complete Blood Count",
  when: "June 18, 2026 at 9:00 AM",
  cancelUrl: "https://drmed.ph/appointments/cancel/abc",
  hasForm: false,
};

describe("buildReminderEmail", () => {
  it("subject names the service and time", () => {
    expect(buildReminderEmail(base).subject).toBe(
      "Reminder — Complete Blood Count tomorrow, June 18, 2026 at 9:00 AM",
    );
  });

  it("omits the form line when hasForm is false but keeps greeting + cancel link", () => {
    const { text } = buildReminderEmail(base);
    expect(text).not.toContain("request form on file");
    expect(text).toContain("Maria");
    expect(text).toContain("https://drmed.ph/appointments/cancel/abc");
  });

  it("includes the form-on-file line when hasForm is true", () => {
    expect(buildReminderEmail({ ...base, hasForm: true }).text).toContain(
      "request form on file",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/notifications/reminder-email.test.ts`
Expected: FAIL — cannot find module `./reminder-email`.

- [ ] **Step 3: Implement the builder**

Create `src/lib/notifications/reminder-email.ts`:

```ts
// Pure builder for the day-before appointment reminder email. No `server-only`
// import so it can be unit-tested. The notifier resolves the fields and sends.

export interface ReminderEmailInput {
  greeting: string;
  serviceName: string;
  /** Pre-formatted Manila date/time, e.g. "June 18, 2026 at 9:00 AM". */
  when: string;
  cancelUrl: string;
  hasForm: boolean;
}

export function buildReminderEmail(input: ReminderEmailInput): {
  subject: string;
  text: string;
} {
  const { greeting, serviceName, when, cancelUrl, hasForm } = input;
  const subject = `Reminder — ${serviceName} tomorrow, ${when}`;
  const lines = [
    `Hi ${greeting},`,
    "",
    `This is a friendly reminder for your appointment tomorrow with DRMed Clinic and Laboratory.`,
    "",
    `Service: ${serviceName}`,
    `Date / time: ${when}`,
  ];
  if (hasForm) {
    lines.push(
      "",
      `We have your doctor's request form on file — no need to bring a printout.`,
    );
  }
  lines.push(
    "",
    `Need to cancel or reschedule? Open this link:`,
    `  ${cancelUrl}`,
    "",
    `Bring a valid ID. For HMO, please bring your card.`,
    "",
    "— DRMed Clinic and Laboratory",
  );
  return { subject, text: lines.join("\n") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/notifications/reminder-email.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/reminder-email.ts src/lib/notifications/reminder-email.test.ts
git commit -m "feat(notifications): pure buildReminderEmail"
```

---

## Task 3: Migration 0104 + regenerate types

**Files:**
- Create: `supabase/migrations/0104_appointment_reminder_sent.sql`
- Modify (generated): `src/types/database.ts`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0104_appointment_reminder_sent.sql`:

```sql
-- =============================================================================
-- 0104_appointment_reminder_sent.sql
-- =============================================================================
-- Idempotency stamp for the day-before reminder cron
-- (/api/cron/appointment-reminders). NULL = not yet reminded; the cron sets it
-- to now() after processing an appointment (sent OR skipped-no-email) so each
-- appointment is reminded at most once. The partial index keeps the daily
-- "due" scan cheap.
-- =============================================================================

alter table public.appointments
  add column if not exists reminder_sent_at timestamptz;

create index if not exists idx_appointments_reminder_due
  on public.appointments (scheduled_at)
  where reminder_sent_at is null;
```

- [ ] **Step 2: Apply to the local stack**

The Supabase CLI trips on `.env.local`, so use the wrapper (see `feedback_local_supabase_docker_workflow`). Run:

```bash
scripts/supabase-local.sh start
scripts/supabase-local.sh db reset
```

Expected: reset completes, applying all migrations through `0104` with no error.

- [ ] **Step 3: Regenerate types (through the wrapper)**

`npm run db:types` calls `supabase gen types …` directly and would trip on `.env.local`; run it through the wrapper instead:

```bash
scripts/supabase-local.sh gen types typescript --local > src/types/database.ts
```

- [ ] **Step 4: Verify the column is in the generated types**

Run: `grep -n "reminder_sent_at" src/types/database.ts`
Expected: appears under the `appointments` `Row`/`Insert`/`Update`.

- [ ] **Step 5: Stop the local stack (Docker overheats if left on)**

```bash
scripts/supabase-local.sh stop
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0104_appointment_reminder_sent.sql src/types/database.ts
git commit -m "feat(db): 0104 appointments.reminder_sent_at + due index"
```

---

## Task 4: Reminder notifier (server-only)

**Files:**
- Create: `src/lib/notifications/notify-appointment-reminder.ts`

(No unit test — imports `server-only` + admin client; covered by the smoke in Task 12.)

- [ ] **Step 1: Implement the notifier**

Create `src/lib/notifications/notify-appointment-reminder.ts`:

```ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { SITE } from "@/lib/marketing/site";
import { sendEmail } from "./email";
import { buildReminderEmail } from "./reminder-email";

interface Input {
  appointmentId: string;
  patientId: string | null;
}

export interface ReminderResult {
  emailed: boolean;
  reason?: string;
}

// Sends the day-before reminder. Email-only (per the email-only notifications
// decision). Failures are audit-logged but never thrown — the appointment row
// is the source of truth, not delivery.
export async function notifyAppointmentReminder({
  appointmentId,
  patientId,
}: Input): Promise<ReminderResult> {
  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select(
      `
        id, scheduled_at, status, booking_group_id, walk_in_name,
        services ( name ),
        patients ( first_name, email )
      `,
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (!appt) return { emailed: false, reason: "appointment not found" };

  const svc = Array.isArray(appt.services) ? appt.services[0] : appt.services;
  const patient = Array.isArray(appt.patients)
    ? appt.patients[0]
    : appt.patients;

  const greeting = patient?.first_name ?? appt.walk_in_name ?? "there";
  const email = patient?.email ?? null;
  const serviceName = svc?.name ?? "your appointment";
  const when = appt.scheduled_at
    ? new Date(appt.scheduled_at).toLocaleString("en-PH", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "Asia/Manila",
      })
    : "your scheduled time";
  const cancelUrl = `${SITE.url.replace(/\/$/, "")}/appointments/cancel/${appt.id}`;

  // Does this booking group carry an uploaded request form?
  let hasForm = false;
  if (appt.booking_group_id) {
    const { count } = await admin
      .from("appointment_attachments")
      .select("id", { count: "exact", head: true })
      .eq("booking_group_id", appt.booking_group_id);
    hasForm = (count ?? 0) > 0;
  }

  if (!email) {
    await audit({
      actor_id: null,
      actor_type: "system",
      patient_id: patientId,
      action: "appointment.reminder.sent",
      resource_type: "appointment",
      resource_id: appointmentId,
      metadata: { email: { ok: false, skipped: true, reason: "no email" }, has_form: hasForm },
    });
    return { emailed: false, reason: "no email" };
  }

  const { subject, text } = buildReminderEmail({
    greeting,
    serviceName,
    when,
    cancelUrl,
    hasForm,
  });
  const emailResult = await sendEmail({ to: email, subject, text });

  await audit({
    actor_id: null,
    actor_type: "system",
    patient_id: patientId,
    action: "appointment.reminder.sent",
    resource_type: "appointment",
    resource_id: appointmentId,
    metadata: {
      email: emailResult.ok
        ? { ok: true, id: emailResult.id }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error },
      has_form: hasForm,
    },
  });

  return { emailed: emailResult.ok, reason: emailResult.ok ? undefined : "send failed" };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors). If `sendEmail`'s result union differs, mirror exactly how `notify-appointment-booked.ts` narrows `emailResult` (`.ok` / `.kind === "skipped"` / `.error`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/notifications/notify-appointment-reminder.ts
git commit -m "feat(notifications): day-before reminder notifier (email-only)"
```

---

## Task 5: Reminder cron route

**Files:**
- Create: `src/app/api/cron/appointment-reminders/route.ts`

- [ ] **Step 1: Implement the route**

Create `src/app/api/cron/appointment-reminders/route.ts`:

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import { manilaDayWindowUtc } from "@/lib/dates/manila";
import { notifyAppointmentReminder } from "@/lib/notifications/notify-appointment-reminder";

export const dynamic = "force-dynamic";

// Vercel Cron sends GET by default. Reminds patients the evening before a
// confirmed appointment (cron scheduled at 10:00 UTC = 6 PM Manila).
export async function GET(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { startIso, endIso } = manilaDayWindowUtc(1); // tomorrow, Manila
  const admin = createAdminClient();

  const { data: due, error } = await admin
    .from("appointments")
    .select("id, patient_id")
    .eq("status", "confirmed")
    .gte("scheduled_at", startIso)
    .lt("scheduled_at", endIso)
    .is("reminder_sent_at", null);

  if (error) {
    await reportError({ scope: "cron/appointment-reminders:query", error });
    return Response.json({ error: "query failed" }, { status: 500 });
  }

  let emailed = 0;
  let skippedNoEmail = 0;
  const failures: Array<{ appointment_id: string; error: string }> = [];

  for (const a of due ?? []) {
    try {
      const r = await notifyAppointmentReminder({
        appointmentId: a.id,
        patientId: a.patient_id,
      });
      if (r.emailed) emailed += 1;
      else skippedNoEmail += 1;

      // Stamp so this appointment is processed once (sent or skipped-no-email).
      await admin
        .from("appointments")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", a.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reportError({
        scope: "cron/appointment-reminders:appointment",
        error: err,
        metadata: { appointment_id: a.id },
      });
      await audit({
        actor_id: null,
        actor_type: "system",
        action: "appointment.reminder.failed",
        resource_type: "appointment",
        resource_id: a.id,
        metadata: { error: msg },
      });
      // Leave reminder_sent_at NULL so a re-run can retry.
      failures.push({ appointment_id: a.id, error: msg });
    }
  }

  return Response.json({
    window: { startIso, endIso },
    processed: due?.length ?? 0,
    emailed,
    skipped_no_email: skippedNoEmail,
    failures,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (Confirms `reminder_sent_at` is in the generated types from Task 3 and `reportError`'s signature matches — mirror `recurring-bills/route.ts` if the `metadata` arg differs.)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cron/appointment-reminders/route.ts
git commit -m "feat(cron): day-before appointment reminder route"
```

---

## Task 6: Register the cron in vercel.json

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Add the 4th cron entry**

In `vercel.json`, change the `crons` array to add the new entry (keep the existing three):

```json
  "crons": [
    {
      "path": "/api/cron/sync-accounting",
      "schedule": "0 9 * * *"
    },
    {
      "path": "/api/cron/data-retention",
      "schedule": "30 17 * * *"
    },
    {
      "path": "/api/cron/recurring-bills",
      "schedule": "0 18 * * *"
    },
    {
      "path": "/api/cron/appointment-reminders",
      "schedule": "0 10 * * *"
    }
  ]
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "chore(cron): schedule appointment-reminders at 6 PM Manila"
```

---

## Task 7: Patient form-download + delete actions

**Files:**
- Modify: `src/app/(patient)/portal/(authenticated)/actions.ts`

(`actions.ts` already imports `headers`, `createAdminClient`, `audit`, `getPatientSession` — no new imports needed.)

- [ ] **Step 1: Append the two actions**

Add to the end of `src/app/(patient)/portal/(authenticated)/actions.ts`:

```ts
const LAB_REQUEST_BUCKET = "lab-request-forms";

export type FormUrlResult = { ok: true; url: string } | { ok: false; error: string };
export type FormDeleteResult = { ok: true } | { ok: false; error: string };

// 5-minute signed URL for one of the patient's own uploaded request forms.
// Mirrors getPatientResultDownloadUrl: admin client + app-level ownership
// check + audit. (No RLS policy on appointment_attachments for patients —
// consistent with the other three patient-download actions.)
export async function getPatientLabRequestFormUrl(
  attachmentId: string,
): Promise<FormUrlResult> {
  const session = await getPatientSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const admin = createAdminClient();
  const { data: att } = await admin
    .from("appointment_attachments")
    .select("id, storage_path, patient_id")
    .eq("id", attachmentId)
    .maybeSingle();

  if (!att || att.patient_id !== session.patient_id) {
    return { ok: false, error: "File not found." };
  }

  const { data: signed, error } = await admin.storage
    .from(LAB_REQUEST_BUCKET)
    .createSignedUrl(att.storage_path, 60 * 5);
  if (error || !signed?.signedUrl) {
    return { ok: false, error: "Could not open the file." };
  }

  const h = await headers();
  await audit({
    actor_id: null,
    actor_type: "patient",
    patient_id: session.patient_id,
    action: "lab_request.viewed",
    resource_type: "appointment_attachment",
    resource_id: attachmentId,
    metadata: { drm_id: session.drm_id, storage_path: att.storage_path },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  return { ok: true, url: signed.signedUrl };
}

// Removes one of the patient's own uploaded request forms (file + row).
// The form is a convenience artifact, not an official record; the append-only
// audit preserves that it existed and was removed.
export async function deletePatientLabRequestUpload(
  attachmentId: string,
): Promise<FormDeleteResult> {
  const session = await getPatientSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };

  const admin = createAdminClient();
  const { data: att } = await admin
    .from("appointment_attachments")
    .select("id, storage_path, patient_id, filename, booking_group_id")
    .eq("id", attachmentId)
    .maybeSingle();

  if (!att || att.patient_id !== session.patient_id) {
    return { ok: false, error: "File not found." };
  }

  // Best-effort object removal; proceed to delete the row regardless.
  await admin.storage.from(LAB_REQUEST_BUCKET).remove([att.storage_path]);

  const { error: delErr } = await admin
    .from("appointment_attachments")
    .delete()
    .eq("id", attachmentId);
  if (delErr) return { ok: false, error: "Could not remove the file." };

  const h = await headers();
  await audit({
    actor_id: null,
    actor_type: "patient",
    patient_id: session.patient_id,
    action: "lab_request.deleted",
    resource_type: "appointment_attachment",
    resource_id: attachmentId,
    metadata: {
      drm_id: session.drm_id,
      filename: att.filename,
      storage_path: att.storage_path,
      booking_group_id: att.booking_group_id,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(patient)/portal/(authenticated)/actions.ts"
git commit -m "feat(portal): patient view + delete actions for uploaded request forms"
```

---

## Task 8: Portal uploads section + client component

**Files:**
- Create: `src/app/(patient)/portal/(authenticated)/lab-request-uploads.tsx`
- Modify: `src/app/(patient)/portal/(authenticated)/page.tsx`

- [ ] **Step 1: Create the client component**

Create `src/app/(patient)/portal/(authenticated)/lab-request-uploads.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  getPatientLabRequestFormUrl,
  deletePatientLabRequestUpload,
} from "./actions";

export interface UploadRow {
  id: string;
  filename: string;
  isPdf: boolean;
  thumbUrl: string | null;
  contextLabel: string | null;
  createdAt: string;
}

export function LabRequestUploads({ rows }: { rows: UploadRow[] }) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();

  function openFile(id: string) {
    start(async () => {
      setError(null);
      setPendingId(id);
      const r = await getPatientLabRequestFormUrl(id);
      setPendingId(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      window.open(r.url, "_blank", "noopener,noreferrer");
    });
  }

  function removeFile(id: string) {
    if (!window.confirm("Remove this uploaded form? This can't be undone.")) return;
    start(async () => {
      setError(null);
      setPendingId(id);
      const r = await deletePatientLabRequestUpload(id);
      setPendingId(null);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <ul className="mt-3 space-y-3">
        {rows.map((row) => {
          const busy = pendingId === row.id;
          return (
            <li
              key={row.id}
              className="flex items-center gap-3 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-3"
            >
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[color:var(--color-brand-bg)]">
                {row.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.thumbUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-2xl" aria-hidden="true">
                    {row.isPdf ? "📄" : "🖼️"}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-[color:var(--color-brand-navy)]">
                  {row.contextLabel ?? "Doctor's request form"}
                </p>
                <p className="truncate text-xs text-[color:var(--color-brand-text-soft)]">
                  {row.filename} · uploaded{" "}
                  {new Date(row.createdAt).toLocaleDateString("en-PH", {
                    timeZone: "Asia/Manila",
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  className="min-h-[44px] bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
                  onClick={() => openFile(row.id)}
                >
                  {busy ? "Opening…" : "View"}
                </Button>
                <button
                  type="button"
                  disabled={busy}
                  className="min-h-[44px] rounded-md px-2 text-xs font-semibold text-red-600 hover:underline disabled:opacity-50"
                  onClick={() => removeFile(row.id)}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="mt-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
```

- [ ] **Step 2: Add `loadUploads` to the page**

In `src/app/(patient)/portal/(authenticated)/page.tsx`, add the import near the other local imports (e.g. below the `PackageCard` import):

```tsx
import { LabRequestUploads, type UploadRow } from "./lab-request-uploads";
```

Then add this function above `export default async function PatientPortalPage()`:

```tsx
async function loadUploads(patientId: string): Promise<UploadRow[]> {
  const admin = createAdminClient();
  const { data: atts } = await admin
    .from("appointment_attachments")
    .select("id, booking_group_id, filename, mime_type, size_bytes, created_at, storage_path")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false });

  if (!atts || atts.length === 0) return [];

  // Representative appointment per booking_group_id, for a context label.
  const groupIds = [...new Set(atts.map((a) => a.booking_group_id))];
  const { data: appts } = await admin
    .from("appointments")
    .select("booking_group_id, scheduled_at, services ( name )")
    .in("booking_group_id", groupIds);

  const contextByGroup = new Map<string, string>();
  for (const ap of appts ?? []) {
    if (!ap.booking_group_id) continue;
    const svc = Array.isArray(ap.services) ? ap.services[0] : ap.services;
    const name = svc?.name ?? "Lab request";
    const when = ap.scheduled_at
      ? new Date(ap.scheduled_at).toLocaleDateString("en-PH", {
          timeZone: "Asia/Manila",
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;
    const label = when ? `${name} · ${when}` : name;
    // Prefer a row that carries a scheduled time over a barer one.
    if (!contextByGroup.has(ap.booking_group_id) || when) {
      contextByGroup.set(ap.booking_group_id, label);
    }
  }

  const IMG = new Set(["image/jpeg", "image/png", "image/webp"]);
  const rows: UploadRow[] = [];
  for (const a of atts) {
    let thumbUrl: string | null = null;
    if (IMG.has(a.mime_type)) {
      const { data: signed } = await admin.storage
        .from("lab-request-forms")
        .createSignedUrl(a.storage_path, 60 * 5);
      thumbUrl = signed?.signedUrl ?? null;
    }
    rows.push({
      id: a.id,
      filename: a.filename,
      isPdf: a.mime_type === "application/pdf",
      thumbUrl,
      contextLabel: contextByGroup.get(a.booking_group_id) ?? null,
      createdAt: a.created_at,
    });
  }
  return rows;
}
```

- [ ] **Step 3: Call `loadUploads` + render the section**

In `PatientPortalPage()`, after the existing `loadResults` call, add:

```tsx
  const uploads = await loadUploads(patient.patient_id);
```

Then, immediately **before** the `<section>` that contains the `<h2>Download a copy of your data</h2>` heading, insert:

```tsx
      {uploads.length > 0 ? (
        <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            Your uploaded request forms
          </h2>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            The doctor&apos;s request form(s) you attached when booking. Tap View
            for a 5-minute secure link.
          </p>
          <LabRequestUploads rows={uploads} />
        </section>
      ) : null}
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run lint`
Expected: PASS. (If lint flags the `<img>`, the `eslint-disable-next-line @next/next/no-img-element` comment in the component covers it.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(patient)/portal/(authenticated)/lab-request-uploads.tsx" "src/app/(patient)/portal/(authenticated)/page.tsx"
git commit -m "feat(portal): uploaded request forms section (view/remove + thumbnails)"
```

---

## Task 9: Confirmation-email receipt line

**Files:**
- Modify: `src/lib/notifications/notify-appointment-booked.ts`

- [ ] **Step 1: Add `booking_group_id` to the appointment select**

In the `admin.from("appointments").select(...)` call, change the first select line so it includes `booking_group_id`:

Old:
```ts
        id, scheduled_at, status, walk_in_name, walk_in_phone,
```
New:
```ts
        id, scheduled_at, status, walk_in_name, walk_in_phone, booking_group_id,
```

- [ ] **Step 2: Count attachments + build the receipt note**

Immediately after the `const cancelUrl = ...` line (before `const isPendingCallback = ...`), insert:

```ts
  // Receipt note if the booking carried an uploaded doctor's request form.
  let formCount = 0;
  if (appt.booking_group_id) {
    const { count } = await admin
      .from("appointment_attachments")
      .select("id", { count: "exact", head: true })
      .eq("booking_group_id", appt.booking_group_id);
    formCount = count ?? 0;
  }
  const formNote =
    formCount > 0
      ? [
          "",
          `We received your doctor's request form (${formCount} file${formCount === 1 ? "" : "s"}).`,
        ]
      : [];
```

- [ ] **Step 3: Spread the note into both email bodies**

In the `if (isPendingCallback)` branch, change the `emailText` array so `...formNote` is spread in right after the `Status:` line. Old:

```ts
      `Status: Reception will call within one working day to confirm a date and time.`,
      "",
      `Need to cancel? Open this link:`,
```
New:
```ts
      `Status: Reception will call within one working day to confirm a date and time.`,
      ...formNote,
      "",
      `Need to cancel? Open this link:`,
```

In the `else` branch, change the `emailText` array so `...formNote` is spread in right after the `Date / time:` line. Old:

```ts
      `Date / time: ${when}`,
      "",
      `Need to cancel or reschedule? Open this link:`,
```
New:
```ts
      `Date / time: ${when}`,
      ...formNote,
      "",
      `Need to cancel or reschedule? Open this link:`,
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/notify-appointment-booked.ts
git commit -m "feat(notifications): confirm received request form in booking email"
```

---

## Task 10: Booking-success thumbnails

**Files:**
- Modify: `src/components/marketing/booking-wizard/SuccessPanel.tsx`
- Modify: `src/app/(marketing)/schedule/booking-form.tsx`

- [ ] **Step 1: Accept + preview uploaded files in SuccessPanel**

In `src/components/marketing/booking-wizard/SuccessPanel.tsx`:

(a) Add `uploadedFiles` to the props type:

Old:
```tsx
  pendingCallback,
  isPortalContext,
}: {
  drmId: string;
  serviceSummary: string;
  scheduledAt: string | null;
  pendingCallback: boolean;
  isPortalContext: boolean;
}) {
```
New:
```tsx
  pendingCallback,
  isPortalContext,
  uploadedFiles,
}: {
  drmId: string;
  serviceSummary: string;
  scheduledAt: string | null;
  pendingCallback: boolean;
  isPortalContext: boolean;
  uploadedFiles?: File[];
}) {
```

(b) Add preview state below the existing `const [go, setGo] = useState(false);`:

```tsx
  const [previews, setPreviews] = useState<
    { url: string; name: string; isImage: boolean }[]
  >([]);
  useEffect(() => {
    if (!uploadedFiles || uploadedFiles.length === 0) {
      setPreviews([]);
      return;
    }
    const made = uploadedFiles.map((f) => {
      const isImage = f.type.startsWith("image/");
      return { url: isImage ? URL.createObjectURL(f) : "", name: f.name, isImage };
    });
    setPreviews(made);
    return () => {
      made.forEach((p) => {
        if (p.url) URL.revokeObjectURL(p.url);
      });
    };
  }, [uploadedFiles]);
```

(c) Render the thumbnails. Immediately after the `serviceSummary` paragraph (the `<p>` that closes with `{whenLabel ? ` · ${whenLabel}` : ""}</p>`), insert:

```tsx
      {previews.length > 0 ? (
        <div className="mx-auto mt-4 max-w-[460px]">
          <p className="text-xs text-[color:var(--color-ink-soft)]">
            Your request form was received:
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {previews.map((p, i) => (
              <div
                key={i}
                className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border border-[color:var(--color-warm-line-soft)] bg-white"
              >
                {p.isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-xl" aria-hidden="true">
                    📄
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}
```

- [ ] **Step 2: Pass the files from the booking form**

In `src/app/(marketing)/schedule/booking-form.tsx`, find the `<SuccessPanel` usage (~line 310) and add the prop:

```tsx
        uploadedFiles={labRequestFiles}
```
(Place it among the other `SuccessPanel` props.)

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS. (`SuccessPanel` already imports `useState`; confirm `useEffect` is in its `import { ... } from "react"` line — it is.)

- [ ] **Step 4: Commit**

```bash
git add src/components/marketing/booking-wizard/SuccessPanel.tsx "src/app/(marketing)/schedule/booking-form.tsx"
git commit -m "feat(booking): thumbnail previews of the uploaded request form on the success screen"
```

---

## Task 11: SMS → email copy fixes (5 spots)

**Files:**
- Modify: `src/app/(patient)/portal/(authenticated)/page.tsx`
- Modify: `src/app/(patient)/portal/(authenticated)/help/page.tsx`
- Modify: `src/components/marketing/home/Faq.tsx`
- Modify: `src/app/(marketing)/schedule/booking-form.tsx`

- [ ] **Step 1: Portal home empty-states (two occurrences)**

In `src/app/(patient)/portal/(authenticated)/page.tsx`, replace **all** occurrences of the substring:
`text and email you`
with:
`email you`

(There are two — both in the "No released results yet. We'll text and email you when they're ready." empty-states. Use a replace-all so both change.)

- [ ] **Step 2: Portal help page**

In `src/app/(patient)/portal/(authenticated)/help/page.tsx`, replace:
`text and email you the moment`
with:
`email you the moment`

- [ ] **Step 3: Home FAQ**

In `src/components/marketing/home/Faq.tsx`, replace:
`We text and email you when they're ready`
with:
`We email you when they're ready`

(Note: the apostrophe in `they're` is a literal `'` in this string — match it exactly.)

- [ ] **Step 4: Booking form footer**

In `src/app/(marketing)/schedule/booking-form.tsx`, replace:
`you'll receive SMS and email confirmation`
with:
`you'll receive an email confirmation`

- [ ] **Step 5: Verify no SMS-promise copy remains**

Run: `grep -rni "text and email\|sms and email\|we text and email" src`
Expected: no matches.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add "src/app/(patient)/portal/(authenticated)/page.tsx" "src/app/(patient)/portal/(authenticated)/help/page.tsx" src/components/marketing/home/Faq.tsx "src/app/(marketing)/schedule/booking-form.tsx"
git commit -m "fix(copy): email-only wording — drop SMS/text promises"
```

---

## Task 12: Full verification + smoke + remote-apply note

**Files:** none (verification only)

- [ ] **Step 1: Unit tests + typecheck + lint + build**

Run:
```bash
npm test
npm run typecheck
npm run lint
npm run build
```
Expected: all green. (Existing suite + the two new test files all pass.)

- [ ] **Step 2: Local-stack smoke — reminders**

Bring up the local stack and seed one confirmed appointment for tomorrow (Manila) with an email, then hit the cron:

```bash
scripts/supabase-local.sh start
# In another shell, run the dev server against the local stack per
# feedback_local_ui_smoke_recipe (temp .env.development.local override),
# then seed an appointment + patient with an email scheduled for tomorrow
# (Manila) and status='confirmed', and:
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/appointment-reminders | tee /tmp/rem.json
```
Expected: JSON shows `processed >= 1`, `emailed` or `skipped_no_email` accounts for it. Assert in the DB: an `audit_log` row `appointment.reminder.sent` for that appointment AND its `reminder_sent_at` is set. Re-run the curl → `processed: 0` (idempotent).

- [ ] **Step 3: Local-stack smoke — portal uploads**

Seed an `appointment_attachments` row (an image in the `lab-request-forms` bucket + a row with a known `patient_id`, `booking_group_id`, `mime_type='image/jpeg'`). Sign into that patient's portal (DRM-ID + a fresh PIN per the smoke recipe). Verify:
- The "Your uploaded request forms" section renders with a thumbnail.
- "View" opens a signed URL and writes an `audit_log` `lab_request.viewed` row.
- "Remove" deletes the row + storage object and writes an `audit_log` `lab_request.deleted` row; the section disappears.

```bash
scripts/supabase-local.sh stop
```

- [ ] **Step 4: Push the branch + open the PR**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git push -u origin feat/portal-form-view-and-reminders
gh pr create --fill --base main
```

- [ ] **Step 5: Apply migration 0104 to prod (post-merge / pre-deploy)**

Direct DB is IPv6-unreachable here (`feedback_remote_db_ops_ipv6`). Apply `0104` to prod via the Supabase MCP (`apply_migration` or `execute_sql` for the two statements) and record the `0104` row in `schema_migrations`. Confirm `CRON_SECRET` is set on the Vercel project (it already is — the existing 3 crons use it) and that the Vercel plan permits a 4th cron.

---

## Self-review notes (author)

- **Spec coverage:** §3 portal view → Tasks 7–8; §3.4 delete → Task 7; §4 reminders → Tasks 1–6; §5 copy → Task 11; §6 thumbnails → Tasks 8 (portal), 9 (email receipt line), 10 (success screen); §10 testing → Tasks 1–2 (unit) + 12 (smoke). All covered.
- **No new RLS policy** is intentional (mirrors the three existing patient-download actions) — called out in Task 7's comment.
- **Type consistency:** `UploadRow` is defined once in `lab-request-uploads.tsx` and imported by `page.tsx`; `ReminderResult.emailed` is the field the cron reads; `buildReminderEmail` input/return shape matches both the test and the notifier.
- **Ordering:** migration + types (Task 3) precede the cron (Task 5) that references `reminder_sent_at`.
