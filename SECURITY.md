# Security & Compliance

Operational security playbook for drmed.ph. Reading order: skim the headings,
read in detail when responding to an incident or onboarding a new admin.

For the API surface, RLS policy details, and per-table column rationale, see
the migrations under `supabase/migrations/` — those are the source of truth.

---

## Architecture at a glance

Two distinct auth systems share the same domain:

- **Staff** sign in via Supabase Auth (email + password, optional TOTP).
  Sessions are managed by Supabase. Middleware re-checks an active row in
  `staff_profiles` on every request.
- **Patients** authenticate with `DRM-ID + receipt PIN` (8-char Crockford
  base32, bcrypt-hashed, scoped to a single visit, 60-day expiry). Sessions
  are short-lived signed JWTs (HS256, `PATIENT_SESSION_SECRET`) in
  `HttpOnly` `Secure` `SameSite=Strict` cookies.

Patient data access bridges to RLS through a Postgres function
`set_patient_context(patient_id uuid)` that sets a session-scoped
`app.current_patient_id`. RLS policies for patient queries read
`current_setting('app.current_patient_id')`. Application code does not
decide what a patient can see — RLS does.

### Three Supabase clients (strict separation)

- `src/lib/supabase/client.ts` — browser anon key, RLS-bound.
- `src/lib/supabase/server.ts` — server cookie-bound client via
  `@supabase/ssr`, RLS-bound.
- `src/lib/supabase/admin.ts` — service-role client. **Server-only.** Bypasses
  RLS. Imported only from Server Actions, Route Handlers, and Edge
  Functions. Never imported anywhere that ships to the browser.

### What's enforced at the database

- Payment-gating: a Postgres trigger blocks any `test_requests.status` →
  `released` transition unless the parent `visits.payment_status = 'paid'`.
- Visit balance: `payments` insert recalculates `visits.paid_php` +
  `visits.payment_status`.
- Lab result lifecycle: `results` insert auto-flips `test_requests.status`
  from `in_progress` → `result_uploaded` (or `ready_for_release` for
  services without sign-off).
- Audit trail: every staff write, every patient result view/download, every
  PIN attempt (success and failure), and every payment record inserts a
  row into `audit_log`.

These are the load-bearing invariants. Application code may also enforce
them in the UI for ergonomics, but the trigger / RLS check is the source
of truth.

---

## RA 10173 compliance summary

The Philippine Data Privacy Act (RA 10173) governs personal information
collected by drmed.ph. Key obligations as implemented:

| Obligation | Where it lives |
|---|---|
| Lawful basis + explicit consent | `patients.consent_signed_at` (counter form), `subscribers.consent_at + consent_ip` (newsletter) |
| Purpose limitation | Privacy Notice at `/privacy`; data flows are scoped to clinical care + minimal marketing |
| Data minimisation | Only fields actually used by the workflow are persisted; no analytics SDKs collect PII |
| Retention | Lab results retained per medical-records regulation (see retention table below); PINs auto-expire at 60 days; patient sessions are short-lived JWTs |
| Patient access + correction | Patient portal at `/portal/*` — patients view + download their own results; corrections go through reception |
| One-click unsubscribe (RA 10173 §16) | `/unsubscribe?token=…` token-bound, no auth required |
| Audit log + access trail | `audit_log` table; admin views at `/staff/audit` |
| Breach notification | See "Breach response runbook" below |

### Retention

| Data | Retention |
|---|---|
| Lab results (PDF + structured values) | Indefinite while patient relationship is active; archived per Philippine medical-records regulation |
| Visit PINs | 60 days from issue, then `expires_at` excludes them from auth lookup |
| Patient session JWTs | Cookie max-age 12 hours; secret rotation every 90 days |
| Audit log | Indefinite (the trail is the compliance artifact) |
| Newsletter subscribers | Until unsubscribe; unsubscribed rows kept for the consent trail |
| Rate-limit attempts | Indefinite by default; see "Operational" for cleanup recipe |

---

## Patient session JWT secret rotation

The `PATIENT_SESSION_SECRET` env var signs every patient JWT. Rotate
quarterly, or immediately if a leak is suspected.

### Procedure

1. Generate a new secret: `openssl rand -base64 64`.
2. Update the secret in Vercel project settings → Environment Variables for
   **Production** (and each Preview environment that sees real traffic).
3. Trigger a redeployment so the new secret takes effect.
4. **Existing patient cookies signed with the old secret will no longer
   verify.** Patients are silently signed out at next request and prompted
   to re-enter their DRM-ID + PIN. The PIN itself is still valid.
