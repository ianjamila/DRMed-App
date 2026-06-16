# Emails-sent Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, filterable admin page at `/staff/admin/emails-sent` that surfaces every transactional email the system sent, reconstructed from existing `audit_log` rows.

**Architecture:** A pure TS normalizer flattens each email-related `audit_log` action's `metadata` into an `EmailLogEntry`. A `server-only` query layer filters/paginates in-DB (status via JSONB operators) and batch-resolves patients. A Server Component renders filters + table + pagination; a sibling Route Handler streams CSV. Three notifiers + the self-registration action + the reminder-cron are edited to snapshot the recipient address / capture the send outcome going forward. **No DB migration** — `metadata` is JSONB.

**Tech Stack:** Next.js 16 App Router (Server Components, Route Handlers), Supabase (`createAdminClient`), Tailwind (brand CSS vars), vitest (pure-logic tests).

**Spec:** `docs/superpowers/specs/2026-06-16-emails-sent-log-design.md`

**Branch:** `feat/emails-sent-log` (already created off `origin/main` @ `160d6e3`).

**Confirmed facts (do not re-derive):**
- `audit_log` cols: `id bigserial`, `actor_id uuid`, `actor_type text`, `patient_id uuid`, `action text`, `resource_type text`, `resource_id uuid`, `metadata jsonb`, `ip_address inet`, `user_agent text`, `created_at timestamptz`.
- `metadata.email` shape: `{ok:true,id}` | `{ok:false,error}` | `{ok:false,skipped:true,reason}`. After this work it also carries `to` (recipient address) on success/error.
- `formatPatientName({first_name,middle_name,last_name})` is pure (`src/lib/patients/format-name.ts`) → `"Last, First Middle"`.
- `requireAdminStaff()` (`src/lib/auth/require-admin.ts`) returns `StaffSession` with `.user_id` and `.email` (NOT `.id`).
- `ipAndAgent()` (`src/lib/server/action-helpers.ts`) → `{ ip, ua }`.
- `audit(entry)` (`src/lib/audit/log.ts`) — fire-and-forget; pass `{actor_id, actor_type, patient_id?, action, resource_type?, resource_id?, metadata?, ip_address?, user_agent?}`.
- Drill-down routes exist: `/staff/visits/[id]`, `/staff/patients/[id]`, `/staff/appointments`, `/staff/admin/newsletter`.
- The seven email actions and their metadata are documented in the spec table.

---

## File Structure

**New:**
- `src/lib/emails-log/types.ts` — shared types + the `EMAIL_ACTIONS` constant.
- `src/lib/emails-log/parse-row.ts` — pure `parseEmailLogRow(row, patient?)`.
- `src/lib/emails-log/parse-row.test.ts` — vitest unit tests.
- `src/lib/emails-log/csv.ts` — pure `emailLogToCsv(entries)`.
- `src/lib/emails-log/csv.test.ts` — vitest unit tests.
- `src/lib/emails-log/query.ts` — `server-only` `fetchEmailLog` + `fetchEmailLogForExport`.
- `src/app/(staff)/staff/(dashboard)/admin/emails-sent/page.tsx` — the page.
- `src/app/(staff)/staff/(dashboard)/admin/emails-sent/export/route.ts` — CSV route.

**Modified:**
- `src/components/staff/staff-nav-config.ts` — add nav item.
- `src/lib/notifications/notify-released.ts` — add `to` to email metadata.
- `src/lib/notifications/notify-appointment-booked.ts` — add `to`.
- `src/lib/notifications/notify-appointment-reminder.ts` — add `to`.
- `src/app/api/cron/appointment-reminders/route.ts` — add `patient_id` to the failure audit row.
- `src/app/(marketing)/register/actions.ts` — capture + record both send outcomes.

---

## Task 1: Types + pure parser (TDD)

**Files:**
- Create: `src/lib/emails-log/types.ts`
- Create: `src/lib/emails-log/parse-row.ts`
- Test: `src/lib/emails-log/parse-row.test.ts`

- [ ] **Step 1: Write `types.ts`**

```ts
// Normalized model + the audit actions that represent an email send.
// Kept free of `server-only` and the generated Database types so the
// parser stays pure and unit-testable.

export type EmailStatus = "sent" | "failed" | "no_email" | "bulk";

export type EmailType =
  | "result"
  | "booking"
  | "reminder"
  | "newsletter"
  | "registration_new"
  | "registration_existing";

export interface EmailLogEntry {
  id: number;
  sentAt: string; // created_at ISO
  type: EmailType;
  typeLabel: string;
  status: EmailStatus;
  statusLabel: string;
  patientId: string | null;
  recipientName: string | null;
  recipientDrmId: string | null;
  recipientEmail: string | null; // metadata.email.to ?? patient.email
  resendId: string | null;
  detail: string | null; // test/service name, newsletter subject, or error
  resourceType: string | null;
  resourceId: string | null;
  visitId: string | null; // results only (metadata.visit_id) — for the Visit link
  bulk?: { attempted: number; delivered: number; failed: number };
}

// The subset of an audit_log row the parser reads.
export interface EmailAuditRow {
  id: number;
  action: string;
  patient_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  metadata: unknown;
  created_at: string;
}

export interface PatientLite {
  id: string;
  drm_id: string;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  email: string | null;
}

// The actions surfaced by the emails-sent log, in display priority order.
export const EMAIL_ACTIONS = [
  "result.notified",
  "appointment.booked.notified",
  "appointment.reminder.sent",
  "appointment.reminder.failed",
  "newsletter.campaign.sent",
  "patient.self_registered",
  "patient.self_register.matched",
] as const;
```

