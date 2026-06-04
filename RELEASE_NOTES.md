# v1.0.0 — initial production release

The full feature scope from `IMPLEMENTATION_PLAN.md` is shipped. This is
the baseline release; subsequent versions track incremental changes.

drmed.ph is a unified Next.js 16 + Supabase application serving three
surfaces from one codebase and one domain: a public marketing site, a
patient portal (DRM-ID + receipt PIN auth), and a staff portal for
reception, medtechs, pathologists, and admins. Compliance target is the
Philippine Data Privacy Act (RA 10173).

## Highlights

### Marketing site
- Full service catalog (`/all-services`), packages, physicians directory
  (live from DB with photos, schedules, and groups), online booking
  (`/schedule`), public quick-quote, contact form, privacy notice, and
  newsletter opt-in.
- Doctor booking now lets patients pick a specific physician and only
  shows that doctor's open slots, intersected with clinic closures and
  per-day overrides. Lab booking keeps the generic Mon–Sat 8:00–4:30
  grid.
- One-click unsubscribe flow at `/unsubscribe?token=…` for RA 10173
  compliance.

### Patient portal
- DRM-ID + receipt PIN sign-in with bcrypt verification, lockout after
  5 failed PIN attempts, and per-IP rate limiting on top.
- View + download released results via 5-minute server-issued signed
  URLs. Result downloads are audit-logged.

### Staff portal
- Reception flow: patients, visits, payments, appointments, queue,
  inquiries (phone-lead CRM with promote-to-booking), gift code sales.
- Lab flow: medtech queue, structured result entry with auto-generated
  PDFs (Phase 13), age-banded reference ranges, abnormal-flag
  detection, and partner-lab PDF upload fallback for send-out tests.
- Pathologist sign-off where required by service.
- Admin: services + price history, HMO providers, clinic closures,
  result templates with parameter + range editors, gift codes (mint
  batches, list with status chips, cancel), newsletter (compose
  markdown campaigns + send via Resend), physicians (CRUD + photo
  upload + schedule editor with recurring blocks and overrides),
  accounting sync settings, audit log, staff users with PRC license
  numbers, patient import.
- Quick-quote tool for reception to estimate visit totals before the
  patient commits.

### Accounting + integrations
- Daily cron at 5 PM Manila time syncs the previous day's lab,
  consultation, and procedure rows to three Google Sheets tabs in the
  exact column order the accountant expects (Phase 7C). Re-running the
  cron is idempotent; a manual re-sync UI handles backfills.
- Resend transactional email for result-ready and appointment
  confirmations.

### Security & compliance
- Strict response headers on every route: CSP (Supabase + Resend
  allowlisted), HSTS, X-Frame-Options DENY, X-Content-Type-Options
  nosniff, Referrer-Policy strict-origin-when-cross-origin,
  Permissions-Policy locking down camera / microphone / geolocation /
  payment / usb / sensors.
- Per-IP rate limiting on patient PIN sign-in, public booking, contact
  form, and newsletter signup. Server-Action-driven; fail-open on DB
  errors.
- Server-side slot validation on physician bookings: re-checks the
  chosen slot against the physician's schedule + per-day overrides +
  concurrent appointments before insert.
- Audit log captures every staff write, every patient result view /
  download, every PIN attempt, every payment, every gift code
  transition, every newsletter send.
- `SECURITY.md` documents the auth architecture, RA 10173 compliance
  summary with retention table, JWT secret rotation procedure, breach
  response runbook, backup posture, and the swap path from the in-house
  error reporter to Sentry.

### Infrastructure
- Vercel functions pinned to `sin1` (Singapore) — same region as the
  Supabase project. End-to-end RTT for a result download is
  ~50 ms vs ~250 ms on the iad1 default.
- Dependabot wired up for weekly npm + monthly GitHub Actions updates,
  with semver-major bumps held back for manual review.

## Schema baseline

19 migrations, applied in order from `0001_init.sql` through
`0018_rate_limit.sql`. Each migration is committed alongside the
feature it backs and is the source of truth for the table shape and
RLS policies. The generated `src/types/database.ts` mirrors the live
schema.

## Known unfinished work (deferred)

These were intentionally out of scope for v1 and tracked for follow-up:

- **Phase 12 — HMO receivables dashboard.** Scheduled for after a few
  months of trustworthy app data.
- **Admin MFA enforcement.** The `FEATURE_STAFF_MFA_REQUIRED` env var
  exists; the enrollment + middleware check still need to be wired.
- **Sentry integration.** A Sentry-shaped reporter (`reportError`)
  already audit-logs server crashes; swapping in `@sentry/nextjs` is a
  one-function-body change.
- **Penetration test / OWASP ZAP scan.** Out-of-band activity to do
  before public launch.
- **Supabase Pro for PITR backups.** A platform decision pending
  stakeholder budget approval.

## Operational notes

- Production URL: `https://drmedapp.vercel.app` (custom domain pending).
- Cron secret + Resend domain verification + Google Sheets service
  account must be configured in Vercel project env vars before the
  daily accounting sync runs cleanly.
- Patient session JWT secret rotation is documented in
  `SECURITY.md#patient-session-jwt-secret-rotation`. Rotate on launch.

## Stats

- 79 commits, 18 phased migrations.
- 17 staff portal routes (including admin sub-routes).
- 20 physicians + 29 recurring schedule blocks seeded from the
  pre-existing static roster.
- 14 doctor consultation services.
- 11 HMO providers.