5. Audit-log the rotation: `audit.actor_type = 'system'`,
   `action = 'patient.jwt.secret_rotated'`, with the rotation date in
   `metadata`.
6. Update the rotation log below with the date + actor.

There is intentionally no overlap window — the operational cost of forcing
a re-sign-in is low (PINs are short, sessions are 12h) and an overlap
window would require re-signing tokens which adds complexity for no
defensive value.

### Rotation log

| Date | Actor | Reason |
|---|---|---|
| _initial_ | _the dev who set up the project_ | Initial install |

---

## Breach response runbook

A breach is any unauthorised access, disclosure, alteration, or destruction
of personal information held by drmed.ph. RA 10173 requires notification
to the National Privacy Commission within 72 hours of discovery for
serious incidents.

### Triage (first 30 minutes)

1. **Contain.** Identify the affected system. If the issue is a leaked
   credential, rotate it now (Supabase service-role key, patient JWT
   secret, Resend API key, Google Sheets service account, …).
2. **Preserve evidence.** Take a snapshot of `audit_log` for the relevant
   window: `select * from audit_log where created_at >= now() - interval
   '24 hours' order by id desc;` Save off-platform.
3. **Assess scope.** Which patients' data was potentially accessed? Use
   `audit_log` filtered by `patient_id` and the suspect time window.

### Notify (within 72 hours)

1. **Internal.** Alert the Data Protection Officer + clinic management.
2. **Patients.** If sensitive personal information was accessed, notify
   affected patients individually. Use the existing Resend transactional
   pipeline (not the newsletter list).
3. **Regulator.** File a report with the National Privacy Commission via
   their breach reporting portal. Include: nature of the breach, types of
   PII affected, number of records, mitigation steps, contact details.

### Recover

1. Patch the underlying vulnerability. Add a regression test or an audit
   query that would catch the same pattern in the future.
2. Force-rotate any potentially compromised credentials.
3. If the breach involved patient sessions, also rotate
   `PATIENT_SESSION_SECRET` (see above).
4. Post-incident review: document timeline, root cause, and corrective
   actions in this section under a dated header.

---

## Operational

### Backups

- Supabase free tier ships with daily backups. For Point-in-Time Recovery,
  upgrade to the Pro plan — confirm with stakeholders before launching.
- Storage buckets (`results`, `physician-photos`) are not in the standard
  backup; export them separately on a quarterly cadence.

### Rate-limit ledger cleanup

`rate_limit_attempts` grows ~1k rows/day at clinic scale. Run this monthly
from Supabase SQL Editor:

```sql
delete from public.rate_limit_attempts
where attempted_at < now() - interval '30 days';
```

### Dependency hygiene

- Dependabot opens weekly PRs for npm patch + minor updates. Group merges
  on Mondays.
- `npm audit` flags six moderate findings as of writing — all in
  build-time tooling (`@modelcontextprotocol/sdk`, `postcss` via Next.js).
  None affect runtime; the suggested fix downgrades Next.js by 7 majors so
  it's intentionally not auto-applied. Review on each Dependabot pass.

### Error tracking

`src/lib/observability/report-error.ts` logs to stdout and (in production)
inserts a `system.error` row into `audit_log`. To switch to Sentry:

1. Install `@sentry/nextjs`.
2. Run `npx @sentry/wizard@latest -i nextjs` (creates the config files).
3. Add `SENTRY_DSN` to Vercel env vars.
4. Replace the body of `reportError` with `Sentry.captureException(error,
   { tags: { scope }, extra: metadata })`.

The call sites already use `reportError` so the swap is mechanical.

---

## Hard rules

These come straight from the implementation plan and apply to every commit:

- Do **NOT** use Supabase Auth for patients. Patient auth is DRM-ID + PIN
  with bcrypt + visit-scoped expiry.
- Do **NOT** expose `SUPABASE_SERVICE_ROLE_KEY` to the browser. Only
  `src/lib/supabase/admin.ts` reads it. Imports of that module from any
  `'use client'` file are bugs.
- Do **NOT** skip RLS. RLS is the source of truth for access. Don't paper
  over an RLS failure by reaching for the service-role client.
- Do **NOT** log plain PINs anywhere, ever. Only the bcrypt hash is stored.
  The plain PIN is returned exactly once when reception creates the visit
  for the printed receipt.
- Do **NOT** hardcode service prices in the frontend — always read from
  the `services` table.
