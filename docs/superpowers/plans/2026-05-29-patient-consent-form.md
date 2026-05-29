# Patient Data-Privacy Consent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real, versioned RA 10173 consent instrument with three capture channels (printed/wet-signature, on-screen signature pad, portal acceptance), a full consent audit trail, and a feature-flagged DB release gate.

**Architecture:** Event-log table `patient_consents` (one row per grant/withdrawal) + denormalized current-state columns on `patients` kept in sync by a trigger. A `BEFORE UPDATE` gate trigger on `test_requests` blocks transition to `released` unless the patient has current consent, gated by a `consent_settings.gate_required` flag (default off for UAT). One shared notice module + React component renders the instrument on all three surfaces.

**Tech Stack:** Next.js 16 (App Router, Server Components + Server Actions), Supabase (Postgres + RLS + Storage), TypeScript strict, Tailwind v4 tokens, pdf-lib (already used), Playwright (smoke).

**Verification convention (project-specific):** This repo has **no unit-test runner** — verification is SQL smoke assertions (run via `supabase` / MCP `execute_sql` against a local stack), Playwright UI smoke, and `npm run typecheck` + `npm run lint`. Each task's "verify" steps use those, not a unit framework. Reference: `CLAUDE.md`, memory `feedback_local_ui_smoke_recipe.md`.

**Spec:** `docs/superpowers/specs/2026-05-29-patient-consent-form-design.md`

**Branch:** `feat/patient-consent-form` (already created; spec + importer fix already committed).

---

## File structure (what gets created / modified)

**Created:**
- `supabase/migrations/0086_patient_consent.sql` — table, columns, settings row, bucket, both triggers.
- `src/lib/consent/notice.ts` — versioned notice content + `CURRENT_CONSENT_NOTICE_VERSION`.
- `src/lib/consent/types.ts` — shared TS types (methods, signatory, grant input).
- `src/components/consent/consent-notice.tsx` — shared notice renderer (server-safe, no `'use client'`).
- `src/components/consent/signature-pad.tsx` — `'use client'` canvas signature pad.
- `src/lib/actions/consent/grant.ts` — `recordConsentGrantAction` (staff: paper + on-screen).
- `src/lib/actions/consent/withdraw.ts` — `withdrawConsentAction` (admin).
- `src/lib/actions/consent/artifact.ts` — `uploadConsentArtifactAction`, `viewConsentArtifactAction`.
- `src/lib/actions/consent/portal-accept.ts` — `acceptConsentPortalAction` (patient).
- `src/app/(staff)/staff/(dashboard)/patients/[id]/consent/print/page.tsx` — printable form route.
- `src/app/(staff)/staff/(dashboard)/patients/[id]/consent/consent-panel.tsx` — `'use client'` capture panel (pad + status + withdraw) embedded on the detail page.
- `src/app/(patient)/portal/(authenticated)/consent/consent-gate.tsx` — `'use client'` portal acceptance UI.
- `src/lib/consent/gate.ts` — `isConsentGateRequired()` + `getPatientConsentState()` server helpers.

**Modified:**
- `src/app/(staff)/staff/(dashboard)/patients/patient-form.tsx` — checkbox now collects signatory fields.
- `src/app/(staff)/staff/(dashboard)/patients/actions.ts` — create no longer stamps `consent_signed_at` directly; inserts a grant.
- `src/app/(staff)/staff/(dashboard)/patients/[id]/edit-actions.ts` — same; remove direct stamp.
- `src/app/(staff)/staff/(dashboard)/patients/[id]/page.tsx` — show consent panel + status + history.
- `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts` — `releaseTestAction` consent-error passthrough.
- `src/app/(staff)/staff/(dashboard)/visits/[id]/release-button.tsx` — disable / soft-warn on missing consent.
- `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx` — pass `consentOnFile` + `gateRequired` to the button.
- `src/lib/actions/results/finalise-consolidated.ts` — treat consent gate as `releaseDeferred`.
- `src/lib/accounting/pg-errors.ts` — `23514` branch returns the consent message when message contains `consent`.
- `src/app/(patient)/portal/(authenticated)/layout.tsx` (or page) — mount the portal consent gate.
- `src/types/database.ts` — regenerated after the migration.

---

## Phase 1 — Database foundation

### Task 1: Migration — schema, settings, bucket, triggers

**Files:**
- Create: `supabase/migrations/0086_patient_consent.sql`

- [ ] **Step 1: Write the migration**

