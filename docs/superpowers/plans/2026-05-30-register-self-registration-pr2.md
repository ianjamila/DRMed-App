# Public `/register` Self-Registration (PR 2 / Feature C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/register` page where a prospective patient self-registers (details + RA-10173 consent), gets a DRM-ID emailed (and shown on-screen for a new registrant), with enumeration-safe handling of dedup matches — plus a staff "Registration link" QR/copy button.

**Architecture:** A new `(marketing)/register` route (server page + client form + server action) reusing PR1's shared `resolvePatient` (silent dedup→insert) and the existing `sendEmail` (Resend) + `patient_consents` infrastructure. New registrants record RA-10173 consent via a new `method:'self_registration'` value (one additive migration); dedup matches email the DRM-ID to the on-file address without revealing it on screen. The QR is rendered with PR1's `qr-code.tsx`.

**Tech Stack:** Next.js 16 (App Router, Server Actions), React 19, Supabase (service-role admin client), Zod v4, Resend email, vitest, `qrcode.react`.

**Spec:** `docs/superpowers/specs/2026-05-30-staff-appointment-intake-design.md` §6 (Feature C) + §10.2/§10.3 (settled).

> **Branch:** Create off **`feat/staff-new-appointment`** (PR #35), not `main` — this plan imports `resolvePatient` (`src/lib/patients/resolve.ts`), `qr-code.tsx`, and edits the PR1-modified appointments header, none of which are on `main` yet. **After PR #35 merges, rebase this branch onto updated `main`.** Suggested branch name: `feat/patient-self-registration`.

---

## File Structure

**Create:**
- `supabase/migrations/0089_patient_consent_self_registration.sql` — widen the `patient_consents.method` CHECK to allow `'self_registration'`. Additive/safe; no RLS/audit changes (no new table).
- `src/lib/validations/registration.ts` — `RegistrationSchema` (+ `RegistrationInput`/`RegistrationData` types).
- `src/lib/validations/registration.test.ts` — unit tests.
- `src/app/(marketing)/register/page.tsx` — server component (renders the form).
- `src/app/(marketing)/register/register-form.tsx` — client form + success screen.
- `src/app/(marketing)/register/actions.ts` — `submitRegistrationAction`.
- `src/components/staff/registration-link-button.tsx` — client: "Registration link" button → QR (`qr-code.tsx`) + copy.

**Modify:**
- `src/lib/consent/types.ts` — add `'self_registration'` to `ConsentMethod`.
- `src/lib/rate-limit/check.ts` — add `'patient_registration'` to `RateLimitBucket` + a `RATE_LIMITS` entry.
- `src/app/(staff)/staff/(dashboard)/appointments/page.tsx` — build a `registerUrl` and render `<RegistrationLinkButton>` in the header next to `<NewAppointmentSheet>`.

> **No `database.ts` regen needed for content:** a CHECK-constraint change does not alter generated column types (`method` stays `string`). Run `npm run db:types` per the migration workflow, but expect a no-op diff. The `ConsentMethod` union is hand-maintained in `src/lib/consent/types.ts`.

---

## Task 1: Migration — allow `self_registration` consent method

**Files:**
- Create: `supabase/migrations/0089_patient_consent_self_registration.sql`
- Modify: `src/lib/consent/types.ts`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0089_patient_consent_self_registration.sql`:
```sql
-- Allow the public /register self-registration flow to record RA 10173 consent
-- via a new patient_consents.method value. Additive + safe: only widens the
-- method CHECK constraint. No RLS/audit changes (no new table); the existing
-- sync_patient_consent_state() trigger already denormalises method/version onto
-- patients on insert. The pc_grant_fields CHECK still requires method +
-- notice_version + signatory for a 'granted' row, which self_registration supplies.

-- Drop the existing method CHECK by definition (its auto-generated name is
-- patient_consents_method_check, but match by definition to be name-agnostic).
do $$
declare c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'public.patient_consents'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%method%in (%';
  if c is not null then
    execute format('alter table public.patient_consents drop constraint %I', c);
  end if;
end $$;

alter table public.patient_consents
  add constraint patient_consents_method_check
    check (method in (
      'paper_wet_signature',
      'onscreen_signature',
      'portal_acceptance',
      'self_registration'
    ));
```

- [ ] **Step 2: Apply + verify against the local stack**

Run:
```bash
supabase migration up
```
Expected: applies `0089` cleanly. Then verify the constraint accepts the new value (replace `<PID>` with any existing local patient id):
```bash
# Should succeed now (it would have failed before 0089):
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "insert into patient_consents (patient_id, event_type, method, notice_version, signatory, actor_kind) values ('<PID>','granted','self_registration','2026-05-29','self','patient') returning id;"
# Clean up the probe row:
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "delete from patient_consents where method='self_registration';"
```
Expected: insert returns an id (constraint allows it); delete removes the probe.
(If `psql` is unavailable, use the local REST API with the service key, or Supabase Studio at `http://127.0.0.1:54323`.)

- [ ] **Step 3: Regenerate types (expect no diff)**

Run:
```bash
npm run db:types
```
Expected: `git diff src/types/database.ts` shows nothing (CHECK changes don't affect generated types). If it shows unrelated drift from other migrations, discard it — out of scope.

- [ ] **Step 4: Extend the `ConsentMethod` union**

In `src/lib/consent/types.ts`, change:
```ts
export type ConsentMethod =
  | "paper_wet_signature"
  | "onscreen_signature"
  | "portal_acceptance";
```
to:
```ts
export type ConsentMethod =
  | "paper_wet_signature"
  | "onscreen_signature"
  | "portal_acceptance"
  | "self_registration";
```

- [ ] **Step 5: Typecheck + commit**

Run:
```bash
npm run typecheck
```
Expected: PASS. Then:
```bash
git add supabase/migrations/0089_patient_consent_self_registration.sql src/lib/consent/types.ts
git commit -m "feat(consent): allow self_registration consent method (migration 0089)"
```

---

## Task 2: `RegistrationSchema`

**Files:**
- Create: `src/lib/validations/registration.ts`
- Test: `src/lib/validations/registration.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/validations/registration.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RegistrationSchema } from "./registration";

const base = {
  first_name: "Maria",
  last_name: "Santos",
  middle_name: "",
  birthdate: "1991-04-12",
  sex: "female",
  phone: "09171234567",
  email: "maria@example.com",
  address: "",
  data_privacy_consent: "on",
  marketing_consent: "off",
};

describe("RegistrationSchema", () => {
  it("accepts a complete registration with consent", () => {
    const r = RegistrationSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("requires a valid email (DRM-ID is sent there + it's the dedup key)", () => {
    expect(RegistrationSchema.safeParse({ ...base, email: "" }).success).toBe(false);
    expect(RegistrationSchema.safeParse({ ...base, email: "nope" }).success).toBe(false);
  });

  it("requires data-privacy consent to be accepted", () => {
    expect(RegistrationSchema.safeParse({ ...base, data_privacy_consent: "" }).success).toBe(false);
    expect(RegistrationSchema.safeParse({ ...base, data_privacy_consent: "off" }).success).toBe(false);
  });

  it("requires first/last name, birthdate format, and phone", () => {
    expect(RegistrationSchema.safeParse({ ...base, first_name: "" }).success).toBe(false);
    expect(RegistrationSchema.safeParse({ ...base, birthdate: "12/04/1991" }).success).toBe(false);
    expect(RegistrationSchema.safeParse({ ...base, phone: "" }).success).toBe(false);
  });

  it("normalises optional blanks to null and parses consent flags to booleans", () => {
    const r = RegistrationSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.middle_name).toBeNull();
      expect(r.data.address).toBeNull();
      expect(r.data.data_privacy_consent).toBe(true);
      expect(r.data.marketing_consent).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
npx vitest run src/lib/validations/registration.test.ts
```
Expected: FAIL — `Cannot find module './registration'`.

- [ ] **Step 3: Implement `registration.ts`**

Create `src/lib/validations/registration.ts`:
```ts
import { z } from "zod";

const optionalText = (max: number) =>
  z.string().trim().max(max).or(z.literal("")).nullish().transform((v) => (v == null || v === "" ? null : v));

export const RegistrationSchema = z.object({
  first_name: z.string().trim().min(1, "First name is required.").max(80),
  last_name: z.string().trim().min(1, "Last name is required.").max(80),
  middle_name: optionalText(80),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Birthdate must be YYYY-MM-DD."),
  sex: z.union([z.literal(""), z.enum(["male", "female"])]).transform((v) => (v === "" ? null : v)).nullable(),
  phone: z.string().trim().min(7, "Phone is required.").max(40),
  // Email is required: it's the DRM-ID delivery channel AND the dedup key.
  email: z.string().trim().email("A valid email is required — we send your DRM-ID there.").max(160),
  address: optionalText(200),
  data_privacy_consent: z
    .union([z.literal("on"), z.literal("true"), z.literal("off"), z.literal(""), z.null(), z.undefined()])
    .transform((v) => v === "on" || v === "true")
    .refine((v) => v, "Please accept the data-privacy consent to register."),
  marketing_consent: z
    .union([z.literal("on"), z.literal("off"), z.literal(""), z.null(), z.undefined()])
    .transform((v) => v === "on"),
});

export type RegistrationInput = z.input<typeof RegistrationSchema>;
export type RegistrationData = z.output<typeof RegistrationSchema>;
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
npx vitest run src/lib/validations/registration.test.ts
```
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validations/registration.ts src/lib/validations/registration.test.ts
git commit -m "feat(validations): RegistrationSchema for /register + tests"
```

---

## Task 3: Rate-limit bucket

**Files:**
- Modify: `src/lib/rate-limit/check.ts`

- [ ] **Step 1: Add the bucket to the union**

In `src/lib/rate-limit/check.ts`, change the `RateLimitBucket` union to add the new bucket (after `appointment_cancel`):
```ts
export type RateLimitBucket =
  | "patient_pin"
  | "public_booking"
  | "contact_form"
  | "newsletter_signup"
  | "patient_lookup"
  | "staff_login"
  | "newsletter_resubscribe"
  | "appointment_cancel"
  | "patient_registration";
```

- [ ] **Step 2: Add the budget**

In the `RATE_LIMITS` object (after the `appointment_cancel` entry), add:
```ts
  // Public self-registration. A write that creates a patient row + emails a
  // DRM-ID; 5/hour per IP matches contact_form / newsletter_signup.
  patient_registration: { windowSec: 60 * 60, max: 5 },
```

- [ ] **Step 3: Typecheck + commit**

Run:
```bash
npm run typecheck
```
Expected: PASS. Then:
```bash
git add src/lib/rate-limit/check.ts
git commit -m "feat(rate-limit): add patient_registration bucket"
```

---

## Task 4: `submitRegistrationAction`

**Files:**
- Create: `src/app/(marketing)/register/actions.ts`

This is integration code (DB + email); it's verified by typecheck/build + the Task 7 live smoke (no unit test — the pure pieces, `RegistrationSchema` and `resolvePatient`, are already unit-tested).

- [ ] **Step 1: Implement the action**

Create `src/app/(marketing)/register/actions.ts`:
```ts
"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import { resolvePatient } from "@/lib/patients/resolve";
import { sendEmail } from "@/lib/notifications/email";
import { CURRENT_CONSENT_NOTICE_VERSION } from "@/lib/consent/notice";
import { RegistrationSchema } from "@/lib/validations/registration";

export type RegistrationResult =
  | { ok: true; matched: false; drm_id: string }
  | { ok: true; matched: true }
  | { ok: false; error: string };

// Honeypot trip looks like a generic success so bots get no signal.
const HONEYPOT_OK: RegistrationResult = { ok: true, matched: true };

export async function submitRegistrationAction(
  _prev: RegistrationResult | null,
  formData: FormData,
): Promise<RegistrationResult> {
  if ((formData.get("website") ?? "") !== "") return HONEYPOT_OK;

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  if (ip) {
    const limit = await checkRateLimit({ bucket: "patient_registration", identifier: ip, ...RATE_LIMITS.patient_registration });
    if (!limit.allowed) {
      return { ok: false, error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes, or visit reception.` };
    }
  }

  const parsed = RegistrationSchema.safeParse({
    first_name: formData.get("first_name"),
    last_name: formData.get("last_name"),
    middle_name: formData.get("middle_name") ?? "",
    birthdate: formData.get("birthdate"),
    sex: formData.get("sex") ?? "",
    phone: formData.get("phone"),
    email: formData.get("email"),
    address: formData.get("address") ?? "",
    data_privacy_consent: formData.get("data_privacy_consent") ?? "",
    marketing_consent: formData.get("marketing_consent") ?? "off",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const d = parsed.data;

  const admin = createAdminClient();
  const res = await resolvePatient(admin, {
    first_name: d.first_name,
    last_name: d.last_name,
    middle_name: d.middle_name,
    birthdate: d.birthdate,
    sex: d.sex,
    phone: d.phone,
    email: d.email,
    address: d.address,
  });
  if (!res.ok) return { ok: false, error: res.error };

  // Dedup match: do NOT reveal the DRM-ID on a public page (enumeration safety).
  // Email it to the on-file address — which equals the supplied email, since the
  // dedup matched on lower(email)+last_name+birthdate. No consent write: a public
  // form must not re-affirm an existing patient's consent state.
  if (res.reused) {
    await sendEmail({
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
      metadata: { drm_id: res.drm_id, via: "register" },
      ip_address: ip,
      user_agent: ua,
    });
    return { ok: true, matched: true };
  }

  // New registrant: record the RA-10173 consent the form required (the
  // sync_patient_consent_state trigger flips patients.consent_current = true),
  // then email + show the DRM-ID.
  await admin.from("patient_consents").insert({
    patient_id: res.id,
    event_type: "granted",
    method: "self_registration",
    notice_version: CURRENT_CONSENT_NOTICE_VERSION,
    signatory: "self",
    actor_kind: "patient",
    ip,
    user_agent: ua,
  });

  // Optional marketing opt-in. Mirror the schedule form's subscribe: insert a
  // fresh subscriber, or re-consent a previously-unsubscribed one, preserving
  // first-touch `source`.
  if (d.marketing_consent) {
    const lower = d.email.trim().toLowerCase();
    const { data: existing } = await admin.from("subscribers").select("id, unsubscribed_at").eq("email", lower).maybeSingle();
    if (!existing) {
      await admin.from("subscribers").insert({ email: lower, source: "register", consent_ip: ip });
    } else if (existing.unsubscribed_at !== null) {
      await admin.from("subscribers").update({ unsubscribed_at: null, consent_at: new Date().toISOString(), consent_ip: ip }).eq("id", existing.id);
    }
  }

  await sendEmail({
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
    metadata: { drm_id: res.drm_id, via: "register", consent_recorded: true, marketing_consent: d.marketing_consent },
    ip_address: ip,
    user_agent: ua,
  });

  return { ok: true, matched: false, drm_id: res.drm_id };
}
```

- [ ] **Step 2: Typecheck + commit**

Run:
```bash
npm run typecheck
```
Expected: PASS. (Confirm the `subscribers` table has `source`, `consent_ip`, `consent_at`, `unsubscribed_at` columns in `src/types/database.ts` — they're used identically by `schedule/actions.ts`.) Then:
```bash
git add "src/app/(marketing)/register/actions.ts"
git commit -m "feat(register): submitRegistrationAction (resolve + consent + email + audit)"
```

---

## Task 5: `/register` page + client form

**Files:**
- Create: `src/app/(marketing)/register/page.tsx`
- Create: `src/app/(marketing)/register/register-form.tsx`

- [ ] **Step 1: Implement the server page**

Create `src/app/(marketing)/register/page.tsx`:
```tsx
import type { Metadata } from "next";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = {
  title: "Register — drmed.ph",
  description: "Pre-register at DRMed Clinic & Laboratory and get your DRM-ID.",
};

export default function RegisterPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 lg:py-14">
      <p className="text-sm font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">Pre-register</p>
      <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Get your DRM-ID
      </h1>
      <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
        Fill this once and we&apos;ll email your DRM-ID — skip the counter form on arrival. Booking is separate; to book a
        visit, use <a className="underline" href="/schedule">Schedule</a>.
      </p>
      <div className="mt-6">
        <RegisterForm />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Implement the client form**

Create `src/app/(marketing)/register/register-form.tsx`. Inputs are **controlled** (React 19 resets uncontrolled fields on a Server-Action re-render):
```tsx
"use client";

import * as React from "react";
import { useActionState } from "react";
import { submitRegistrationAction, type RegistrationResult } from "./actions";

const INPUT = "w-full rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm";

export function RegisterForm() {
  const [state, formAction, pending] = useActionState<RegistrationResult | null, FormData>(
    submitRegistrationAction,
    null,
  );

  const [f, setF] = React.useState({
    first_name: "",
    last_name: "",
    middle_name: "",
    birthdate: "",
    sex: "" as "" | "male" | "female",
    phone: "",
    email: "",
    address: "",
    data_privacy_consent: false,
    marketing_consent: false,
  });

  if (state?.ok && state.matched === false) {
    return (
      <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-6 text-center">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-extrabold text-emerald-900">You&apos;re registered.</h2>
        <p className="mt-3 text-sm text-emerald-900">Your DRM-ID</p>
        <p className="font-mono text-2xl font-bold text-emerald-900">{state.drm_id}</p>
        <p className="mt-3 text-sm text-emerald-800">
          We&apos;ve emailed it to you too. Show this at the clinic — reception verifies your identity at the counter.
        </p>
      </div>
    );
  }
  if (state?.ok && state.matched === true) {
    return (
      <div className="rounded-xl border border-sky-300 bg-sky-50 p-6 text-center">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-extrabold text-sky-900">We found your record.</h2>
        <p className="mt-3 text-sm text-sky-900">
          It looks like you&apos;re already in our system — we&apos;ve emailed your DRM-ID to the address on file. Check your inbox,
          or visit reception if you don&apos;t receive it.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {/* Honeypot — hidden from humans, bots fill it. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-9999px] h-0 w-0"
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          First name
          <input name="first_name" required value={f.first_name} onChange={(e) => setF({ ...f, first_name: e.target.value })} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Last name
          <input name="last_name" required value={f.last_name} onChange={(e) => setF({ ...f, last_name: e.target.value })} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Middle name (optional)
          <input name="middle_name" value={f.middle_name} onChange={(e) => setF({ ...f, middle_name: e.target.value })} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Birthdate
          <input type="date" name="birthdate" required value={f.birthdate} onChange={(e) => setF({ ...f, birthdate: e.target.value })} className={INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Sex
          <select name="sex" value={f.sex} onChange={(e) => setF({ ...f, sex: e.target.value as "" | "male" | "female" })} className={INPUT}>
            <option value="">—</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Phone
          <input name="phone" required placeholder="+639XXXXXXXXX or 09XX…" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} className={INPUT} />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        Email
        <input type="email" name="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} className={INPUT} />
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">We email your DRM-ID here.</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Address (optional)
        <input name="address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} className={INPUT} />
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="data_privacy_consent"
          checked={f.data_privacy_consent}
          onChange={(e) => setF({ ...f, data_privacy_consent: e.target.checked })}
          className="mt-1"
        />
        <span>
          I consent to drmed.ph processing my personal and health information for registration and care under the Philippine
          Data Privacy Act (RA 10173). See the{" "}
          <a href="/privacy" className="underline" target="_blank" rel="noreferrer">Privacy Notice</a>.
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="marketing_consent"
          checked={f.marketing_consent}
          onChange={(e) => setF({ ...f, marketing_consent: e.target.checked })}
          className="mt-1"
        />
        <span className="text-[color:var(--color-brand-text-soft)]">
          Optional: send me occasional updates on new tests, promos, and announcements. One-click unsubscribe in every email.
        </span>
      </label>

      {state && !state.ok && <p className="text-sm text-red-600">{state.error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2.5 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-60"
      >
        {pending ? "Registering…" : "Register"}
      </button>
      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        New patients are pre-registered — reception verifies your identity at the counter on arrival.
      </p>
    </form>
  );
}
```

> Note on the consent checkbox: an unchecked HTML checkbox submits **nothing** for its name; a checked one submits `"on"`. `RegistrationSchema` maps `"on"`→true and missing/`""`→false, then `.refine` rejects false — so leaving it unchecked yields the "Please accept the data-privacy consent" error server-side. The `required` attribute is **not** set on it (we want the server message, and `required` on a checkbox would block submit silently).

- [ ] **Step 3: Typecheck + build**

Run:
```bash
npm run typecheck && npm run build
```
Expected: PASS for both (build confirms the RSC/client boundary for the new route).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(marketing)/register/page.tsx" "src/app/(marketing)/register/register-form.tsx"
git commit -m "feat(register): public /register page + client form + success screens"
```

---

## Task 6: Staff "Registration link" QR button

**Files:**
- Create: `src/components/staff/registration-link-button.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/appointments/page.tsx`

- [ ] **Step 1: Implement the button**

Create `src/components/staff/registration-link-button.tsx`:
```tsx
"use client";

import * as React from "react";
import { QrCode } from "@/components/ui/qr-code";
import { Button } from "@/components/ui/button";

// Reception-facing: reveal a QR + copyable link to the public /register page so
// a patient can self-register on their own phone. Reuses the PR1 QrCode component.
export function RegistrationLinkButton({ url }: { url: string }) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="relative">
      <Button type="button" variant="outline" onClick={() => setOpen((v) => !v)}>
        Registration link
      </Button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 flex w-64 flex-col items-center gap-2 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-4 shadow-lg">
          <p className="text-xs font-semibold text-[color:var(--color-brand-text-mid)]">Have the patient scan to self-register</p>
          <QrCode value={url} size={170} />
          <span className="font-mono text-[10px] break-all text-[color:var(--color-brand-text-soft)]">{url}</span>
          <Button type="button" size="sm" variant="outline" onClick={copy} className="w-full">
            {copied ? "Copied!" : "Copy link"}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build the register URL + mount the button in the appointments header**

In `src/app/(staff)/staff/(dashboard)/appointments/page.tsx`:

First add the import (next to the `NewAppointmentSheet` import added in PR1):
```tsx
import { RegistrationLinkButton } from "@/components/staff/registration-link-button";
```

Then, where PR1 built `selfBookUrl`, add a sibling `registerUrl` right after it:
```tsx
  const selfBookUrl = `${proto}://${host}/schedule?src=staff_qr`;
  const registerUrl = `${proto}://${host}/register?src=staff_qr`;
```

Then update the header's action area (PR1 rendered just `<NewAppointmentSheet …/>`) to render both, wrapped so they sit side by side:
```tsx
        <div className="flex flex-wrap items-center gap-2">
          <RegistrationLinkButton url={registerUrl} />
          <NewAppointmentSheet services={services} physicians={physicians} selfBookUrl={selfBookUrl} />
        </div>
```
(Replace the bare `<NewAppointmentSheet services={services} physicians={physicians} selfBookUrl={selfBookUrl} />` line in the header with the wrapped block above.)

- [ ] **Step 3: Typecheck + build + commit**

Run:
```bash
npm run typecheck && npm run build
```
Expected: PASS. Then:
```bash
git add src/components/staff/registration-link-button.tsx "src/app/(staff)/staff/(dashboard)/appointments/page.tsx"
git commit -m "feat(register): staff Registration link QR button on the appointments header"
```

---

## Task 7: Full verification + live smoke

**Files:** none (verification only)

- [ ] **Step 1: Full automated gate**

Run:
```bash
npm test && npm run typecheck && npm run lint && npm run build
```
Expected: vitest green (PR1's 22 + RegistrationSchema's 5 = 27), typecheck clean, lint 0 errors (the 2 pre-existing `PlannedCard` warnings are out of scope), build succeeds.

- [ ] **Step 2: Live smoke (local Supabase stack)**

Apply migration `0089` to local (`supabase migration up`), seed services/admin if needed, run `npm run dev` against the local stack (`.env.development.local` overriding the Supabase vars), then via browser:
1. **New registrant:** open `/register`, fill a unique synthetic patient (e.g. email `reg.smoke+<n>@example.test`), check data-privacy consent → Register → success screen shows a **DRM-ID**; confirm a `patient_consents` row exists with `method='self_registration'` and `patients.consent_current = true` for that patient; confirm an `audit_log` row `patient.self_registered`.
2. **Consent gate:** submit with the consent box unchecked → inline error "Please accept the data-privacy consent to register."
3. **Dedup match:** submit again with the **same** name+email+birthdate → success screen says "We found your record" and does **not** show a DRM-ID; confirm an `audit_log` row `patient.self_register.matched` and that **no** new `patient_consents` row was added for the match.
4. **Staff QR:** sign in as reception/admin, open `/staff/appointments`, click "Registration link" → QR renders + "Copy link" copies `…/register?src=staff_qr`.
5. Clean up the synthetic `patient_consents` + `patients` rows from local (patient delete may 409 on the audit FK — that's fine, leave it; it's throwaway local data).

- [ ] **Step 3: Push + open PR (stacked on PR #35)**

```bash
git push -u origin feat/patient-self-registration
gh pr create --base feat/staff-new-appointment --head feat/patient-self-registration \
  --title "feat(register): public /register self-registration (PR2 / Feature C)" \
  --body "Implements Feature C. Stacked on PR #35 (reuses resolvePatient + qr-code.tsx). Rebase onto main after #35 merges."
```
> The PR base is `feat/staff-new-appointment` while PR #35 is open, so the diff shows only PR2's changes. After #35 merges, retarget this PR to `main` (GitHub lets you change the base) and rebase.

---

## Spec coverage map (§6 → tasks)

| Spec §6 requirement | Task |
|---|---|
| New `(marketing)/register` route: page + form + actions | Tasks 4, 5 |
| Fields: name/birthdate/sex/phone/email/address | Tasks 2, 5 |
| Required RA-10173 consent (links `/privacy`) + optional marketing | Tasks 2, 4, 5 |
| Honeypot + `patient_registration` rate-limit bucket | Tasks 3, 4 |
| `resolvePatient` (shared) — dedup→insert `pre_registered` | Task 4 (reuses PR1) |
| New → show DRM-ID + email it; record consent; audit `patient.self_registered` | Task 4 |
| Dedup match → don't reveal DRM-ID; email on-file; audit `patient.self_register.matched` | Task 4 |
| Build on `patient_consents` (0086); confirm columns; new `method` value | Tasks 1, 4 |
| QR rendered locally (`qr-code.tsx`); "Registration link" button on staff surface | Task 6 |

## Self-review notes (for the executor)

- **Branch base is `feat/staff-new-appointment`, not `main`** (imports `resolvePatient`, `qr-code.tsx`, edits the PR1 header). Rebase to `main` after PR #35 merges.
- **Consent only on NEW registration**, never on a dedup match — a public form must not mutate an existing patient's consent state, and it's enumeration-safe.
- **Enumeration safety:** DRM-ID is shown on-screen only for a brand-new registrant; matches get it by email to the on-file (== matched) address only.
- **Type consistency:** `RegistrationResult` discriminates on `ok` then `matched`; the form reads `state.matched === false` (new) vs `=== true` (matched). `submitRegistrationAction` is `(prev, formData)` for `useActionState`. `resolvePatient` returns `{ ok, id, drm_id, reused }` (from PR1).
- **`server-only`:** `registration.ts` is pure zod (vitest-importable, no `server-only`). The action file is `"use server"` and may import the admin client.
- **`sendEmail` skips gracefully** when Resend env is unset (dev) — the smoke verifies the flow, not actual delivery.