- [ ] **Step 2: Write the failing test `parse-row.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseEmailLogRow } from "./parse-row";
import type { EmailAuditRow, PatientLite } from "./types";

const patient: PatientLite = {
  id: "p1",
  drm_id: "DRM-0042",
  first_name: "Juan",
  middle_name: "Santos",
  last_name: "Cruz",
  email: "juan@example.com",
};

function row(over: Partial<EmailAuditRow>): EmailAuditRow {
  return {
    id: 1,
    action: "result.notified",
    patient_id: "p1",
    resource_type: "test_request",
    resource_id: "t1",
    metadata: {},
    created_at: "2026-06-16T01:00:00.000Z",
    ...over,
  };
}

describe("parseEmailLogRow", () => {
  it("result.notified — sent, detail = test name, recipient from patient", () => {
    const e = parseEmailLogRow(
      row({ metadata: { visit_id: "v1", test_name: "CBC", email: { ok: true, id: "re_1" } } }),
      patient,
    );
    expect(e.type).toBe("result");
    expect(e.typeLabel).toBe("Result ready");
    expect(e.status).toBe("sent");
    expect(e.statusLabel).toBe("Sent");
    expect(e.detail).toBe("CBC");
    expect(e.recipientName).toBe("Cruz, Juan Santos");
    expect(e.recipientDrmId).toBe("DRM-0042");
    expect(e.recipientEmail).toBe("juan@example.com");
    expect(e.resendId).toBe("re_1");
    expect(e.visitId).toBe("v1");
  });

  it("uses snapshot metadata.email.to over the patient's current email", () => {
    const e = parseEmailLogRow(
      row({ metadata: { test_name: "CBC", email: { ok: true, id: "re_1", to: "old@example.com" } } }),
      patient,
    );
    expect(e.recipientEmail).toBe("old@example.com");
  });

  it("appointment.booked.notified — failed when email.error present, detail = error", () => {
    const e = parseEmailLogRow(
      row({
        action: "appointment.booked.notified",
        resource_type: "appointment",
        resource_id: "a1",
        metadata: { email: { ok: false, error: "Resend 422: bad address" } },
      }),
      patient,
    );
    expect(e.type).toBe("booking");
    expect(e.status).toBe("failed");
    expect(e.detail).toBe("Resend 422: bad address");
  });

  it("appointment.reminder.sent — no_email when skipped, detail = reason", () => {
    const e = parseEmailLogRow(
      row({
        action: "appointment.reminder.sent",
        resource_type: "appointment",
        resource_id: "a1",
        metadata: { email: { ok: false, skipped: true, reason: "no email" }, has_form: false },
      }),
      patient,
    );
    expect(e.type).toBe("reminder");
    expect(e.status).toBe("no_email");
    expect(e.statusLabel).toBe("No email on file");
    expect(e.detail).toBe("no email");
  });

  it("appointment.reminder.failed — failed, detail = metadata.error, no email key", () => {
    const e = parseEmailLogRow(
      row({
        action: "appointment.reminder.failed",
        resource_type: "appointment",
        resource_id: "a1",
        metadata: { error: "boom" },
      }),
      patient,
    );
    expect(e.type).toBe("reminder");
    expect(e.status).toBe("failed");
    expect(e.detail).toBe("boom");
    expect(e.recipientName).toBe("Cruz, Juan Santos");
  });

  it("newsletter.campaign.sent — bulk, detail = subject, carries counts, no patient", () => {
    const e = parseEmailLogRow(
      row({
        action: "newsletter.campaign.sent",
        patient_id: null,
        resource_type: "newsletter_campaign",
        resource_id: "c1",
        metadata: { subject: "June news", attempted: 120, delivered: 118, failed: 2 },
      }),
      null,
    );
    expect(e.type).toBe("newsletter");
    expect(e.status).toBe("bulk");
    expect(e.detail).toBe("June news");
    expect(e.bulk).toEqual({ attempted: 120, delivered: 118, failed: 2 });
    expect(e.recipientName).toBeNull();
    expect(e.recipientEmail).toBeNull();
  });

  it("patient.self_registered — registration_new, sent when email captured", () => {
    const e = parseEmailLogRow(
      row({
        action: "patient.self_registered",
        resource_type: "patient",
        resource_id: "p1",
        metadata: { drm_id: "DRM-0042", email: { ok: true, id: "re_2", to: "juan@example.com" } },
      }),
      patient,
    );
    expect(e.type).toBe("registration_new");
    expect(e.typeLabel).toBe("Registration welcome");
    expect(e.status).toBe("sent");
  });

  it("patient.self_register.matched — registration_existing; legacy row (no email key) defaults to sent", () => {
    const e = parseEmailLogRow(
      row({
        action: "patient.self_register.matched",
        resource_type: "patient",
        resource_id: "p1",
        metadata: { drm_id: "DRM-0042", via: "register" },
      }),
      patient,
    );
    expect(e.type).toBe("registration_existing");
    expect(e.status).toBe("sent");
    expect(e.recipientEmail).toBe("juan@example.com"); // falls back to patient email
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npx vitest run src/lib/emails-log/parse-row.test.ts`
Expected: FAIL — "Failed to resolve import './parse-row'" / `parseEmailLogRow is not a function`.

- [ ] **Step 4: Write `parse-row.ts`**