```sql
-- =============================================================================
-- 0086 — Patient data-privacy consent (RA 10173)
-- =============================================================================
-- Event-log table + denormalized current-state on patients, a feature-flagged
-- release gate, and a private artifact bucket. See
-- docs/superpowers/specs/2026-05-29-patient-consent-form-design.md
-- =============================================================================

-- 1) Settings: single-row feature flag for the release gate.
create table if not exists public.consent_settings (
  id boolean primary key default true,         -- single-row guard
  gate_required boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint consent_settings_singleton check (id = true)
);
insert into public.consent_settings (id, gate_required)
values (true, false)
on conflict (id) do nothing;

-- 2) Event-log table.
create table if not exists public.patient_consents (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  event_type text not null check (event_type in ('granted','withdrawn')),
  method text check (method in ('paper_wet_signature','onscreen_signature','portal_acceptance')),
  notice_version text,
  signatory text check (signatory in ('self','guardian','representative')),
  signatory_name text,
  signatory_relationship text,
  artifact_path text,
  reason text,
  actor_kind text not null check (actor_kind in ('staff','patient')),
  created_by uuid references public.staff_profiles(id),
  ip text,
  user_agent text,
  created_at timestamptz not null default now(),

  -- Field-presence rules:
  constraint pc_grant_fields check (
    event_type <> 'granted'
    or (method is not null and notice_version is not null and signatory is not null and reason is null)
  ),
  constraint pc_withdraw_fields check (
    event_type <> 'withdrawn'
    or (method is null and notice_version is null and signatory is null and reason is not null)
  ),
  constraint pc_signatory_detail check (
    signatory is null or signatory = 'self'
    or (signatory_name is not null and signatory_relationship is not null)
  )
);

create index if not exists patient_consents_patient_idx
  on public.patient_consents (patient_id, created_at desc);

-- 3) Denormalized current-state columns on patients.
alter table public.patients
  add column if not exists consent_current boolean not null default false,
  add column if not exists consent_withdrawn_at timestamptz,
  add column if not exists consent_method text,
  add column if not exists consent_notice_version text;
-- consent_signed_at already exists (migration 0011).

-- 4) Sync trigger: recompute patients current-state from the latest event.
create or replace function public.sync_patient_consent_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest public.patient_consents%rowtype;
begin
  select * into v_latest
  from public.patient_consents
  where patient_id = new.patient_id
  order by created_at desc, id desc
  limit 1;

  if v_latest.event_type = 'granted' then
    update public.patients set
      consent_current = true,
      consent_signed_at = v_latest.created_at,
      consent_withdrawn_at = null,
      consent_method = v_latest.method,
      consent_notice_version = v_latest.notice_version
    where id = new.patient_id;
  else
    update public.patients set
      consent_current = false,
      consent_withdrawn_at = v_latest.created_at
      -- consent_signed_at left as the historical grant time on purpose.
    where id = new.patient_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_patient_consents_sync on public.patient_consents;
create trigger trg_patient_consents_sync
  after insert on public.patient_consents
  for each row execute function public.sync_patient_consent_state();

-- 5) Release gate: block transition to released unless current consent (flag on).
create or replace function public.enforce_consent_before_release()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_required boolean;
  v_consent boolean;
begin
  if new.status = 'released' and (old.status is null or old.status <> 'released') then
    select gate_required into v_required from public.consent_settings where id = true;
    if coalesce(v_required, false) then
      select p.consent_current into v_consent
      from public.visits v
      join public.patients p on p.id = v.patient_id
      where v.id = new.visit_id;

      if not coalesce(v_consent, false) then
        raise exception
          'cannot release test result: patient data-privacy consent is not on file (RA 10173)'
          using errcode = 'check_violation';
        -- NOTE: message intentionally contains the word "consent" so callers
        -- (finalise-consolidated, translatePgError) can distinguish it from the
        -- payment gate, which contains "payment_status".
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_test_requests_consent_gate on public.test_requests;
create trigger trg_test_requests_consent_gate
  before update on public.test_requests
  for each row execute function public.enforce_consent_before_release();

-- 6) Private bucket for signed-artifact storage (scanned forms / signature PNGs).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'consent-artifacts', 'consent-artifacts', false,
  5242880,                                          -- 5 MB cap
  array['application/pdf','image/png','image/jpeg']
)
on conflict (id) do nothing;
-- No `to authenticated` policies: service-role only, mirroring 0052_signatures_bucket.

-- 7) RLS for patient_consents: staff-only via existing staff RLS pattern;
--    writes happen through the service-role admin client from Server Actions.
alter table public.patient_consents enable row level security;
-- (Service-role bypasses RLS. Add a staff-read policy mirroring patients' if
--  staff RLS reads are needed; current detail page reads via admin client.)
```

- [ ] **Step 2: Apply to a local stack and verify it loads cleanly**

Run:
```bash
supabase start            # if not already running
supabase db reset         # applies all migrations including 0086
```
Expected: reset completes with no error; `0086_patient_consent.sql` applied.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0086_patient_consent.sql
git commit -m "feat(consent): migration — patient_consents, gate trigger, settings, bucket"
```

### Task 2: SQL smoke — prove the trigger behavior

**Files:**
- Create: `scripts/smoke/consent-gate.sql` (a hand-run smoke script)

- [ ] **Step 1: Write the smoke assertions**

```sql
-- Run against a local stack with at least one patient + visit + test_request.
-- Adjust the seed selects to your local data, or create throwaway rows.
begin;

-- Pick a patient with NO consent and a visit + ready_for_release test on a PAID visit.
-- (Create minimal rows if needed.)
with seed as (
  select tr.id as tr_id, v.patient_id, v.id as visit_id
  from public.test_requests tr
  join public.visits v on v.id = tr.visit_id
  where v.payment_status in ('paid','waived')
  limit 1
)
select * from seed \gset

-- A) Gate OFF (default): release should succeed even with no consent.
update public.consent_settings set gate_required = false where id = true;
update public.test_requests set status = 'released' where id = :'tr_id';
-- Expected: succeeds. Reset for next test:
update public.test_requests set status = 'ready_for_release' where id = :'tr_id';

-- B) Gate ON + no consent: release should RAISE check_violation w/ "consent".
update public.consent_settings set gate_required = true where id = true;
-- Expect ERROR on the next statement:
-- update public.test_requests set status = 'released' where id = :'tr_id';

-- C) Insert a grant → consent_current flips true.
insert into public.patient_consents
  (patient_id, event_type, method, notice_version, signatory, actor_kind)
values (:'patient_id', 'granted', 'paper_wet_signature', '2026-05-29', 'self', 'staff');
select consent_current from public.patients where id = :'patient_id';
-- Expected: t

-- D) Gate ON + consent present: release succeeds.
update public.test_requests set status = 'released' where id = :'tr_id';
-- Expected: succeeds.
update public.test_requests set status = 'ready_for_release' where id = :'tr_id';

-- E) Withdraw → consent_current flips false, re-blocks.
insert into public.patient_consents
  (patient_id, event_type, actor_kind, reason)
values (:'patient_id', 'withdrawn', 'staff', 'patient requested');
select consent_current, consent_withdrawn_at from public.patients where id = :'patient_id';
-- Expected: f, <timestamp>

-- F) Backfill bypass: INSERT a released row directly is allowed (gate is UPDATE-only).
--    (Demonstrated by design — INSERT does not fire the BEFORE UPDATE trigger.)

rollback;  -- leave no residue
```

- [ ] **Step 2: Run it and confirm A–E behave as commented**

Run: `psql "$SUPABASE_DB_URL_LOCAL" -v ON_ERROR_STOP=0 -f scripts/smoke/consent-gate.sql`
Expected: A succeeds, B errors with a message containing `consent`, C prints `t`, D succeeds, E prints `f`.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke/consent-gate.sql
git commit -m "test(consent): SQL smoke for gate + sync trigger"
```

### Task 3: Regenerate database types

**Files:**
- Modify: `src/types/database.ts` (generated)

- [ ] **Step 1: Regenerate**

Run: `npm run db:types`
Expected: `patient_consents`, `consent_settings`, and the new `patients` columns appear in `src/types/database.ts`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no consumers reference the new tables yet).

- [ ] **Step 3: Commit**

```bash
git add src/types/database.ts
git commit -m "chore(consent): regenerate database types for 0086"
```

---

## Phase 2 — Notice content + shared renderer

### Task 4: Notice module

**Files:**
- Create: `src/lib/consent/notice.ts`
- Create: `src/lib/consent/types.ts`

- [ ] **Step 1: Write the shared types**