---

# v1.15.0 — historical clinical-data backfill

Backfills the previously-empty **clinical operational layer** (`visits` /
`test_requests` / `payments`) from the legacy master sheet (Dec 2023 → app
cutover), completing the historical-data project: patients (v1.11.0) and the
accounting books (Phase 12.B, 22k `history_import` JEs) were already loaded;
this fills the operational records that sit alongside them.

## What shipped

- **Migration 0091** — adds `legacy_import_run_id` / `legacy_source_ref`
  provenance (+ partial unique/lookup indexes) to `visits`, `test_requests`,
  and `payments`, and guards the three insert-path trigger functions
  (`bridge_payment_insert`, `payments_block_after_close`,
  `bridge_test_request_released`) so legacy rows are **GL-silent** — the books
  already hold every peso, so the backfill posts **zero** new journal entries.
  `recalc_visit_payment` stays live so `payment_status` still computes.
- **Standalone importers** under `scripts/clinical-backfill/` (tested pure-logic
  lib + a dry-run → review-CSVs → `--commit --confirm` engine, mirroring the
  12.B ergonomics). Idempotent on `legacy_source_ref` (pre-loaded in-memory);
  new patients reused across runs via a stable `clinical_name_token`.
- **Portal** — released historical tests (no digital result on file) now show
  "Released — pre-system record (no digital copy on file)" instead of a bare
  "No file"; the download control stays hidden.

## Production load (released metadata; no result values — the source is a billing ledger)

- **8,081 visits**, **18,639 released test requests**, **7,276 payments**,
  **786 new patients** (2023–2026).
- **GL-silence verified: 0** journal entries reference any legacy clinical row.
- Orphan check (visit total = Σ line finals): **0**.
- Books reconciliation: clinical revenue is ~87% of booked revenue per year;
  the gap is the **1,548 ambiguous-name rows held back** for manual resolution
  (RA 10173 — never auto-assign an ambiguous patient) plus discounts/rounding.

## Follow-ups

- Resolve the held **ambiguous** rows (`tmp/clinical-*-ambiguous*.csv`) with the
  partner and import them with explicit patient assignments.
- Optionally grow the service catalog to reduce the **69 unmapped lab services**
  (currently mapped to a generic "Legacy lab test", original name preserved in
  `receptionist_remarks`).

# v1.16.0 — analytics Part A: historical enrichment

Recovers fields the clinical backfill (v1.15.0) dropped, by re-reading the legacy
master sheet once and applying **GL-silent, idempotent, batched** UPDATEs to the
already-committed legacy `visits` / `test_requests`. This is **Part A** of the
operational-analytics dashboards project (Part B — SQL views + dashboards — is a
separate plan, to be written against this enriched data).

## What shipped

- **Migration 0092** — adds nullable `visits.source_new_repeat` (`'new' | 'repeat'`).
- **Standalone enrichment importer** under `scripts/clinical-enrich/` (tested
  pure-logic lib: surname→physician map, discount-type classifier, new/repeat
  parser; a sheet reader; a batched commit engine joining committed rows by
  `legacy_source_ref`). Dry-run → review CSV → `--commit --confirm [--prod]`,
  mirroring the v1.15.0 ergonomics. Fill-NULL-only / reclassify-`custom`-only →
  re-runs are no-ops.
- **`enrich:clinical`** npm script + `validate.sql` coverage/GL-silence checks.

## Production result

- **Attending doctor** → `visits.attending_physician_id`: **1,546 of 1,605**
  legacy consults attributed (96.3%) across 16 physicians; 59 → "Other" (56
  off-roster: SEVILLEJA/JOSON/SAYSON/VILLANUEVA + ambiguous bare DANTES; ~3 blank).
  No invented physician rows.
- **Discount type** → `test_requests.discount_kind`: **5,343** rows reclassified
  from the lumped `custom` (5,291 `senior_pwd_20`, 43 `pct_10`, 9 `pct_5`); the
  type lives in the sheet's `"YES"`/`"N/A"` **flag** columns (not amounts — a
  plan-assumption correction made during the dry-run). 1,436 genuinely-unflagged
  discounts stay `custom`.
- **New vs repeat**: **0 recovered** — the sheet's "NEW / REPEAT CUSTOMER" column
  is empty across all rows. The 0092 column stays NULL; Part B computes
  new-vs-repeat from visit history. (Spec premise was incorrect.)
- **GL-silence verified: 0** JEs reference any legacy clinical row. Idempotent
  re-run: **+0**.

## Follow-ups

- **Per-doctor history is incomplete for the busiest doctors.** The consult tab
  has **7,996** rows but only **1,605** were committed by the v1.15.0 backfill,
  and the uncommitted ~6,400 are overwhelmingly the top doctors: GAYO (2,269 in
  sheet → 3 committed), R.VICENCIO (2,267 → 3), LORENZO (838 → 1), A.VICENCIO
  (282 → 0), ARCEGA (156 → 0). Mid/low-volume doctors are 80–90% covered. To get
  meaningful per-doctor trends, commit the held/uncommitted consults (ties to the
  v1.15.0 "1,548 ambiguous rows" follow-up), then **re-run `enrich:clinical`** —
  it will attribute the newly-committed rows automatically (idempotent).
- Consult `discount_amount_php` is actually the doctor PF (base − clinic fee), a
  v1.15.0 backfill artifact; Part A only relabels the *type*, not amounts. Fix
  separately if consult discount *amounts* matter.