```ts
import { formatPatientName } from "@/lib/patients/format-name";
import type {
  EmailAuditRow,
  EmailLogEntry,
  EmailStatus,
  EmailType,
  PatientLite,
} from "./types";

const TYPE_LABEL: Record<EmailType, string> = {
  result: "Result ready",
  booking: "Booking confirmation",
  reminder: "Appointment reminder",
  newsletter: "Newsletter",
  registration_new: "Registration welcome",
  registration_existing: "Registration (existing)",
};

const STATUS_LABEL: Record<EmailStatus, string> = {
  sent: "Sent",
  failed: "Failed",
  no_email: "No email on file",
  bulk: "Newsletter",
};

function typeForAction(action: string): EmailType {
  switch (action) {
    case "result.notified":
      return "result";
    case "appointment.booked.notified":
      return "booking";
    case "appointment.reminder.sent":
    case "appointment.reminder.failed":
      return "reminder";
    case "newsletter.campaign.sent":
      return "newsletter";
    case "patient.self_registered":
      return "registration_new";
    case "patient.self_register.matched":
      return "registration_existing";
    default:
      return "result"; // unreachable: callers filter to EMAIL_ACTIONS
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asNumber(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

export function parseEmailLogRow(
  row: EmailAuditRow,
  patient?: PatientLite | null,
): EmailLogEntry {
  const meta = asObject(row.metadata);
  const email = asObject(meta.email);
  const type = typeForAction(row.action);

  let status: EmailStatus;
  if (type === "newsletter") {
    status = "bulk";
  } else if (row.action === "appointment.reminder.failed") {
    status = "failed";
  } else if (email.ok === true) {
    status = "sent";
  } else if (email.skipped === true) {
    status = "no_email";
  } else if (asString(email.error)) {
    status = "failed";
  } else {
    // Legacy self-reg rows: the send was attempted but the outcome wasn't
    // recorded (forward-only capture). Treat as sent — the only path here.
    status = "sent";
  }

  let detail: string | null = null;
  if (type === "result") {
    detail = asString(meta.test_name);
  } else if (type === "newsletter") {
    detail = asString(meta.subject);
  } else if (status === "failed") {
    detail = asString(email.error) ?? asString(meta.error);
  } else if (status === "no_email") {
    detail = asString(email.reason);
  }

  const recipientEmail = asString(email.to) ?? patient?.email ?? null;
  const recipientName = patient ? formatPatientName(patient) || null : null;

  let bulk: EmailLogEntry["bulk"];
  if (type === "newsletter") {
    bulk = {
      attempted: asNumber(meta.attempted),
      delivered: asNumber(meta.delivered),
      failed: asNumber(meta.failed),
    };
  }

  return {
    id: row.id,
    sentAt: row.created_at,
    type,
    typeLabel: TYPE_LABEL[type],
    status,
    statusLabel: STATUS_LABEL[status],
    patientId: row.patient_id,
    recipientName,
    recipientDrmId: patient?.drm_id ?? null,
    recipientEmail,
    resendId: asString(email.id),
    detail,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    visitId: asString(meta.visit_id),
    bulk,
  };
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npx vitest run src/lib/emails-log/parse-row.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/emails-log/types.ts src/lib/emails-log/parse-row.ts src/lib/emails-log/parse-row.test.ts
git commit -m "feat(emails-log): normalized EmailLogEntry + pure audit-row parser"
```

---

## Task 2: CSV serializer (TDD)

**Files:**
- Create: `src/lib/emails-log/csv.ts`
- Test: `src/lib/emails-log/csv.test.ts`

- [ ] **Step 1: Write the failing test `csv.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { emailLogToCsv } from "./csv";
import type { EmailLogEntry } from "./types";

function entry(over: Partial<EmailLogEntry>): EmailLogEntry {
  return {
    id: 1,
    sentAt: "2026-06-16T01:00:00.000Z",
    type: "result",
    typeLabel: "Result ready",
    status: "sent",
    statusLabel: "Sent",
    patientId: "p1",
    recipientName: "Cruz, Juan",
    recipientDrmId: "DRM-0042",
    recipientEmail: "juan@example.com",
    resendId: "re_1",
    detail: "CBC",
    resourceType: "test_request",
    resourceId: "t1",
    visitId: "v1",
    ...over,
  };
}

describe("emailLogToCsv", () => {
  it("emits a header row then one row per entry", () => {
    const csv = emailLogToCsv([entry({})]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      '"Sent (ISO)","Type","Status","Recipient","DRM-ID","Email","Resend ID","Detail"',
    );
    expect(lines[1]).toContain('"Result ready"');
    expect(lines[1]).toContain('"juan@example.com"');
  });

  it("escapes embedded quotes by doubling them", () => {
    const csv = emailLogToCsv([entry({ detail: 'he said "hi"' })]);
    expect(csv).toContain('"he said ""hi"""');
  });

  it("renders newsletter recipient + delivered/attempted in status", () => {
    const csv = emailLogToCsv([
      entry({
        type: "newsletter",
        typeLabel: "Newsletter",
        status: "bulk",
        statusLabel: "Newsletter",
        recipientName: null,
        recipientDrmId: null,
        recipientEmail: null,
        detail: "June news",
        bulk: { attempted: 120, delivered: 118, failed: 2 },
      }),
    ]);
    const line = csv.split("\r\n")[1];
    expect(line).toContain('"Newsletter (118/120)"');
    expect(line).toContain('"All subscribers (120)"');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/lib/emails-log/csv.test.ts`
Expected: FAIL — cannot resolve `./csv`.

- [ ] **Step 3: Write `csv.ts`**