```ts
// src/lib/consent/types.ts
export type ConsentMethod =
  | "paper_wet_signature"
  | "onscreen_signature"
  | "portal_acceptance";

export type ConsentSignatory = "self" | "guardian" | "representative";

export interface ConsentGrantInput {
  patientId: string;
  method: ConsentMethod;
  signatory: ConsentSignatory;
  signatoryName?: string | null;
  signatoryRelationship?: string | null;
  artifactPath?: string | null;
}
```

- [ ] **Step 2: Write the versioned notice**

```ts
// src/lib/consent/notice.ts
import { CONTACT, SITE } from "@/lib/marketing/site";

// Bump this date string whenever the notice wording materially changes.
// The agreed version is stored on every patient_consents grant row.
export const CURRENT_CONSENT_NOTICE_VERSION = "2026-05-29";

export interface ConsentNoticeSection {
  heading: string;
  body: string;
}

export const CONSENT_CONTROLLER = {
  name: SITE.name,
  address: `${CONTACT.address.line1}, ${CONTACT.address.line2}, ${CONTACT.address.city}`,
  mobile: CONTACT.phone.mobile,
  landline: CONTACT.phone.landline,
} as const;

export const CONSENT_NOTICE_SECTIONS: ConsentNoticeSection[] = [
  {
    heading: "1. Personal Information Controller",
    body: `${CONSENT_CONTROLLER.name}, ${CONSENT_CONTROLLER.address}. Mobile ${CONSENT_CONTROLLER.mobile}; Telephone ${CONSENT_CONTROLLER.landline}.`,
  },
  {
    heading: "2. Personal Data We Process",
    body: "Patient identification details; laboratory transaction information and released reports; and security metadata (timestamps, hashed client identifiers) for consent and access logging.",
  },
  {
    heading: "3. Purpose of Processing",
    body: "To verify your identity for secure release of test results; provide report access and status tracking; maintain service security, fraud prevention and audit records; and comply with legal, regulatory and medical-record obligations.",
  },
  {
    heading: "4. Data Sharing",
    body: "Your data may be processed by authorized service providers (secured cloud hosting, document storage, anti-bot protection) under confidentiality and data-protection controls. Your data is not sold to third parties.",
  },
  {
    heading: "5. Retention",
    body: "Data is retained only as long as necessary for medical, legal and operational purposes, and disposed of securely per DR Med retention schedules and legal requirements.",
  },
  {
    heading: "6. Your Rights & Withdrawal",
    body: "You have the right to be informed, to access, object, rectify, erase/block (where applicable), data portability, and to lodge a complaint. You may withdraw this consent at any time in person at reception; withdrawal does not affect processing already performed.",
  },
];

export const CONSENT_STATEMENT =
  "I have read and understood this notice and consent to DR Med Clinic and Laboratory processing my personal and health data for the purposes stated above.";
```

- [ ] **Step 3: Verify the `CONTACT`/`SITE` field names match**

Run: `grep -n "address\|phone\|name" src/lib/marketing/site.ts`
Expected: confirms `CONTACT.address.{line1,line2,city}`, `CONTACT.phone.{mobile,landline}`, `SITE.name`. If a name differs, fix `notice.ts` to match.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/lib/consent/notice.ts src/lib/consent/types.ts
git commit -m "feat(consent): versioned RA 10173 notice module + shared types"
```

### Task 5: Shared notice renderer component

**Files:**
- Create: `src/components/consent/consent-notice.tsx`

- [ ] **Step 1: Write the component** (server-safe — no `'use client'`, no hooks)

```tsx
// src/components/consent/consent-notice.tsx
import {
  CONSENT_NOTICE_SECTIONS,
  CONSENT_STATEMENT,
  CURRENT_CONSENT_NOTICE_VERSION,
} from "@/lib/consent/notice";

export function ConsentNotice({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "text-xs leading-relaxed" : "text-sm leading-relaxed"}>
      <div className="grid gap-2 sm:grid-cols-2">
        {CONSENT_NOTICE_SECTIONS.map((s) => (
          <p key={s.heading} className="text-[color:var(--color-brand-text-mid)]">
            <span className="font-semibold text-[color:var(--color-brand-navy)]">
              {s.heading}.
            </span>{" "}
            {s.body}
          </p>
        ))}
      </div>
      <p className="mt-3 rounded-r-lg border-l-4 border-[color:var(--color-brand-cyan)] bg-[color:var(--color-brand-bg)] px-4 py-3 text-[color:var(--color-brand-text)]">
        {CONSENT_STATEMENT}
      </p>
      <p className="mt-2 text-[10px] uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
        Notice version {CURRENT_CONSENT_NOTICE_VERSION}
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/components/consent/consent-notice.tsx
git commit -m "feat(consent): shared notice renderer component"
```

---

## Phase 3 — Consent Server Actions

### Task 6: Grant + withdraw actions

**Files:**
- Create: `src/lib/actions/consent/grant.ts`
- Create: `src/lib/actions/consent/withdraw.ts`
- Create: `src/lib/consent/gate.ts`

- [ ] **Step 1: Write the gate/state helpers**

```ts
// src/lib/consent/gate.ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export async function isConsentGateRequired(): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("consent_settings")
    .select("gate_required")
    .eq("id", true)
    .maybeSingle();
  return !!data?.gate_required;
}

export interface PatientConsentState {
  current: boolean;
  signedAt: string | null;
  withdrawnAt: string | null;
  method: string | null;
  noticeVersion: string | null;
}

export async function getPatientConsentState(
  patientId: string,
): Promise<PatientConsentState> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("patients")
    .select("consent_current, consent_signed_at, consent_withdrawn_at, consent_method, consent_notice_version")
    .eq("id", patientId)
    .maybeSingle();
  return {
    current: !!data?.consent_current,
    signedAt: data?.consent_signed_at ?? null,
    withdrawnAt: data?.consent_withdrawn_at ?? null,
    method: data?.consent_method ?? null,
    noticeVersion: data?.consent_notice_version ?? null,
  };
}
```

- [ ] **Step 2: Write the grant action**

```ts
// src/lib/actions/consent/grant.ts
"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { CURRENT_CONSENT_NOTICE_VERSION } from "@/lib/consent/notice";

const Schema = z
  .object({
    patientId: z.string().uuid(),
    method: z.enum(["paper_wet_signature", "onscreen_signature"]),
    signatory: z.enum(["self", "guardian", "representative"]),
    signatoryName: z.string().trim().min(1).optional(),
    signatoryRelationship: z.string().trim().min(1).optional(),
    artifactPath: z.string().trim().min(1).optional(),
  })
  .refine(
    (d) => d.signatory === "self" || (!!d.signatoryName && !!d.signatoryRelationship),
    { message: "Guardian/representative name and relationship are required.", path: ["signatoryName"] },
  );

