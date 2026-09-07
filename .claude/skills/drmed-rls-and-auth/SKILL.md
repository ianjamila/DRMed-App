---
name: drmed-rls-and-auth
description: Use when working on any DRMed authentication, authorization, RLS policy, audit logging, or RA 10173 compliance surface. Trigger whenever the user mentions RLS, row-level security, staff auth, patient auth, DRM-ID, receipt PIN, set_patient_context, current_patient_id, createPatientClient, patient client, SUPABASE_JWT_SECRET, patient_id claim, portal-scoping, audit log, audit(), RA 10173, Data Privacy Act, MFA, TOTP, requireActiveStaff, requireAdminStaff, requirePatientProfile, sectionsForRole, role-sections, patient session, JWT, signed URL, createStorageSignedUrl, rate limit, checkRateLimit, login route, PIN attempt, supabase admin client, service-role key, anon-executable, function grant, SECURITY DEFINER ACL, CSV export, data export, print slip audit, patient_consents, consent, data-privacy consent, consent method, self_registration, notice_version, sync_patient_consent_state, enforce_consent_before_release, consent gate, consent_settings, recordConsentGrantAction, acceptConsentPortalAction, /register self-registration, or anything touching the line between staff and patient data access. Also trigger when adding a new staff page, a new patient query, a new write action, a new export/print, or a new login/PIN route. This is the single most compliance-sensitive surface in DRMed — don't make Claude reconstruct the auth rules from scratch.
---

# DRMed auth, RLS & RA 10173 compliance

## What this is

DRMed has **two non-mergeable auth systems**, **RLS as the source of truth for access**, and **mandatory audit logging on every write**. RA 10173 (Philippine Data Privacy Act) compliance hinges on all three being correct on every new query, every new route, every new write. A single missed step is a compliance breach — not just a bug.

## Architecture at a glance

```
src/lib/
├── auth/
│   ├── require-staff.ts            ← requireSignedInStaff, requireActiveStaff (MFA-gated)
│   ├── require-admin.ts            ← requireAdminStaff
│   ├── require-patient.ts          ← requirePatientProfile (handles merge-chain)
│   ├── pin.ts                      ← generatePin, hashPin, verifyPin (bcrypt cost=12)
│   ├── patient-session.ts          ← mintPatientSession, verifyPatientSession (HS256 JWT)
│   ├── patient-session-cookies.ts  ← cookie helpers (drmed_patient_session)
│   ├── role-sections.ts            ← sectionsForRole(role) → lab sections a role may see ([] = NO access, not "all")
│   └── visit-pin-flash.ts          ← one-time-display of plain PIN for receipt printing
├── supabase/
│   ├── client.ts                   ← browser (anon key)
│   ├── server.ts                   ← server-component (anon key + cookie SSR) — RLS-scoped staff reads/writes
│   ├── admin.ts                    ← service-role, SERVER-ONLY (bypasses RLS at PG role level)
│   └── patient.ts                  ← createPatientClient(patientId) — anon-role JWT with a patient_id claim (0114); ALL portal reads
├── storage/
│   └── signed-url.ts               ← createStorageSignedUrl — the single service-role choke point for patient downloads
├── portal/
│   └── portal-scoping.test.ts      ← guard test: portal files may import admin.ts only if allowlisted (with a reason)
├── audit/
│   └── log.ts                      ← audit() — append-only audit_log writer
├── server/
│   └── action-helpers.ts           ← ipAndAgent, firstIssue
└── rate-limit/
    └── check.ts                    ← checkRateLimit (sliding window over rate_limit_attempts; fails OPEN but loudly via reportError)
```

## The two auth systems

| | Staff | Patient |
|---|---|---|
| **Identity** | `auth.users` (Supabase Auth) + `staff_profiles` row | `patients` row (NOT in `auth.users`) |
| **Mechanism** | Email + password, optional TOTP (AAL2) | DRM-ID + 8-char receipt PIN |
| **PIN format** | n/a | 8-char alphanumeric, alphabet excludes `0 1 I O l` for receipt legibility, bcrypt cost=12 |
| **Session** | Supabase-managed | HS256 JWT in `drmed_patient_session` cookie (httpOnly, Secure, SameSite=Strict) |
| **Cookie/session TTL** | Supabase default | Configurable via `PATIENT_SESSION_SECRET` env, default 30 min |
| **Lockout** | Supabase | After 5 failed PIN attempts (`visit_pins.failed_attempts`) + per-IP rate limit (10 attempts / 15 min) |
| **PIN expiry** | n/a | 60 days default |
| **Gate function** | `requireActiveStaff()` (most routes) / `requireAdminStaff()` (admin routes) | `requirePatientProfile()` |

