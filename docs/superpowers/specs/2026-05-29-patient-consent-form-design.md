# Patient Data-Privacy Consent — Form, Capture & Release Gate

**Date:** 2026-05-29
**Status:** Design — pending approval
**Compliance target:** Philippine Data Privacy Act (RA 10173)

## Problem

`drmed.ph` records data-privacy consent as a single checkbox ("Patient has
signed the printed registration & consent form today") that stamps
`patients.consent_signed_at`. But **no consent form actually exists** — the
software neither generates nor stores one, the printed receipt carries no
consent language, and the only real wording lives on the public `/privacy`
marketing page. The checkbox is an honor-system flag referring to paper that
doesn't exist.

Separately, the form text claims consent is "Required before reception can
release any results," but **nothing gates release on it**. All 4,297
bulk-imported legacy patients have `NULL` consent.

This project builds the actual consent instrument, three ways to capture it,
a full audit trail, and a hard release gate — so the claim becomes true.

## Decisions (locked during brainstorming)

1. **Three capture channels, all built now:** printed/wet-signature,
   on-screen signature pad, and portal digital-acceptance. The system records
   *which* channel was used.
2. **One dedicated, versioned RA 10173 notice** — the shared instrument across
   all three channels, kept consistent with `/privacy` but authored
   separately. The notice version each patient agreed to is stored.
3. **Guardian/representative signatory captured** — for minors and patients
   unable to sign: who signed (self / guardian / representative) plus name and
   relationship.
4. **Admin withdraw action** — marks consent withdrawn (reason + timestamp,
   audit-logged); re-blocks release until consent is given again.
5. **Hard DB-trigger release gate** — mirrors the existing payment gate. Blocks
   `test_requests` transition to `released` unless the patient has a current
   valid consent. UI enforces it for UX; the trigger is the source of truth.

## Architecture (Approach A — event log + denormalized current state)

### Data model

**New table `patient_consents`** — one row per consent *event* (grant or
withdrawal); the full RA 10173 audit trail.

| column | type | notes |
|---|---|---|
| `id` | `uuid` pk | `gen_random_uuid()` |
| `patient_id` | `uuid` not null → `patients(id)` | indexed |
| `event_type` | `text` not null | `granted` \| `withdrawn` |
| `method` | `text` | `paper_wet_signature` \| `onscreen_signature` \| `portal_acceptance`; required for grants, null for withdrawals |
| `notice_version` | `text` | required for grants, null for withdrawals |
| `signatory` | `text` | `self` \| `guardian` \| `representative`; required for grants |
| `signatory_name` | `text` | required when `signatory != 'self'` |
| `signatory_relationship` | `text` | required when `signatory != 'self'` |
| `artifact_path` | `text` | Storage path to scanned PDF / signature PNG; null for `portal_acceptance` |
| `reason` | `text` | required for withdrawals |
| `actor_kind` | `text` not null | `staff` \| `patient` |
| `created_by` | `uuid` → `staff_profiles(id)` | null for patient self-acceptance |
| `ip` | `text` | hashed per existing convention where applicable |
| `user_agent` | `text` | |
| `created_at` | `timestamptz` not null default `now()` |

CHECK constraints:
- `event_type = 'granted'` ⇒ `method`, `notice_version`, `signatory` all NOT NULL; `reason` NULL.
- `event_type = 'withdrawn'` ⇒ `method`, `notice_version`, `signatory` NULL; `reason` NOT NULL.
- `signatory != 'self'` ⇒ `signatory_name` and `signatory_relationship` NOT NULL.
- enum-style CHECKs on `event_type`, `method`, `signatory`, `actor_kind`.

**Columns on `patients`** — denormalized current state, maintained by trigger:
- `consent_signed_at timestamptz` *(exists)* — timestamp of the current valid grant; NULL if none/withdrawn.
- `consent_current boolean NOT NULL DEFAULT false` *(new)* — true iff the latest event for the patient is a grant.
- `consent_withdrawn_at timestamptz` *(new)* — set when the latest event is a withdrawal.
- `consent_method text` *(new)* — method of the current grant.
- `consent_notice_version text` *(new)* — notice version of the current grant.

### Triggers

**`sync_patient_consent_state()`** — AFTER INSERT on `patient_consents`.
Recomputes the five `patients` columns from the latest event (by `created_at`,
tie-break `id`) for `NEW.patient_id`. A grant sets `consent_current = true`,
`consent_signed_at = NEW.created_at`, populates method/version, clears
`consent_withdrawn_at`. A withdrawal sets `consent_current = false`,
`consent_withdrawn_at = NEW.created_at`, leaves `consent_signed_at` as the
historical grant time (so we still know it was once given) — gate reads
`consent_current`, not `consent_signed_at`.

`patient_consents` is **append-only** in normal operation (no UPDATE/DELETE
path from the app); corrections are new events. The 4,297 legacy patients have
no rows → `consent_current = false`.

**`enforce_consent_before_release()`** — BEFORE UPDATE on `test_requests`,
new trigger alongside the existing `enforce_payment_before_release()`. On
transition to `status = 'released'` (`old.status is null or old.status <> 'released'`),
look up the visit's patient and raise `check_violation` if
`patients.consent_current` is not true. Message contains the marker
`consent` so callers can distinguish it from the payment gate.

Because it fires on **UPDATE only**, historical results backfilled with
`status = 'released'` via INSERT bypass the gate — important for the separate
historical-data project. New releases for legacy patients are blocked until
consent is captured.

**Feature-flagged rollout.** The gate ships behind
a feature flag defaulting **off** during partner UAT — same intent as the
existing `FEATURE_STAFF_MFA_REQUIRED` gate (see
`feedback_re_enable_mfa_gate.md`), but because a Postgres trigger cannot read
`process.env`, the flag lives in the **database**, not an env var: a single
`consent_settings` row (e.g. `gate_required boolean`). When the trigger sees
`gate_required = false` it returns without raising; the UI reads the same row
and shows a soft warning instead of disabling release. Flipping the row to
`true` (an admin action / SQL toggle) turns the gate on for both layers at
once — single source of truth, no drift between DB and UI. This lets all the
capture machinery and audit trail go live immediately without abruptly
blocking releases for the 4,297 consent-less legacy patients mid-UAT.

### The consent notice (versioned)

`src/lib/consent/notice.ts` exports:
- `CURRENT_CONSENT_NOTICE_VERSION` — a date string, e.g. `'2026-05-29'`.
- A structured notice object (sections: controller identity & contact, data
  categories incl. health/sensitive data, purposes, sharing, retention,
  patient rights incl. withdrawal, and the consent statement) authored to
  match the `/privacy` page. Pulls controller contact from
  `src/lib/marketing/site.ts` (`CONTACT`) so address/phone stay single-sourced.

Versioned in git; the agreed version is stored on each `patient_consents` row.
**The gate checks only `consent_current` (any valid grant), not version
equality** — bumping the notice does not auto-invalidate existing consent;
re-consent is a deliberate policy action, out of scope here.

One shared React component renders the notice for all surfaces (print page,
signature-pad page, portal modal) from this single source.

### Capture channels

**1. Paper / wet-signature.**
- New print route `/staff/patients/[id]/consent/print` — server component
  rendering the notice + signature block (patient line; guardian/representative
  line) with a print stylesheet. Reception prints, patient signs.
- The existing consent checkbox in patient create/edit now inserts a
  `paper_wet_signature` grant (instead of directly stamping
  `consent_signed_at`). It collects signatory fields (default `self`).
- Optional: reception uploads a scan of the signed form → stored in Storage,
  `artifact_path` set on the grant row.
- The printed **receipt** gains one informational line ("Data privacy consent:
  on file / not on file") — it is *not* the consent instrument.

**2. On-screen signature pad.**
- A `'use client'` canvas signature-pad component on the patient detail/consent
  page. Staff hands the device to the patient/guardian; the drawn signature is
  exported to PNG, uploaded to Storage via a Server Action, and recorded as an
  `onscreen_signature` grant with signatory fields. (Check for an existing
  signature-capture pattern from Phase 12.5 staff signatures before adding a
  dependency; prefer a small self-contained canvas over a heavy lib.)

**3. Portal digital-acceptance.**
- On patient portal login, if `consent_current` is false, a blocking
  acceptance screen renders the notice + "I agree" (with self/guardian
  selection, defaulting to self). The patient cannot reach results until
  accepted. On accept, a Server Action calls `set_patient_context(...)`,
  inserts a `portal_acceptance` grant with `actor_kind = 'patient'`, captures
  IP/user-agent, and audit-logs. No signature image — the acceptance event is
  the proof.

### Withdrawal

`withdrawConsentAction(patientId, reason)` (admin/reception only) inserts a
`withdrawn` event → trigger flips `consent_current = false` → release re-blocked.
Audit-logged. Surfaced on the patient detail page where current consent status
is shown.

### Artifact storage

New private Storage bucket `consent-artifacts` (mirrors `0052_signatures_bucket`
and `0045_payslip_bucket`): `public = false`, small size cap, allowed mime
`application/pdf` + `image/png`/`image/jpeg`. Path convention
`<patient_id>/<consent_id>.<ext>`. **Service-role access only** — no
`to authenticated` policies. Staff view a stored artifact via a 5-minute signed
URL minted by a Server Action that audit-logs the access (mirrors the patient
result-access pattern).

### Audit logging

Every consent action inserts an `audit_log` row via the service-role `audit()`
helper:
- `consent.granted` — metadata: method, notice_version, signatory, actor_kind.
- `consent.withdrawn` — metadata: reason.
- `consent.artifact_viewed` — when a signed artifact's signed URL is minted.

The release gate continues to be audited through the existing
`test_request.released` / `result.released` actions.

### Release-path call-site changes

- **`finalise-consolidated.ts`** — the batch release currently treats only the
  payment gate (`23514` + `/payment_status/i`) as a soft "deferred" failure.
  Extend it to also treat the consent gate (`23514` + `/consent/i`) as
  deferred: the result still finalizes and sits in `ready_for_release`;
  reception releases after consent is captured. Audit metadata distinguishes
  `release_deferred_reason: 'payment' | 'consent'`.
- **`releaseTestAction`** (per-test) — surface a clear consent error via
  `translatePgError` ("Patient consent is not on file — capture consent before
  releasing.").
- **`ReleaseButton`** — disabled with an explanatory message when the patient
  has no current consent, mirroring the existing `!paid` disable.

### Migration

Single new migration `0086_patient_consent.sql`:
- `consent-artifacts` bucket.
- `patient_consents` table + indexes + CHECKs.
- new `patients` columns.
- `consent_settings` single-row table seeded `gate_required = false`.
- `sync_patient_consent_state()` + trigger.
- `enforce_consent_before_release()` + trigger (reads `consent_settings`).

Followed by `npm run db:types`. **No backfill** — legacy patients start with no
consent and clear naturally on their next visit. Existing non-null
`consent_signed_at` values (from the current checkbox code) are left as-is but
do **not** set `consent_current`; if any such patients exist, a one-line data
step in the migration can seed a synthetic `paper_wet_signature` grant for
them so they aren't suddenly gate-blocked. (Verify how many exist first; likely
only test data.)

## Components / file map

| Concern | Location |
|---|---|
| Notice content + version | `src/lib/consent/notice.ts` (new) |
| Notice render component | `src/components/consent/consent-notice.tsx` (new) |
| Signature-pad component | `src/components/consent/signature-pad.tsx` (new, `'use client'`) |
| Consent capture Server Actions (grant/withdraw/upload-artifact/view-artifact) | `src/lib/actions/consent/*.ts` (new) |
| Print route | `src/app/(staff)/staff/(dashboard)/patients/[id]/consent/print/page.tsx` (new) |
| Portal acceptance screen + action | `src/app/(patient)/portal/...` (new gate + action) |
| Patient create/edit | existing `patients/actions.ts`, `[id]/edit-actions.ts`, `patient-form.tsx` (modified) |
| Release call-sites | `finalise-consolidated.ts`, `visits/[id]/actions.ts`, `release-button.tsx` (modified) |
| Migration | `supabase/migrations/0086_patient_consent.sql` (new) |

## Testing

- **SQL smoke** (extend the migration-smoke pattern): grant → `consent_current`
  flips true; `released` blocked when false, allowed when true; withdrawal flips
  false and re-blocks; INSERT with `status='released'` bypasses the gate (proves
  backfill safety); each CHECK constraint rejects a malformed row.
- **UI smoke** (Playwright, per `feedback_local_ui_smoke_recipe.md`): reception
  paper-grant via checkbox; on-screen signature capture; portal acceptance
  blocking modal then results visible; admin withdraw re-blocks.
- `npm run typecheck` + `npm run lint` green.

## Out of scope

- Re-consent on notice-version bump (gate ignores version).
- Google-OAuth patient login (separate deferred project; portal acceptance here
  works on the existing DRM-ID + PIN session).
- Bulk backfill of consent for the 4,297 legacy patients (clears on next visit
  by design).

## Risks / notes

- The consent gate can block release for any legacy patient until consent is
  captured — intended, but communicate to reception before flipping
  `FEATURE_CONSENT_GATE_REQUIRED` on. The flag (default off during UAT) makes
  this a deliberate switch, not a surprise.
- `finalise-consolidated.ts` regex-matches gate errors; the consent message
  must reliably contain `consent` and not accidentally match `/payment_status/i`.
- Two BEFORE UPDATE triggers on `test_requests` (payment + consent) — order is
  irrelevant since both only raise; no data mutation.