export type ConsentActionResult = { ok: true } | { ok: false; error: string };

export async function recordConsentGrantAction(
  raw: z.input<typeof Schema>,
): Promise<ConsentActionResult> {
  const session = await requireActiveStaff();
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const d = parsed.data;

  const admin = createAdminClient();
  const { ip, ua } = await ipAndAgent();

  const { error } = await admin.from("patient_consents").insert({
    patient_id: d.patientId,
    event_type: "granted",
    method: d.method,
    notice_version: CURRENT_CONSENT_NOTICE_VERSION,
    signatory: d.signatory,
    signatory_name: d.signatoryName ?? null,
    signatory_relationship: d.signatoryRelationship ?? null,
    artifact_path: d.artifactPath ?? null,
    actor_kind: "staff",
    created_by: session.user_id,
    ip,
    user_agent: ua,
  });
  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: d.patientId,
    action: "consent.granted",
    resource_type: "patient",
    resource_id: d.patientId,
    metadata: { method: d.method, notice_version: CURRENT_CONSENT_NOTICE_VERSION, signatory: d.signatory },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/patients/${d.patientId}`);
  return { ok: true };
}
```

- [ ] **Step 3: Write the withdraw action**

```ts
// src/lib/actions/consent/withdraw.ts
"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import type { ConsentActionResult } from "./grant";

const Schema = z.object({
  patientId: z.string().uuid(),
  reason: z.string().trim().min(3, "Give a brief reason for the withdrawal."),
});

export async function withdrawConsentAction(
  raw: z.input<typeof Schema>,
): Promise<ConsentActionResult> {
  const session = await requireAdminStaff();
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const d = parsed.data;

  const admin = createAdminClient();
  const { ip, ua } = await ipAndAgent();

  const { error } = await admin.from("patient_consents").insert({
    patient_id: d.patientId,
    event_type: "withdrawn",
    actor_kind: "staff",
    created_by: session.user_id,
    reason: d.reason,
    ip,
    user_agent: ua,
  });
  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: d.patientId,
    action: "consent.withdrawn",
    resource_type: "patient",
    resource_id: d.patientId,
    metadata: { reason: d.reason },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/patients/${d.patientId}`);
  return { ok: true };
}
```

- [ ] **Step 4: Verify the auth-gate import names**

Run: `grep -n "export" src/lib/auth/require-staff.ts src/lib/auth/require-admin.ts`
Expected: confirms `requireActiveStaff` returns a session with `user_id`, and `requireAdminStaff` exists. Fix imports/field names to match if they differ.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/lib/consent/gate.ts src/lib/actions/consent/grant.ts src/lib/actions/consent/withdraw.ts
git commit -m "feat(consent): grant + withdraw server actions and gate/state helpers"
```

### Task 7: Artifact upload + view actions

**Files:**
- Create: `src/lib/actions/consent/artifact.ts`

- [ ] **Step 1: Write the actions** (upload accepts base64 from the pad / file input; view mints a 5-min signed URL and audits)

```ts
// src/lib/actions/consent/artifact.ts
"use server";

import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { requireActiveStaff } from "@/lib/auth/require-staff";

const UploadSchema = z.object({
  patientId: z.string().uuid(),
  // data URL: "data:image/png;base64,...." or PDF base64
  dataUrl: z.string().regex(/^data:(image\/png|image\/jpeg|application\/pdf);base64,/),
  ext: z.enum(["png", "jpg", "pdf"]),
});

export type UploadArtifactResult = { ok: true; path: string } | { ok: false; error: string };

export async function uploadConsentArtifactAction(
  raw: z.input<typeof UploadSchema>,
): Promise<UploadArtifactResult> {
  await requireActiveStaff();
  const parsed = UploadSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { patientId, dataUrl, ext } = parsed.data;

  const base64 = dataUrl.split(",")[1] ?? "";
  const bytes = Buffer.from(base64, "base64");
  const contentType =
    ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : "image/jpeg";
  // Path: <patient_id>/<random>.<ext> — random suffix avoids overwrite; Date/random
  // are forbidden in render scope but fine in a server action.
  const path = `${patientId}/${crypto.randomUUID()}.${ext}`;

  const admin = createAdminClient();
  const { error } = await admin.storage
    .from("consent-artifacts")
    .upload(path, bytes, { contentType, upsert: false });
  if (error) return { ok: false, error: "Could not store the signed form. Try again." };

  return { ok: true, path };
}

const ViewSchema = z.object({ patientId: z.string().uuid(), path: z.string().min(1) });
export type ViewArtifactResult = { ok: true; url: string } | { ok: false; error: string };

export async function viewConsentArtifactAction(
  raw: z.input<typeof ViewSchema>,
): Promise<ViewArtifactResult> {
  const session = await requireActiveStaff();
  const parsed = ViewSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { patientId, path } = parsed.data;

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("consent-artifacts")
    .createSignedUrl(path, 300);
  if (error || !data) return { ok: false, error: "Could not open the document." };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: patientId,
    action: "consent.artifact_viewed",
    resource_type: "patient",
    resource_id: patientId,
    metadata: { path },
    ip_address: ip,
    user_agent: ua,
  });
  return { ok: true, url: data.signedUrl };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/lib/actions/consent/artifact.ts
git commit -m "feat(consent): artifact upload + audited signed-url view actions"
```

---

## Phase 4 — Paper / wet-signature channel

### Task 8: Printable consent form route

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/patients/[id]/consent/print/page.tsx`

- [ ] **Step 1: Write the print page** (Server Component; loads patient, renders logo + notice + signature block; print-friendly)

```tsx
// src/app/(staff)/staff/(dashboard)/patients/[id]/consent/print/page.tsx
import Image from "next/image";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { ConsentNotice } from "@/components/consent/consent-notice";

export const dynamic = "force-dynamic";