```ts
import type { EmailLogEntry } from "./types";

const HEADERS = [
  "Sent (ISO)",
  "Type",
  "Status",
  "Recipient",
  "DRM-ID",
  "Email",
  "Resend ID",
  "Detail",
];

function cell(v: string | null | undefined): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export function emailLogToCsv(entries: EmailLogEntry[]): string {
  const lines = [HEADERS.map(cell).join(",")];
  for (const e of entries) {
    const status = e.bulk
      ? `${e.statusLabel} (${e.bulk.delivered}/${e.bulk.attempted})`
      : e.statusLabel;
    const recipient =
      e.recipientName ??
      (e.type === "newsletter"
        ? `All subscribers${e.bulk ? ` (${e.bulk.attempted})` : ""}`
        : null);
    lines.push(
      [
        cell(e.sentAt),
        cell(e.typeLabel),
        cell(status),
        cell(recipient),
        cell(e.recipientDrmId),
        cell(e.recipientEmail),
        cell(e.resendId),
        cell(e.detail),
      ].join(","),
    );
  }
  return lines.join("\r\n");
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/lib/emails-log/csv.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/emails-log/csv.ts src/lib/emails-log/csv.test.ts
git commit -m "feat(emails-log): CSV serializer"
```

---

## Task 3: Query layer

**Files:**
- Create: `src/lib/emails-log/query.ts`

No unit test (imports `server-only` + DB). Verified via typecheck + the page smoke later.

- [ ] **Step 1: Write `query.ts`**

```ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseEmailLogRow } from "./parse-row";
import {
  EMAIL_ACTIONS,
  type EmailAuditRow,
  type EmailLogEntry,
  type EmailStatus,
  type EmailType,
  type PatientLite,
} from "./types";

export const PAGE_SIZE = 50;
const EXPORT_CAP = 10_000;

const SELECT =
  "id, action, patient_id, resource_type, resource_id, metadata, created_at";

// Map a UI type filter to the underlying audit actions.
const ACTIONS_FOR_TYPE: Record<EmailType, string[]> = {
  result: ["result.notified"],
  booking: ["appointment.booked.notified"],
  reminder: ["appointment.reminder.sent", "appointment.reminder.failed"],
  newsletter: ["newsletter.campaign.sent"],
  registration_new: ["patient.self_registered"],
  registration_existing: ["patient.self_register.matched"],
};

// Manila is UTC+8, no DST. Accept a YYYY-MM-DD date input as a Manila local date.
function manilaStartUtc(d: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00+08:00` : null;
}
function manilaEndUtc(d: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T23:59:59.999+08:00` : null;
}

export interface EmailLogFilters {
  type: EmailType | null;
  status: EmailStatus | null; // "sent" | "failed" | "no_email" (bulk not a filter)
  drmId: string | null;
  since: string | null; // YYYY-MM-DD
  until: string | null;
  page: number;
}

type AdminClient = ReturnType<typeof createAdminClient>;

// Resolve a DRM-ID filter to a patient_id. Returns:
//  - { id }            → filter to this patient
//  - { id: SENTINEL }  → DRM provided but no match → force an empty result
//  - null              → no DRM filter
const NO_MATCH = "00000000-0000-0000-0000-000000000000";

async function resolvePatientFilter(
  admin: AdminClient,
  drmId: string | null,
): Promise<{ patientId: string | null; resolvedDrmId: string | null }> {
  if (!drmId || drmId.trim().length === 0) {
    return { patientId: null, resolvedDrmId: null };
  }
  const { data } = await admin
    .from("patients")
    .select("id, drm_id")
    .eq("drm_id", drmId.trim().toUpperCase())
    .maybeSingle();
  return data
    ? { patientId: data.id, resolvedDrmId: data.drm_id }
    : { patientId: NO_MATCH, resolvedDrmId: null };
}

// Apply the shared filters (action set, patient, date, status) to a query.
// Generic over the PostgREST builder type so it works for select + head/count.
function applyFilters<T extends { in: Function; eq: Function; gte: Function; lte: Function; or: Function }>(
  query: T,
  filters: EmailLogFilters,
  patientId: string | null,
): T {
  const actions = filters.type ? ACTIONS_FOR_TYPE[filters.type] : [...EMAIL_ACTIONS];
  let q = query.in("action", actions) as T;
  if (patientId) q = q.eq("patient_id", patientId) as T;

  const since = filters.since ? manilaStartUtc(filters.since) : null;
  const until = filters.until ? manilaEndUtc(filters.until) : null;
  if (since) q = q.gte("created_at", since) as T;
  if (until) q = q.lte("created_at", until) as T;

  // Status is derived from metadata.email JSONB. Newsletter rows have no
  // metadata.email, so any status filter naturally excludes them.
  if (filters.status === "sent") {
    q = q.eq("metadata->email->>ok", "true") as T;
  } else if (filters.status === "no_email") {
    q = q.eq("metadata->email->>skipped", "true") as T;
  } else if (filters.status === "failed") {
    q = q.or(
      "metadata->email->>error.not.is.null,action.eq.appointment.reminder.failed",
    ) as T;
  }
  return q;
}

async function resolvePatients(
  admin: AdminClient,
  rows: EmailAuditRow[],
): Promise<Map<string, PatientLite>> {
  const ids = Array.from(
    new Set(rows.map((r) => r.patient_id).filter((x): x is string => !!x)),
  );
  const map = new Map<string, PatientLite>();
  if (ids.length === 0) return map;
  const { data } = await admin
    .from("patients")
    .select("id, drm_id, first_name, middle_name, last_name, email")
    .in("id", ids);
  for (const p of data ?? []) map.set(p.id, p as PatientLite);
  return map;
}

export interface EmailLogResult {
  entries: EmailLogEntry[];
  total: number;
  failures7d: number;
  resolvedDrmId: string | null;
  drmNoMatch: boolean;
}

export async function fetchEmailLog(filters: EmailLogFilters): Promise<EmailLogResult> {
  const admin = createAdminClient();
  const { patientId, resolvedDrmId } = await resolvePatientFilter(admin, filters.drmId);
  const drmNoMatch = patientId === NO_MATCH;

  const offset = (filters.page - 1) * PAGE_SIZE;
  const base = admin
    .from("audit_log")
    .select(SELECT, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  const { data, count } = await applyFilters(base, filters, patientId);
  const rows = (data ?? []) as unknown as EmailAuditRow[];
  const patients = await resolvePatients(admin, rows);
  const entries = rows.map((r) =>
    parseEmailLogRow(r, r.patient_id ? patients.get(r.patient_id) ?? null : null),
  );

  // Failures in the last 7 days (banner). Date.now() is fine in route/RSC code.
  const since7 = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { count: failures7d } = await admin
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .in("action", [...EMAIL_ACTIONS])
    .gte("created_at", since7)
    .or("metadata->email->>error.not.is.null,action.eq.appointment.reminder.failed");

  return {
    entries,
    total: count ?? 0,
    failures7d: failures7d ?? 0,
    resolvedDrmId,
    drmNoMatch,
  };
}

// Full filtered set for CSV export (capped). No pagination.
export async function fetchEmailLogForExport(
  filters: Omit<EmailLogFilters, "page">,
): Promise<EmailLogEntry[]> {
  const admin = createAdminClient();
  const { patientId } = await resolvePatientFilter(admin, filters.drmId);

  const base = admin
    .from("audit_log")
    .select(SELECT)
    .order("created_at", { ascending: false })
    .range(0, EXPORT_CAP - 1);

  const { data } = await applyFilters(base, { ...filters, page: 1 }, patientId);
  const rows = (data ?? []) as unknown as EmailAuditRow[];
  const patients = await resolvePatients(admin, rows);
  return rows.map((r) =>
    parseEmailLogRow(r, r.patient_id ? patients.get(r.patient_id) ?? null : null),
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If the generic `applyFilters` constraint causes friction with the PostgREST builder types, simplify by typing `query` as `any` with an inline `// eslint-disable-next-line @typescript-eslint/no-explicit-any` + a comment (PostgREST's fluent builder types don't compose cleanly across select/head). Prefer the generic; fall back to `any` only if needed.

- [ ] **Step 3: Verify the JSONB status filter syntax against real data**

Docker is off, so smoke the filter strings against prod read-only via the Supabase MCP (the project already uses MCP for remote reads). Run an `execute_sql`:

```sql
select action, metadata->'email'->>'ok' as ok, metadata->'email'->>'error' as err
from audit_log
where action in ('result.notified','appointment.booked.notified','appointment.reminder.sent','appointment.reminder.failed')
order by created_at desc limit 20;
```

Confirm the rows carry the expected `email.ok` / `email.error` keys so the `.eq("metadata->email->>ok","true")` and `.or(...)` filters match real data. If `email` is nested differently than expected, adjust the JSON paths. (Read-only query; no writes.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/emails-log/query.ts
git commit -m "feat(emails-log): server query layer (filters, pagination, patient resolve, CSV fetch)"
```

---

## Task 4: The page

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/admin/emails-sent/page.tsx`

- [ ] **Step 1: Write `page.tsx`**

```tsx
import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { Panel } from "@/components/ui/panel";
import { fetchEmailLog, PAGE_SIZE } from "@/lib/emails-log/query";
import type { EmailStatus, EmailType } from "@/lib/emails-log/types";

export const metadata = { title: "Emails sent — staff" };

const STATUS_STYLE: Record<EmailStatus, string> = {
  sent: "bg-emerald-100 text-emerald-900",
  failed: "bg-rose-100 text-rose-900",
  no_email: "bg-amber-100 text-amber-900",
  bulk: "bg-slate-200 text-slate-700",
};

const TYPE_OPTIONS: { value: EmailType; label: string }[] = [
  { value: "result", label: "Result ready" },
  { value: "booking", label: "Booking confirmation" },
  { value: "reminder", label: "Appointment reminder" },
  { value: "newsletter", label: "Newsletter" },
  { value: "registration_new", label: "Registration welcome" },
  { value: "registration_existing", label: "Registration (existing)" },
];

const STATUS_OPTIONS: { value: EmailStatus; label: string }[] = [
  { value: "sent", label: "Sent" },
  { value: "failed", label: "Failed" },
  { value: "no_email", label: "No email on file" },
];

const VALID_TYPES = new Set(TYPE_OPTIONS.map((t) => t.value));
const VALID_STATUS = new Set(STATUS_OPTIONS.map((s) => s.value));

interface Props {
  searchParams: Promise<{
    type?: string;
    status?: string;
    drm?: string;
    since?: string;
    until?: string;
    page?: string;
  }>;
}

export default async function EmailsSentPage({ searchParams }: Props) {
  await requireAdminStaff();
  const params = await searchParams;

  const type = (params.type && VALID_TYPES.has(params.type as EmailType)
    ? (params.type as EmailType)
    : null);
  const status = (params.status && VALID_STATUS.has(params.status as EmailStatus)
    ? (params.status as EmailStatus)
    : null);
  const page = Math.max(1, Number(params.page ?? "1") || 1);

  const { entries, total, failures7d, resolvedDrmId, drmNoMatch } =
    await fetchEmailLog({
      type,
      status,
      drmId: params.drm ?? null,
      since: params.since ?? null,
      until: params.until ?? null,
      page,
    });

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const offset = (page - 1) * PAGE_SIZE;

  function buildHref(overrides: Record<string, string | null>): string {
    const sp = new URLSearchParams();
    const base: Record<string, string | null> = {
      type,
      status,
      drm: params.drm ?? null,
      since: params.since ?? null,
      until: params.until ?? null,
    };
    for (const [k, v] of Object.entries({ ...base, ...overrides })) {
      if (v) sp.set(k, v);
    }
    const qs = sp.toString();
    return `/staff/admin/emails-sent${qs ? `?${qs}` : ""}`;
  }

  const hasFilter = Boolean(type || status || params.drm || params.since || params.until);
  const exportQs = (() => {
    const sp = new URLSearchParams();
    if (type) sp.set("type", type);
    if (status) sp.set("status", status);
    if (params.drm) sp.set("drm", params.drm);
    if (params.since) sp.set("since", params.since);
    if (params.until) sp.set("until", params.until);
    const qs = sp.toString();
    return qs ? `?${qs}` : "";
  })();

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Emails sent
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Every transactional email the system sent — result alerts, booking
          confirmations, reminders, newsletters, and registration welcomes.
          Read-only, reconstructed from the audit log.
        </p>
      </header>

      {failures7d > 0 ? (
        <Link
          href={buildHref({ status: "failed", page: null })}
          className="mb-4 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-900 hover:bg-rose-100"
        >
          <strong>{failures7d}</strong> failed send
          {failures7d === 1 ? "" : "s"} in the last 7 days — view failures →
        </Link>
      ) : null}

      <form className="mb-2 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-6">
        <select
          name="type"
          defaultValue={type ?? ""}
          aria-label="Email type"
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none lg:col-span-2"
        >
          <option value="">All types</option>
          {TYPE_OPTIONS.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <select
          name="status"
          defaultValue={status ?? ""}
          aria-label="Status"
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="">Any status</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <input
          type="search"
          name="drm"
          defaultValue={params.drm ?? ""}
          placeholder="DRM-ID · e.g. DRM-0042"
          aria-label="Patient DRM-ID"
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        />
        <div className="grid grid-cols-2 gap-2 lg:col-span-2">
          <input
            type="date"
            name="since"
            defaultValue={params.since ?? ""}
            aria-label="From date"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
          <input
            type="date"
            name="until"
            defaultValue={params.until ?? ""}
            aria-label="To date"
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-2 focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap gap-2 lg:col-span-6">
          <button
            type="submit"
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Filter
          </button>
          {hasFilter ? (
            <Link
              href="/staff/admin/emails-sent"
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
            >
              Clear
            </Link>
          ) : null}
          <Link
            href={buildHref({ status: "failed", page: null })}
            className="rounded-md border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-50"
          >
            Failures only
          </Link>
          <a
            href={`/staff/admin/emails-sent/export${exportQs}`}
            className="ml-auto rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
          >
            Export CSV
          </a>
        </div>
      </form>

      {drmNoMatch ? (
        <p className="mb-3 text-xs text-amber-700" role="alert">
          No patient with DRM-ID {params.drm}.
        </p>
      ) : resolvedDrmId ? (
        <p className="mb-3 text-xs text-[color:var(--color-brand-text-soft)]">
          Filtered to <strong>{resolvedDrmId}</strong>.
        </p>
      ) : null}

      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-4 py-3">Sent</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Recipient</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Details</th>
              <th className="px-4 py-3">Resource</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {entries.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
                  No emails match these filters.
                </td>
              </tr>
            ) : (
              entries.map((e) => {
                const resource =
                  e.type === "result" && e.visitId
                    ? { href: `/staff/visits/${e.visitId}`, label: "Visit" }
                    : e.type === "booking" || e.type === "reminder"
                      ? { href: "/staff/appointments", label: "Appointment" }
                      : e.type === "newsletter"
                        ? { href: "/staff/admin/newsletter", label: "Campaign" }
                        : null;
                return (
                  <tr key={e.id} className="hover:bg-[color:var(--color-brand-bg)]">
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-[color:var(--color-brand-text-mid)]">
                      {new Date(e.sentAt).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{e.typeLabel}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {e.type === "newsletter" ? (
                        <span className="text-[color:var(--color-brand-text-soft)]">
                          All subscribers{e.bulk ? ` (${e.bulk.attempted})` : ""}
                        </span>
                      ) : e.patientId ? (
                        <Link
                          href={`/staff/patients/${e.patientId}`}
                          className="text-[color:var(--color-brand-navy)] hover:underline"
                        >
                          {e.recipientName ?? "(no name)"}
                        </Link>
                      ) : (
                        <span className="text-[color:var(--color-brand-text-soft)]">—</span>
                      )}
                      {e.recipientDrmId ? (
                        <span className="ml-1 text-xs text-[color:var(--color-brand-text-soft)]">
                          ({e.recipientDrmId})
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {e.recipientEmail ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[e.status]}`}>
                        {e.bulk
                          ? `${e.bulk.delivered} sent · ${e.bulk.failed} failed`
                          : e.statusLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {e.detail ? <span>{e.detail}</span> : null}
                      {e.resendId ? (
                        <span className="mt-0.5 block font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                          {e.resendId}
                        </span>
                      ) : null}
                      {!e.detail && !e.resendId ? "—" : null}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {resource ? (
                        <Link href={resource.href} className="text-[color:var(--color-brand-navy)] hover:underline">
                          {resource.label}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Panel>

      <div className="mt-4 flex items-center justify-between text-xs text-[color:var(--color-brand-text-soft)]">
        <span>
          {total > 0
            ? `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`
            : "0 emails"}
        </span>
        <div className="flex gap-2">
          {page > 1 ? (
            <Link href={buildHref({ page: String(page - 1) })} className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-1.5 hover:bg-white">
              ← Prev
            </Link>
          ) : null}
          {page < totalPages ? (
            <Link href={buildHref({ page: String(page + 1) })} className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-1.5 hover:bg-white">
              Next →
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (Note `buildHref({ page: null })` is used to drop the page param when changing filters; ensure `page` is part of the override map only where intended — the failures banner/chip pass `page: null` to reset to page 1.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/emails-sent/page.tsx"
git commit -m "feat(emails-log): admin emails-sent page (filters, table, pagination, failures banner)"
```

---

## Task 5: CSV export route

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/admin/emails-sent/export/route.ts`

- [ ] **Step 1: Write `route.ts`**

```ts
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { fetchEmailLogForExport } from "@/lib/emails-log/query";
import { emailLogToCsv } from "@/lib/emails-log/csv";
import type { EmailStatus, EmailType } from "@/lib/emails-log/types";

export const dynamic = "force-dynamic";

const VALID_TYPES = new Set<EmailType>([
  "result", "booking", "reminder", "newsletter",
  "registration_new", "registration_existing",
]);
const VALID_STATUS = new Set<EmailStatus>(["sent", "failed", "no_email"]);

export async function GET(request: Request) {
  const session = await requireAdminStaff();
  const url = new URL(request.url);
  const get = (k: string) => {
    const v = url.searchParams.get(k);
    return v && v.length > 0 ? v : null;
  };

  const typeRaw = get("type");
  const statusRaw = get("status");
  const filters = {
    type: typeRaw && VALID_TYPES.has(typeRaw as EmailType) ? (typeRaw as EmailType) : null,
    status: statusRaw && VALID_STATUS.has(statusRaw as EmailStatus) ? (statusRaw as EmailStatus) : null,
    drmId: get("drm"),
    since: get("since"),
    until: get("until"),
  };

  const entries = await fetchEmailLogForExport(filters);
  const csv = emailLogToCsv(entries);

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "emails_log.exported",
    resource_type: "audit_log",
    metadata: { ...filters, rows: entries.length },
    ip_address: ip,
    user_agent: ua,
  });

  // Static stamp via toISOString (route code, not React render).
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="emails-sent-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/emails-sent/export/route.ts"
git commit -m "feat(emails-log): audit-logged CSV export route"
```

---

## Task 6: Sidebar nav item

**Files:**
- Modify: `src/components/staff/staff-nav-config.ts` (insert after the "Audit log" item, currently line ~447)

- [ ] **Step 1: Add the nav item**

Insert this object immediately AFTER the `/staff/audit` "Audit log" item object (the one ending `roles: ["admin"], },` at ~line 447) and BEFORE the `/staff/admin/settings/dashboard-cards` "Dashboard settings" item, inside the `"Admin tools"` subgroup's `items` array:

```ts
          {
            href: "/staff/admin/emails-sent",
            label: "Emails sent",
            description: "Every transactional email the system sent — result alerts, booking confirmations, day-before reminders, newsletters, and registration welcomes. Filter by type, status, date, or patient; export to CSV.",
            roles: ["admin"],
          },
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/staff/staff-nav-config.ts
git commit -m "feat(emails-log): add 'Emails sent' admin nav item"
```

---

## Task 7: Snapshot recipient + capture self-reg outcomes (forward-only)

**Files:**
- Modify: `src/lib/notifications/notify-released.ts:100-110`
- Modify: `src/lib/notifications/notify-appointment-booked.ts:146-157`
- Modify: `src/lib/notifications/notify-appointment-reminder.ts:96-104`
- Modify: `src/app/api/cron/appointment-reminders/route.ts:58-65`
- Modify: `src/app/(marketing)/register/actions.ts:71-88, 126-142`

All edits are additive (record what already happened); no behavior change.

- [ ] **Step 1: `notify-released.ts` — add `to` to the email metadata branches**

Replace the `email:` block inside the `audit({...})` call (currently lines ~105-109) with:

```ts
      email: emailResult.ok
        ? { ok: true, id: emailResult.id, to: patient.email }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error, to: patient.email },
```

- [ ] **Step 2: `notify-appointment-booked.ts` — add `to`**

Replace the `email:` block inside the `audit({...})` call (currently lines ~152-156) with:

```ts
      email: emailResult.ok
        ? { ok: true, id: emailResult.id, to: email }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error, to: email },
```

(`email` is the local resolved address: `patient?.email ?? null`.)

- [ ] **Step 3: `notify-appointment-reminder.ts` — add `to`**

Replace the `email:` block inside the second `audit({...})` call (the send path, currently lines ~97-101) with:

```ts
      email: emailResult.ok
        ? { ok: true, id: emailResult.id, to: email }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error, to: email },
```

(Leave the earlier no-email skip-path `audit` call unchanged — there is no recipient there.)

- [ ] **Step 4: `cron/appointment-reminders/route.ts` — set `patient_id` on the failure row**

In the `catch` block's `audit({...})` call (currently lines ~58-65), add `patient_id: a.patient_id,` after `actor_type: "system",`:

```ts
      await audit({
        actor_id: null,
        actor_type: "system",
        patient_id: a.patient_id,
        action: "appointment.reminder.failed",
        resource_type: "appointment",
        resource_id: a.id,
        metadata: { error: msg },
      });
```

- [ ] **Step 5: `register/actions.ts` — capture both send outcomes**

5a. In the `res.reused` branch, change the bare `await sendEmail({...})` (line ~72) to capture the result, and add an `email` key to the matched audit's metadata:

```ts
    const sendResult = await sendEmail({
      to: d.email,
      subject: "Your DRMed DRM-ID",
      text: `Hi ${d.first_name},\n\nWe found an existing DRMed record matching your details. Your DRM-ID is ${res.drm_id}.\n\nPresent it at the clinic. After your visit, the Secure PIN printed on your receipt unlocks your results online.\n\n— DRMed Clinic & Laboratory`,
    });
    await audit({
      actor_id: null,
      actor_type: "anonymous",
      patient_id: res.id,
      action: "patient.self_register.matched",
      resource_type: "patient",
      resource_id: res.id,
      metadata: {
        drm_id: res.drm_id,
        via: "register",
        email: sendResult.ok
          ? { ok: true, id: sendResult.id, to: d.email }
          : sendResult.kind === "skipped"
            ? { ok: false, skipped: true, reason: sendResult.reason }
            : { ok: false, error: sendResult.error, to: d.email },
      },
      ip_address: ip,
      user_agent: ua,
    });
```

5b. In the new-registrant path, change the bare `await sendEmail({...})` (line ~126) to capture the result, and add an `email` key to the `patient.self_registered` audit's metadata:

```ts
  const welcomeResult = await sendEmail({
    to: d.email,
    subject: "Welcome to DRMed — your DRM-ID",
    text: `Hi ${d.first_name},\n\nThanks for pre-registering. Your DRM-ID is ${res.drm_id}.\n\nBring it on your visit — reception verifies your identity at the counter. After your visit, the Secure PIN printed on your receipt unlocks your results online.\n\n— DRMed Clinic & Laboratory`,
  });

  await audit({
    actor_id: null,
    actor_type: "anonymous",
    patient_id: res.id,
    action: "patient.self_registered",
    resource_type: "patient",
    resource_id: res.id,
    metadata: {
      drm_id: res.drm_id,
      via: "register",
      consent_recorded: true,
      marketing_consent: d.marketing_consent,
      email: welcomeResult.ok
        ? { ok: true, id: welcomeResult.id, to: d.email }
        : welcomeResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: welcomeResult.reason }
          : { ok: false, error: welcomeResult.error, to: d.email },
    },
    ip_address: ip,
    user_agent: ua,
  });
```

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors. (`SendResult`'s discriminated union gives `.id` on `ok`, `.reason` on `kind:"skipped"`, `.error` on the error case — matching the existing notifier code.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/notifications/notify-released.ts src/lib/notifications/notify-appointment-booked.ts src/lib/notifications/notify-appointment-reminder.ts src/app/api/cron/appointment-reminders/route.ts "src/app/(marketing)/register/actions.ts"
git commit -m "feat(emails-log): snapshot recipient address + capture self-reg send outcomes"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run the whole suite + build**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green; the 2 new test files (parse-row: 8, csv: 3) pass; build succeeds.

- [ ] **Step 2: Manual UI smoke (against prod data, optional but recommended)**

Per the prod-UI-smoke recipe (memory: `feedback_prod_ui_smoke_recipe`): move `.env.development.local` aside, create an ephemeral admin via MCP, log in, visit `/staff/admin/emails-sent`. Verify: rows render with real recipients/status, the type/status/date/DRM filters narrow results, pagination works, the failures banner appears if there are recent failures, "Export CSV" downloads a file whose rows match the filtered view, and an `emails_log.exported` audit row was written. Delete the ephemeral admin. (Skip if smoking isn't feasible; the build + unit tests are the gate.)

- [ ] **Step 3: Final commit (if smoke produced any fixes)**

```bash
git add -A
git commit -m "fix(emails-log): smoke-test fixes"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** All 7 actions handled (Task 1 parser + Task 3 type map). Recipient snapshot-forward (Task 7). "No email on file" + newsletter + self-reg (Tasks 1/3/7). CSV export audit-logged (Tasks 2/5). Row links (Task 4 resource + recipient links). Failures-7d banner + "Failures only" chip (Task 4). Resend id shown (Task 4). Nav (Task 6). No migration (confirmed — only JSONB additions). Compliance note honored: admin-gated page + audit-logged export (Task 5).

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `EmailLogEntry` fields used in `csv.ts` (Task 2), `query.ts` (Task 3), `page.tsx` (Task 4) match Task 1's definition (`recipientName`, `recipientDrmId`, `recipientEmail`, `visitId`, `bulk`). `EmailLogFilters` (Task 3) is consumed by Task 4 (with `page`) and Task 5 (`Omit<…,"page">`). `session.user_id` (not `.id`) used in Task 5 per confirmed `StaffSession` shape. `SendResult` branch shape (`.id`/`.reason`/`.error`) in Task 7 matches the existing notifier code.

**Known runtime risk:** the JSONB status filters (`metadata->email->>ok`, the `.or(...)`) — verified in Task 3 Step 3 against real data before relying on them.
