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