export default async function ConsentPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireActiveStaff();
  const { id } = await params;
  const admin = createAdminClient();
  const { data: patient } = await admin
    .from("patients")
    .select("id, first_name, last_name, drm_id, birthdate")
    .eq("id", id)
    .maybeSingle();
  if (!patient) notFound();

  return (
    <div className="mx-auto max-w-2xl bg-white p-8 text-[color:var(--color-brand-text)] print:p-0">
      <div className="h-1.5 bg-[color:var(--color-brand-navy)]" />
      <div className="mt-4 flex items-center justify-between">
        <Image src="/logo.png" alt="DR Med Healthcare Inc." width={150} height={43} />
        <div className="text-right text-xs text-[color:var(--color-brand-text-soft)]">
          DRM-ID: <b>{patient.drm_id}</b>
        </div>
      </div>
      <h1 className="mt-4 text-xl font-extrabold text-[color:var(--color-brand-navy)]">
        Data Privacy Consent
      </h1>
      <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-steel)]">
        Republic Act 10173 — Data Privacy Act of 2012
      </p>
      <p className="mt-3 text-sm">
        Patient: <b>{patient.last_name}, {patient.first_name}</b>
      </p>

      <div className="mt-4">
        <ConsentNotice />
      </div>

      <div className="mt-10 flex gap-8">
        <div className="flex-1 border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase text-[color:var(--color-brand-text-soft)]">
          Signature over printed name
        </div>
        <div className="w-28 border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase text-[color:var(--color-brand-text-soft)]">
          Date
        </div>
      </div>

      <div className="mt-8 border-t border-dashed border-[color:var(--color-brand-bg-mid)] pt-3 text-[11px] text-[color:var(--color-brand-text-soft)]">
        <b className="text-[color:var(--color-brand-navy)]">
          If the patient is a minor or unable to sign
        </b>{" "}
        — completed by parent / guardian / authorized representative:
        <div className="mt-6 flex gap-8">
          <div className="flex-1 border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase">
            Guardian / representative — signature over printed name
          </div>
          <div className="flex-1 border-t border-[color:var(--color-brand-navy)] pt-1 text-[10px] uppercase">
            Relationship to patient
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Confirm the `patients` columns exist** (`drm_id`, `first_name`, `last_name`, `birthdate`)

Run: `grep -n "drm_id\|first_name\|last_name" src/app/\(staff\)/staff/\(dashboard\)/patients/\[id\]/page.tsx`
Expected: confirms these column names are used elsewhere. Adjust the select if names differ.

- [ ] **Step 3: Manual smoke** — start dev, open `/staff/patients/<id>/consent/print`, print preview.

Run: `npm run dev`
Expected: page renders with logo, notice, signature lines; browser print preview looks clean.

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add "src/app/(staff)/staff/(dashboard)/patients/[id]/consent/print/page.tsx"
git commit -m "feat(consent): printable RA 10173 consent form route"
```

### Task 9: Rewire the patient-form consent checkbox to record a grant

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/patients/patient-form.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/patients/actions.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/patients/[id]/edit-actions.ts`

- [ ] **Step 1: Read the current consent block + create/edit actions**

Run:
```bash
sed -n '40,90p' "src/app/(staff)/staff/(dashboard)/patients/actions.ts"
sed -n '55,100p' "src/app/(staff)/staff/(dashboard)/patients/[id]/edit-actions.ts"
sed -n '240,265p' "src/app/(staff)/staff/(dashboard)/patients/patient-form.tsx"
```
Expected: see `consent_given_today` handling and the checkbox markup.

- [ ] **Step 2: In `patient-form.tsx`, add signatory fields next to the checkbox**

Add, inside the consent fieldset (after the existing checkbox `<label>`), conditionally shown when the checkbox is ticked (controlled state already exists per `feedback_react19_form_state`):

```tsx
{/* signatory — only relevant when recording consent now */}
<div className="mt-2 grid gap-2 sm:grid-cols-3">
  <select
    name="consent_signatory"
    defaultValue="self"
    className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-sm"
  >
    <option value="self">Patient signed</option>
    <option value="guardian">Guardian signed</option>
    <option value="representative">Representative signed</option>
  </select>
  <input
    name="consent_signatory_name"
    placeholder="Signatory name (if not patient)"
    className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-sm"
  />
  <input
    name="consent_signatory_relationship"
    placeholder="Relationship"
    className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-sm"
  />
</div>
```

- [ ] **Step 3: In `actions.ts` (create), stop stamping `consent_signed_at`; insert a grant after the patient row is created**

Replace the current `consent_signed_at` derivation + insert field with: insert the patient WITHOUT `consent_signed_at`, then if `consent_given_today === "yes"` insert a `patient_consents` grant. Reuse the grant insert shape from `recordConsentGrantAction` (call it directly):

```ts
import { recordConsentGrantAction } from "@/lib/actions/consent/grant";
// ...after the patient insert returns `data.id`:
const consentGivenToday = formData.get("consent_given_today") === "yes"; // or parsed field
if (consentGivenToday) {
  const signatory = (formData.get("consent_signatory") as string) ?? "self";
  await recordConsentGrantAction({
    patientId: data.id,
    method: "paper_wet_signature",
    signatory: signatory as "self" | "guardian" | "representative",
    signatoryName: (formData.get("consent_signatory_name") as string) || undefined,
    signatoryRelationship: (formData.get("consent_signatory_relationship") as string) || undefined,
  });
}
```
Remove `consent_signed_at` from the patient `.insert(...)` object. Keep the existing audit metadata but change `consent_signed: !!consent_signed_at` to `consent_signed: consentGivenToday`.

- [ ] **Step 4: In `edit-actions.ts`, remove the direct `consent_signed_at` ratchet write; record a grant only when newly checked**

Replace the `consent_signed_at` ratchet block with: read current `patients.consent_current`; if `consent_given_today === "yes"` and not already current, call `recordConsentGrantAction({...})` as above. Never write `consent_signed_at` directly (the trigger owns it).

- [ ] **Step 5: Typecheck + manual smoke** — create a patient with consent ticked + guardian fields; confirm a `patient_consents` row and `consent_current = true`.

Run: `npm run typecheck` then create via UI; verify with:
`select event_type, method, signatory, signatory_name from patient_consents order by created_at desc limit 1;`
Expected: one `granted` / `paper_wet_signature` row with the signatory captured.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/patients/patient-form.tsx" "src/app/(staff)/staff/(dashboard)/patients/actions.ts" "src/app/(staff)/staff/(dashboard)/patients/[id]/edit-actions.ts"
git commit -m "feat(consent): record paper-signature grant from patient form checkbox"
```

### Task 9.1: Add a consent line to the printed receipt

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx`

- [ ] **Step 1: Read the receipt page to find where patient/visit info renders**

Run: `grep -n "patient\|Patient\|DRM\|portal" "src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx" | head`
Expected: locate the patient-info block.

- [ ] **Step 2: Fetch consent state and render one informational line**

Add near the patient block (the receipt already loads the visit with its patient):

