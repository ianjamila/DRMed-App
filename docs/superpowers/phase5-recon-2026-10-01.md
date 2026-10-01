# Phase 5 recon (2026-10-01) — weekly owner email + dashboard trend

Untracked scratch note in the MAIN checkout (not committed). Copy it into the Phase 5 worktree, or delete it once the spec is written.

- **Data source.** `patient_sources_report` (0206) accepts admin or service_role. Loader: `loadPatientSourcesReport` (src/lib/marketing/patient-sources.server.ts). Revenue, referrers and overlaps RPCs are authenticated-only, so a cron must use the report. Check grants on the ad-spend loaders (`loadAdSpendTotals`, `loadAdSpendCoverage`) before calling them from a cron.
- **Cron, model: `src/app/api/cron/dedup-digest/route.ts`** (weekly, `0 1 * * 1` = Mon 09:00 Manila).
  - Auth: Bearer CRON_SECRET.
  - Wrap the run in `withCronMonitor` (src/lib/ops/cron-monitor.ts) and use `createAdminClient()`.
  - Recipients: `resolveStaffAlertRecipients(key, admin)` + `alertSkipReason`.
  - HTML: `renderEmailShell` / `emailParagraph` / `emailButton` / `emailAmountTable` (src/lib/notifications/branded-email.ts).
  - Send with `sendEmail` (src/lib/notifications/email.ts, Resend; skipped outside production).
  - Write a `<key>.sent` audit row, then `.completed`.
  - Daily model: `src/app/api/cron/stale-bookings/route.ts` + `src/lib/appointments/stale-bookings-alert.ts`.
- **A new cron needs four edits:**
  1. vercel.json
  2. `CRON_HEARTBEATS` in src/lib/ops/cron-heartbeats.ts (maxAge weekly = 8×24h; activeFrom = a UTC date after the first run, e.g. 2026-10-06+)
  3. the `.github/workflows/cron-watchdog.yml` `watched` VALUES row
  4. the workflow's schedule-count comment

  Drift tests: `cron-heartbeats.test.ts`, `cron-schedule.test.ts` (daily or weekly shapes only).
- **A new staff alert kind needs a migration.** Re-create the `staff_alert_settings.alert_key` CHECK with the new key and add a seed row, following `0186_stale_bookings_staff_alert.sql`; the latest key list is in 0192. Also update `STAFF_ALERT_KEYS` / `STAFF_ALERTS` in src/lib/notifications/staff-alerts.ts (fields: label, description, defaultRoles, sentAction). `staff-alerts.test.ts` pins the registry to the newest migration. The resolver fails OPEN: a missing row or read error counts as enabled. `defaultRoles: ["admin"]` means every active admin; per-person overrides and extra addresses live in Admin Tools › Email Alerts.
- **Dashboard** (src/app/(staff)/staff/(dashboard)/_dashboards/admin-dashboard.tsx).
  - The "New patients today" tile is fed from the Promise.all at ~L511 and rendered as a StatCard at ~L1184.
  - Card ids live in src/lib/dashboards/cards.ts (~L101, `admin.new_patients_today`, group "people", `defaultHidden` supported); `cards.test.ts` guards the list.
  - Each card needs a `show(id)` guard. There is no sparkline component. Recharts is loaded through `next/dynamic` with `ssr:false`: copy marketing/patients/_components/channel-chart-loader.tsx.
- **Periods.** There is no "last week" helper. Use src/lib/dates/manila.ts: `todayManilaISODate`, `shiftISODate`, `friendlyManilaDate`. `PATIENT_SOURCES_MIN_DATE` = 2023-12-01 (src/lib/marketing/period.ts).
- **Spec origin.** The PR2 spec §7 lists two follow-ups:
  - "A weekly 'new patients by channel' email to the owner, reusing patient_sources_summary"
  - "A per-channel trend line on the admin dashboard"

  The richer scope (served, revenue, referrers, cost per new patient, week over week) has not been decided — brainstorm it with the user.

## Scope additions the user approved for Phase 5 (2026-10-01)
1. **"Numbers as of HH:MM" line on Patient Sources.** Every card now reads one snapshot (0206), so stamp the page with the time it was read. Use `manilaTime` / `manilaDateTime` from src/lib/dates/manila.ts; never format a date inline. Consider the same stamp in the CSV header and the weekly email.
2. **People page built from the same shared code.** `patient_sources_people` (0189) still calls `_patient_sources_identities()` / `_patient_sources_encounters()` itself. Move its rules into a closed `_ps_sec_people(ids, enc, …)` helper over the 0206 arrays (`_ps_identity_list()` / `_ps_encounter_list()`), keeping it a wrapper with an identical signature, gate, paging and ACL. Prove before/after equivalence the 0206 way: freeze the old body in a ps_old fixture, use the seeded world, run controls. People page loader: `loadPeoplePage` / `loadAllPeople`.
3. **Ad rows dependency.** Cost per new patient (email and trend) is empty while prod `ad_spend_daily` has 0 rows. The email must say "no ad spend saved for this week" rather than show ₱0, and the user must click "Save them to clinic records" on Ad Performance.