### Staff MFA gate

`requireActiveStaff()` enforces MFA based on `FEATURE_STAFF_MFA_REQUIRED` env (default `"true"`):
- Admins must reach AAL2 (TOTP enrolled and verified)
- Non-admins only need AAL2 if they have a verified factor enrolled
- `requireSignedInStaff()` is the one exception that does NOT enforce MFA — used only on the `/staff/mfa` page itself to avoid redirect loops

When `FEATURE_STAFF_MFA_REQUIRED="false"` (UAT only), MFA is fully disabled at AAL1.

## The RLS bridge for patients (0114 — the patient client)

Patients aren't postgres-authenticated, so there is no Postgres role for them. Since migration 0114 the bridge is a **JWT claim**, not a session variable:

1. After `requirePatientProfile()` resolves the patient, server code calls `createPatientClient(patientId)` (`src/lib/supabase/patient.ts`). It mints a **5-minute anon-role HS256 JWT carrying `patient_id`**, signed with `SUPABASE_JWT_SECRET` (the project's legacy symmetric secret — a separate env var from `PATIENT_SESSION_SECRET`), and hands it to a normal anon-key client.
2. PostgREST exposes the claim as `request.jwt.claims`; `current_patient_id()` (0114 body) reads that claim **or** the old `app.current_patient_id` GUC.
3. Patient RLS policies (`patient_id = public.current_patient_id()`, or joined through `visits`) therefore evaluate on **every query** — real row-level enforcement, not just the app-level `.eq("patient_id", …)` filters (keep those too, as defense in depth).

`set_patient_context()` still exists in the schema but **no app code calls it any more** — don't reintroduce the admin-client-plus-GUC pattern.

**The admin client is allowed in the portal only where RLS cannot help:** Storage signed-URL minting/downloads (`src/lib/storage/signed-url.ts`), `audit_log` reads/writes, pre-auth login, and the `appointment_attachments` delete. `src/lib/portal/portal-scoping.test.ts` fails the build-time test suite if any other portal file imports `admin.ts` — add to its `ADMIN_ALLOWLIST` with a justifying comment only when RLS genuinely can't express the access.

Portal policies worth knowing (0114): `test_requests: patient own visits` (own-visit rows, including in-progress — so "still in progress" cards render), `results` / `result_test_requests: patient released only` (result *content* stays release-gated), `appointments: patient self`, `report_groups: public read active`.

**Without a correct claim the patient sees nothing; with a wrong one they'd see another patient's data.** This is still the single most important pattern in the codebase.

## Audit logging

Every write action MUST insert an `audit_log` row via `audit()`:

```typescript
import { audit } from '@/lib/audit/log'
import { ipAndAgent } from '@/lib/server/action-helpers'

const { ip, ua } = await ipAndAgent()
await audit({
  actor_id: session.user.id,
  actor_type: 'staff',                  // or 'patient' | 'system' | 'anonymous'
  patient_id: visit.patient_id,         // optional but encouraged
  action: 'visit.payment.recorded',     // dotted namespaced string
  resource_type: 'payment',
  resource_id: payment.id,
  metadata: { amount_php: 850.00, method: 'cash' },
  ip_address: ip,
  user_agent: ua,
})
```

- Inserts via admin client. Failures log to console, never block the operation.
- Append-only — never UPDATE or DELETE an audit row.
- Admin-only read via RLS policy.

## Patient consent (RA 10173) — the `patient_consents` ledger

Consent is an **append-only event ledger** (`patient_consents`, migrations 0086–0089), not a boolean. Each grant/withdrawal is a row; a trigger denormalises the *current* state onto `patients`.

- **`event_type`**: `'granted'` | `'withdrawn'`.
- **`method`** (how consent was captured) — one of:
  - `paper_wet_signature` — staff records a signed paper form
  - `onscreen_signature` — staff captures a signature-pad image
  - `portal_acceptance` — patient clicks accept in the portal
  - `self_registration` — patient self-registers at public `/register` (added in 0089)
- **`actor_kind`**: `'staff'` (also sets `created_by`) | `'patient'` (no `created_by`).
- **`notice_version`**: stamp every grant with `CURRENT_CONSENT_NOTICE_VERSION` from `src/lib/consent/notice.ts`. The gate does NOT compare versions — bumping the notice does not auto-invalidate existing consent.
- **`signatory`**: `'self'` | `'guardian'` | `'representative'` (+ name/relationship when not self).

**Recording actions** live in `src/lib/actions/consent/`: `grant.ts` (`recordConsentGrantAction`, staff paper/onscreen), `portal-accept.ts` (`acceptConsentPortalAction`, patient portal), `withdraw.ts` (`withdrawConsentAction`, admin). The public `/register` flow inserts its own grant inline (method `self_registration`, `actor_kind:'patient'`, no `created_by`) via the admin client — and ONLY for a genuinely new registrant, never on a dedup match (a public form must not re-affirm an existing patient's consent).

**Denormalised state + the release gate:**
- Trigger `trg_patient_consents_sync` → `sync_patient_consent_state()` (SECURITY DEFINER) updates `patients.consent_current` / `consent_method` / `consent_notice_version` / `consent_withdrawn_at` after each insert. **Read `patients.consent_current`; don't re-derive from the ledger.**
- Release gate: trigger `enforce_consent_before_release()` on `test_requests` blocks the transition to `'released'` when `consent_settings.gate_required = true` AND the patient has no current consent. The flag (table `consent_settings`, admin-only RLS, SECURITY DEFINER gate fn) **ships OFF**; admin toggles it at `/staff/admin/settings/consent-gate`.

**Writes bypass RLS via the admin client** (RLS enabled, no policies — same posture as `audit_log`). Adding a new capture channel = a new `method` value: widen the CHECK (see `drmed-migrations` — Postgres stores `IN` as `= ANY(ARRAY)`, so drop-by-name), add it to `ConsentMethod` in `src/lib/consent/types.ts`, and mirror the closest existing recording action.

## Rate limiting

`checkRateLimit({ bucket, … })` from `src/lib/rate-limit/check.ts`. Inserts into `rate_limit_attempts`, sliding window. Returns `{ allowed: true } | { allowed: false, retryAfterSec }`. If the limiter itself errors (no client IP, DB down) it **fails open but reports** via `reportError` — never silently.

Buckets are declared in `RATE_LIMITS` in `check.ts` and their callers: `staff_login` (`/staff/login`), `patient_pin` (`/portal/login`), `patient_lookup` (existing-patient lookup on `/schedule` and `/portal/login`), `patient_id_recovery` (`/find-my-id`), `patient_registration` (`/register`), `public_booking` / `portal_booking` (`/schedule` anonymous vs signed-in portal `/book`), `appointment_cancel` (`/appointments/cancel/[id]`), `contact_form`, `newsletter_signup` / `newsletter_resubscribe` (`/newsletter`, `/unsubscribe`). A new public form gets its own bucket name.

## Function ACLs — what a JWT may call (0112/0113/0118/0119/0123)

- Only `has_role`, `is_staff`, `staff_role` (and `current_patient_id`) are anon-executable. Everything else SECURITY DEFINER in `public` is service_role-only, except `eod_lock_check` / `employee_leave_balance` which keep `authenticated` because SECURITY INVOKER triggers on staff-written tables nest-call them. `employee_leave_balance` does its own admin-or-self check (0123).
- **New functions default to postgres + service_role only** (0119). Grant `authenticated`/`anon` explicitly and only when a browser/staff JWT calls it directly.
- `create or replace` keeps an existing function's ACL — check what 0118 left before restating grants (see `drmed-migrations`).
- Server code that calls an RPC uses the admin client and passes `p_actor_id` from `requireAdminStaff()` / `requireActiveStaff()` — that is trusted server input, not a spoofing vector (JWT callers were revoked). Investigated and closed; don't re-raise.

## Role sections, exports, and disclosure audits

- **`sectionsForRole(role)` returning `[]` means NO access, not "no filter".** The lab queue once guarded on `length > 0` and showed reception every section's worklist. Any page that scopes by section must treat `[]` as deny (mirror `/staff/results`).
- **Exports run under the RLS-scoped server client, never service-role** (`/api/admin/visits.csv` is the model: `requireAdminStaff`, `createClient()`, chunked past PostgREST's 1000-row cap, hard ceiling, `maxDuration`, audit `visits.exported`).
- **Any print or view that discloses patient data is audit-logged** even though it's a read: `result.viewed`, `result.downloaded`, `lab_request.viewed`, `payroll_payslip.viewed`, `eod_close.count_sheet_viewed`, `pf_disbursement.slip_printed`, `patient.data_exported`, `visits.exported`, `emails_log.exported`, `consent.artifact_viewed`. Follow the same shape (actor, resource, IP/UA, metadata that names what was shown — never the content).
- **Notifications are muted outside production** unless `NOTIFICATIONS_LIVE=true`; skips are recorded in audit metadata rather than sent.
- **Dev CSP** (`next.config.ts`) allows the local Supabase stack only when `NODE_ENV !== production` AND the URL host is loopback — don't widen it for prod.

## Hard rules

- **Never use Supabase Auth for patients.** DRM-ID + PIN only. Patients do NOT have `auth.users` rows.
- **Never expose `SUPABASE_SERVICE_ROLE_KEY` client-side.** Only `src/lib/supabase/admin.ts` may read it.
- **Never bypass RLS by reaching for the admin client to dodge a policy.** If you need admin-level read, set the patient context properly and let RLS scope the query.
- **Never log plain PINs.** Only the bcrypt hash is stored. The plain PIN is returned exactly once when reception creates the visit, for receipt printing — that flash is the only legitimate appearance in memory.
- **Patients get 5-minute signed URLs for storage** via `createStorageSignedUrl` — never grant direct bucket access. The Server Action issuing the URL must `audit()` the access.
- **Every portal read goes through `createPatientClient(patientId)`**, never the admin client (the scoping test enforces it). No exceptions outside the allowlist.
- **Every staff write action calls `requireActiveStaff()` or `requireAdminStaff()`**, then `audit()` with `ipAndAgent()`. Staff reads/writes that don't need service-role use `createClient()` from `server.ts` so RLS applies.
- **Every login / PIN-attempt / public form / cancel-route calls `checkRateLimit()`** before the credential check, with its own bucket.
- **New SQL functions get explicit grants only when a JWT calls them.** Default is service_role-only.

## Common break points to check on review

- New staff page forgot `requireActiveStaff()` (or used `requireSignedInStaff()` which doesn't gate MFA)
- New portal read used the admin client instead of `createPatientClient()` (the scoping test will fail — don't just allowlist it)
- New section-scoped page treated `sectionsForRole() === []` as "no filter"
- New export built on the service-role client, or missing the audit row
- New SQL function re-granted `authenticated`/`anon` by copying an old migration's grant block
- New write action forgot the `audit()` entry, or forgot to capture `ipAndAgent()` for the IP/UA fields
- New login / cancellation / unsubscribe route forgot `checkRateLimit()`
- New table created without an RLS policy at all (Supabase defaults to "no access" so this manifests as queries returning empty — easy to miss in dev with admin client)
- PIN handling code that logs the plain PIN (look for `console.log(pin)` or accidentally-included PIN in error metadata)
- New consent capture that forgot to stamp `notice_version`, used the wrong `actor_kind`, or (for a public/self-serve channel) re-affirms an existing patient's consent on a dedup match instead of only recording for brand-new registrants

## When this skill should NOT trigger

- General DRMed migration / schema work that doesn't touch auth or RLS — use the `drmed-migrations` skill (which carries the RLS policy templates as a sub-section).
- Lab result PDF rendering — use the `drmed-result-templates` skill.
- Pure UI work (component styling, layout) with no auth implications.
- Newsletter / marketing-site work that isn't behind a login.