```tsx
import { getPatientConsentState } from "@/lib/consent/gate";
// ...
const consent = await getPatientConsentState(visit.patient_id);
// in the patient-info JSX:
<p className="text-xs">
  Data privacy consent: {consent.current ? "on file" : "not on file"}
</p>
```
This is informational only — the receipt is **not** the consent instrument.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add "src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx"
git commit -m "feat(consent): show consent-on-file line on the printed receipt"
```

---

## Phase 5 — On-screen signature pad channel

### Task 10: Signature pad component

**Files:**
- Create: `src/components/consent/signature-pad.tsx`

- [ ] **Step 1: Write a dependency-free canvas pad** (`'use client'`)

```tsx
// src/components/consent/signature-pad.tsx
"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export function SignaturePad({
  onSave,
  saving,
}: {
  onSave: (pngDataUrl: string) => void;
  saving: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const { x, y } = pos(e);
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const { x, y } = pos(e);
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a2537";
    ctx.lineTo(x, y);
    ctx.stroke();
    setDirty(true);
  }
  function up() {
    drawing.current = false;
  }
  function clear() {
    const c = canvasRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setDirty(false);
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={520}
        height={140}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerLeave={up}
        className="w-full touch-none rounded-lg border-2 border-dashed border-[color:var(--color-brand-steel)] bg-white"
      />
      <div className="mt-2 flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={clear} disabled={saving}>
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saving}
          className="bg-[color:var(--color-brand-cyan)] text-white"
          onClick={() => onSave(canvasRef.current!.toDataURL("image/png"))}
        >
          {saving ? "Saving…" : "Save signature"}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Confirm the `Button` variant prop** (`variant="outline"`, `size="sm"`)

Run: `grep -n "variant\|size" src/components/ui/button.tsx | head`
Expected: confirms supported variants. Adjust if `outline` isn't a variant.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/components/consent/signature-pad.tsx
git commit -m "feat(consent): dependency-free canvas signature pad"
```

### Task 11: Consent panel on the patient detail page (pad capture + status + withdraw)

**Files:**
- Create: `src/app/(staff)/staff/(dashboard)/patients/[id]/consent/consent-panel.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/patients/[id]/page.tsx`

- [ ] **Step 1: Write the client panel** — shows current consent state, a "Capture signature" flow (signatory select + `SignaturePad` → `uploadConsentArtifactAction` then `recordConsentGrantAction`), a link to the print route, and (admin only) a withdraw button.

```tsx
// src/app/(staff)/staff/(dashboard)/patients/[id]/consent/consent-panel.tsx
"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SignaturePad } from "@/components/consent/signature-pad";
import { recordConsentGrantAction } from "@/lib/actions/consent/grant";
import { withdrawConsentAction } from "@/lib/actions/consent/withdraw";
import { uploadConsentArtifactAction } from "@/lib/actions/consent/artifact";

type Signatory = "self" | "guardian" | "representative";

export function ConsentPanel({
  patientId,
  current,
  signedAt,
  noticeVersion,
  isAdmin,
}: {
  patientId: string;
  current: boolean;
  signedAt: string | null;
  noticeVersion: string | null;
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<"idle" | "pad">("idle");
  const [signatory, setSignatory] = useState<Signatory>("self");
  const [name, setName] = useState("");
  const [rel, setRel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function saveSignature(png: string) {
    setErr(null);
    start(async () => {
      const up = await uploadConsentArtifactAction({ patientId, dataUrl: png, ext: "png" });
      if (!up.ok) return setErr(up.error);
      const res = await recordConsentGrantAction({
        patientId,
        method: "onscreen_signature",
        signatory,
        signatoryName: signatory === "self" ? undefined : name,
        signatoryRelationship: signatory === "self" ? undefined : rel,
        artifactPath: up.path,
      });
      if (!res.ok) return setErr(res.error);
      setMode("idle");
    });
  }

  function withdraw() {
    const reason = prompt("Reason for withdrawing consent?");
    if (!reason) return;
    setErr(null);
    start(async () => {
      const res = await withdrawConsentAction({ patientId, reason });
      if (!res.ok) setErr(res.error);
    });
  }

  return (
    <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] p-4">
      <h2 className="font-bold text-[color:var(--color-brand-navy)]">Data privacy consent</h2>
      <p className="mt-1 text-sm">
        {current ? (
          <span className="text-green-700">
            On file{signedAt ? ` — ${new Date(signedAt).toLocaleDateString("en-PH", { timeZone: "Asia/Manila" })}` : ""}
            {noticeVersion ? ` (notice ${noticeVersion})` : ""}
          </span>
        ) : (
          <span className="text-amber-700">Not on file</span>
        )}
      </p>

      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        <Link href={`/staff/patients/${patientId}/consent/print`} target="_blank">
          <Button type="button" variant="outline" size="sm">Print form</Button>
        </Link>
        {mode === "idle" && (
          <Button type="button" size="sm" onClick={() => setMode("pad")} disabled={pending}>
            Capture signature
          </Button>
        )}
        {current && isAdmin && (
          <Button type="button" variant="outline" size="sm" onClick={withdraw} disabled={pending}>
            Withdraw consent
          </Button>
        )}
      </div>

      {mode === "pad" && (
        <div className="mt-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <select value={signatory} onChange={(e) => setSignatory(e.target.value as Signatory)}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-sm">
              <option value="self">Patient</option>
              <option value="guardian">Guardian</option>
              <option value="representative">Representative</option>
            </select>
            {signatory !== "self" && (
              <>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Signatory name"
                  className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-sm" />
                <input value={rel} onChange={(e) => setRel(e.target.value)} placeholder="Relationship"
                  className="rounded-md border border-[color:var(--color-brand-bg-mid)] px-2 py-1 text-sm" />
              </>
            )}
          </div>
          <SignaturePad onSave={saveSignature} saving={pending} />
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Mount it on the patient detail page**

In `[id]/page.tsx`, import `getPatientConsentState` + `ConsentPanel`, fetch state, determine `isAdmin` from the staff session/role already loaded on the page, and render `<ConsentPanel ... />` where the current consent badge is shown (replace the read-only badge around `page.tsx:169-173`).

```tsx
import { getPatientConsentState } from "@/lib/consent/gate";
import { ConsentPanel } from "./consent/consent-panel";
// ...
const consent = await getPatientConsentState(id);
// in JSX:
<ConsentPanel
  patientId={id}
  current={consent.current}
  signedAt={consent.signedAt}
  noticeVersion={consent.noticeVersion}
  isAdmin={/* existing role check, e.g. */ session.role === "admin"}
/>
```

- [ ] **Step 3: Verify the page's existing session/role variable name**

Run: `grep -n "requireActiveStaff\|require\|role\|session" "src/app/(staff)/staff/(dashboard)/patients/[id]/page.tsx" | head`
Expected: confirms how the page gets the staff session/role; wire `isAdmin` accordingly.

- [ ] **Step 4: Typecheck + manual smoke** — capture an on-screen signature; verify `onscreen_signature` grant + artifact row in storage; withdraw as admin re-flips `consent_current`.

Run: `npm run typecheck` then exercise via UI.
Expected: grant + artifact stored; withdraw works for admin only.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/patients/[id]/consent/consent-panel.tsx" "src/app/(staff)/staff/(dashboard)/patients/[id]/page.tsx"
git commit -m "feat(consent): patient-detail consent panel — pad capture, status, withdraw"
```

---

## Phase 6 — Portal digital-acceptance channel

### Task 12: Portal acceptance action

**Files:**
- Create: `src/lib/actions/consent/portal-accept.ts`

- [ ] **Step 1: Write the action** (patient session, not staff)

```ts
// src/lib/actions/consent/portal-accept.ts
"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";
import { CURRENT_CONSENT_NOTICE_VERSION } from "@/lib/consent/notice";

const Schema = z.object({
  signatory: z.enum(["self", "guardian", "representative"]).default("self"),
  signatoryName: z.string().trim().min(1).optional(),
  signatoryRelationship: z.string().trim().min(1).optional(),
});

export type ConsentActionResult = { ok: true } | { ok: false; error: string };

export async function acceptConsentPortalAction(
  raw: z.input<typeof Schema>,
): Promise<ConsentActionResult> {
  const session = await getPatientSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const d = parsed.data;
  if (d.signatory !== "self" && (!d.signatoryName || !d.signatoryRelationship)) {
    return { ok: false, error: "Guardian/representative name and relationship are required." };
  }

  const admin = createAdminClient();
  const { ip, ua } = await ipAndAgent();

  const { error } = await admin.from("patient_consents").insert({
    patient_id: session.patient_id,
    event_type: "granted",
    method: "portal_acceptance",
    notice_version: CURRENT_CONSENT_NOTICE_VERSION,
    signatory: d.signatory,
    signatory_name: d.signatoryName ?? null,
    signatory_relationship: d.signatoryRelationship ?? null,
    actor_kind: "patient",
    ip,
    user_agent: ua,
  });
  if (error) return { ok: false, error: "Could not record your consent. Try again." };

  await audit({
    actor_id: null,
    actor_type: "patient",
    patient_id: session.patient_id,
    action: "consent.granted",
    resource_type: "patient",
    resource_id: session.patient_id,
    metadata: { method: "portal_acceptance", notice_version: CURRENT_CONSENT_NOTICE_VERSION, signatory: d.signatory },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/portal");
  return { ok: true };
}
```

- [ ] **Step 2: Confirm patient-session field name** (`patient_id` vs `patientId`)

Run: `grep -n "patient_id\|patientId\|interface\|type" src/lib/auth/patient-session-cookies.ts | head`
Expected: confirms the session shape; fix `session.patient_id` if it differs.

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/lib/actions/consent/portal-accept.ts
git commit -m "feat(consent): portal acceptance server action"
```

### Task 13: Portal blocking acceptance gate

**Files:**
- Create: `src/app/(patient)/portal/(authenticated)/consent/consent-gate.tsx`
- Modify: `src/app/(patient)/portal/(authenticated)/layout.tsx`

- [ ] **Step 1: Read the authenticated portal layout to find the mount point**

Run: `sed -n '1,80p' "src/app/(patient)/portal/(authenticated)/layout.tsx"`
Expected: see how the layout loads the patient + renders children.

- [ ] **Step 2: Write the client gate UI**

```tsx
// src/app/(patient)/portal/(authenticated)/consent/consent-gate.tsx
"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConsentNotice } from "@/components/consent/consent-notice";
import { acceptConsentPortalAction } from "@/lib/actions/consent/portal-accept";

export function PortalConsentGate() {
  const [pending, start] = useTransition();
  const [agreed, setAgreed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[color:var(--color-brand-bg)]/95 p-4">
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-5 shadow-xl">
        <h1 className="text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Data Privacy Consent
        </h1>
        <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-steel)]">
          RA 10173 — required before viewing your results
        </p>
        <div className="mt-3 max-h-[50vh] overflow-y-auto">
          <ConsentNotice compact />
        </div>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1" />
          <span>I have read and understood this notice and consent to the processing of my personal and health data.</span>
        </label>
        <Button
          type="button"
          disabled={!agreed || pending}
          className="mt-3 w-full bg-[color:var(--color-brand-navy)] text-white"
          onClick={() =>
            start(async () => {
              setErr(null);
              const res = await acceptConsentPortalAction({ signatory: "self" });
              if (!res.ok) setErr(res.error);
              // on success the layout re-renders without the gate (revalidatePath)
            })
          }
        >
          {pending ? "Recording…" : "I Agree"}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Mount the gate in the authenticated layout when consent is missing**

In `layout.tsx`, after loading the patient session, fetch consent state and render the gate over the children when not current:

```tsx
import { getPatientConsentState } from "@/lib/consent/gate";
import { PortalConsentGate } from "./consent/consent-gate";
// ...inside the component, after resolving the session's patient_id:
const consent = await getPatientConsentState(session.patient_id);
// in JSX, render children always but overlay the gate when needed:
{!consent.current && <PortalConsentGate />}
```
(Overlay is `fixed inset-0 z-50`, so it blocks interaction until accepted. After acceptance, `revalidatePath("/portal")` drops it.)

- [ ] **Step 4: Typecheck + manual smoke** — log into the portal as a consent-less patient; the gate blocks; clicking "I Agree" records a `portal_acceptance` grant and reveals results.

Run: `npm run typecheck` then exercise via the portal (use the local UI smoke recipe).
Expected: gate appears, acceptance recorded, results visible.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(patient)/portal/(authenticated)/consent/consent-gate.tsx" "src/app/(patient)/portal/(authenticated)/layout.tsx"
git commit -m "feat(consent): portal blocking acceptance gate"
```

---

## Phase 7 — Release-path integration

### Task 14: Distinguish the consent gate in error translation + finalise

**Files:**
- Modify: `src/lib/accounting/pg-errors.ts`
- Modify: `src/lib/actions/results/finalise-consolidated.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts`

- [ ] **Step 1: In `pg-errors.ts`, branch the `23514` case on the message**

Replace the existing `case "23514":` body with:

```ts
    case "23514": {
      const m = err.message ?? "";
      if (/consent/i.test(m)) {
        return "Patient data-privacy consent is not on file — capture consent before releasing.";
      }
      if (/payment_status/i.test(m)) {
        return "Visit must be paid before results can be released.";
      }
      return "Invalid value: that combination is not allowed by the schema.";
    }
```

- [ ] **Step 2: In `finalise-consolidated.ts`, treat the consent gate as deferred too**

Replace the `isPaymentGate` block (around lines 113-121) with:

```ts
  let releaseDeferred = false;
  let deferredReason: "payment" | "consent" | null = null;
  if (relErr) {
    const code = (relErr as { code?: string }).code;
    const msg = relErr.message ?? "";
    if (code === "23514" && /payment_status/i.test(msg)) {
      releaseDeferred = true;
      deferredReason = "payment";
    } else if (code === "23514" && /consent/i.test(msg)) {
      releaseDeferred = true;
      deferredReason = "consent";
    } else {
      return { ok: false, error: translatePgError(relErr) };
    }
  }
```
Then include `deferred_reason: deferredReason` in the `result.finalised` audit metadata, and keep emitting `result.released` only when `!releaseDeferred`.

- [ ] **Step 3: In `visits/[id]/actions.ts`, ensure `releaseTestAction` returns the translated consent error**

The action already returns `{ ok: false, error: error.message }` on failure. Change it to `translatePgError(error)` so the consent (and payment) messages are user-friendly:

```ts
import { translatePgError } from "@/lib/accounting/pg-errors";
// ...
if (error) {
  return { ok: false, error: translatePgError(error) };
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
```bash
git add src/lib/accounting/pg-errors.ts src/lib/actions/results/finalise-consolidated.ts "src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts"
git commit -m "feat(consent): treat consent gate as deferred release; user-facing error text"
```

### Task 15: Release button — disable / soft-warn on missing consent

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/release-button.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx`

- [ ] **Step 1: Add `consentOnFile` + `gateRequired` props and gate the button**

Edit `release-button.tsx`:
- Extend `Props` with `consentOnFile: boolean;` and `gateRequired: boolean;`.
- Compute `const blockedForConsent = gateRequired && !consentOnFile;`.
- `disabled={pending || !paid || blockedForConsent}` on both the select and the Button.
- Title/tooltip: when `blockedForConsent`, `"Patient consent not on file — capture consent first"`.
- When `gateRequired === false && !consentOnFile`, render a small amber note "Consent not on file" beside the button (soft warning, does not disable — matches the UAT-off behavior in the spec).

```tsx
interface Props {
  testRequestId: string;
  visitId: string;
  paid: boolean;
  preferredMedium: ReleaseMedium | null;
  consentOnFile: boolean;
  gateRequired: boolean;
}
// ...
const blockedForConsent = gateRequired && !consentOnFile;
const disabled = pending || !paid || blockedForConsent;
const reason = !paid
  ? "Visit must be paid before release"
  : blockedForConsent
    ? "Patient consent not on file — capture consent first"
    : undefined;
// apply `disabled` + `title={reason}` to select and Button; and:
{!consentOnFile && !gateRequired && (
  <span className="text-[11px] text-amber-600">Consent not on file</span>
)}
```

- [ ] **Step 2: In `visits/[id]/page.tsx`, fetch consent + gate state and pass the props**

```tsx
import { isConsentGateRequired, getPatientConsentState } from "@/lib/consent/gate";
// ...the page already loads the visit (with patient_id). Add:
const [gateRequired, consent] = await Promise.all([
  isConsentGateRequired(),
  getPatientConsentState(visit.patient_id),
]);
// pass to each <ReleaseButton ... consentOnFile={consent.current} gateRequired={gateRequired} />
```

- [ ] **Step 3: Confirm the visit query exposes `patient_id`**

Run: `grep -n "patient_id\|patient" "src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx" | head`
Expected: `visit.patient_id` available; if the page uses a different variable, adjust.

- [ ] **Step 4: Typecheck + manual smoke** — with gate ON and no consent, the Release button is disabled with the tooltip; with gate OFF, it shows the amber note but stays clickable; clicking yields the friendly consent error if the DB still blocks.

Run: `npm run typecheck` then toggle `consent_settings.gate_required` and exercise.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/[id]/release-button.tsx" "src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx"
git commit -m "feat(consent): release button respects consent gate (hard when on, soft when off)"
```

---

## Phase 8 — Verification & wrap-up

### Task 16: Full smoke + lint + types

- [ ] **Step 1: Re-run the SQL smoke** (Task 2) end-to-end on a fresh `supabase db reset`. Expected: A–E pass.

- [ ] **Step 2: Playwright UI smoke** — per `feedback_local_ui_smoke_recipe.md`, script: (a) reception ticks consent on patient create → grant row; (b) on-screen signature capture; (c) portal acceptance unblocks results; (d) admin withdraw re-blocks; (e) with gate ON, release disabled until consent. Save under the existing smoke location.

- [ ] **Step 3: Lint + typecheck**

Run: `npm run lint && npm run typecheck`
Expected: both PASS.

- [ ] **Step 4: Commit any smoke script + final docs note**

```bash
git add -A
git commit -m "test(consent): UI smoke for all three capture channels + gate"
```

### Task 17: Open PR

- [ ] **Step 1: Push + PR**

```bash
git push -u origin feat/patient-consent-form
gh pr create --title "feat: patient data-privacy consent form + release gate (RA 10173)" \
  --body "Implements docs/superpowers/specs/2026-05-29-patient-consent-form-design.md. Gate ships behind consent_settings.gate_required (default off for UAT). Migration 0086."
```

- [ ] **Step 2: After merge** — apply `0086` to staging then production per `CLAUDE.md` schema order-of-operations; run `npm run db:types:remote`; decide when to flip `gate_required = true` (after reception is briefed).

---

## Deployment / rollout notes

- **Gate stays OFF** (`consent_settings.gate_required = false`) through partner UAT. Capture machinery + audit trail go live immediately; nothing blocks releases. Flip to `true` (SQL `update consent_settings set gate_required = true where id = true;`) before broad launch, after briefing reception.
- **No backfill** for the 4,297 legacy patients — they clear naturally on next visit (paper/on-screen capture at reception, or portal acceptance on next login).
- **Historical-data project safety:** backfilled released results use INSERT, which does not fire the BEFORE UPDATE gate — confirmed by Task 2 case F.
- **MFA gate** is also currently off (`feedback_re_enable_mfa_gate.md`) — flip both before broad launch.
```
