# Patient Sources Phase 5 — weekly/monthly owner email, dashboard trend, "as of" stamp, people page on the shared arrays

Date: 2026-10-01 · Status: design approved in brainstorm (owner), spec awaiting review
Base: origin/main 8b3e03c7 (#281, 0206 `patient_sources_report` on prod)
Recon: `docs/superpowers/phase5-recon-2026-10-01.md` (moved here from the main checkout)
Origin: PR2 spec §7 follow-ups + Phase 5 scope additions (2026-10-01).

## 0. Facts this design rests on (verified 2026-10-01)

- Prod `ad_spend_daily` has **0 rows**. Every cost figure must say "no ad spend saved" instead of ₱0 until the owner clicks **Save them to clinic records** on Ad Performance.
- `patient_sources_report` (0206) is gated to `has_role(admin) OR coalesce(auth.role(),'')='service_role'`, so a cron can call it with the service key. The jsonb result holds `summary, series, current, previous, new_by_day, revenue, overlaps, referrers`, all from one snapshot.
- `ad_spend_daily_totals` / `ad_spend_coverage` are **admin-only inside the body**, while `service_role` still holds EXECUTE. A service-key call to them would be a *refused function call*, and on prod image .111 that segfaults Postgres. **Server code that holds the service key must never call them.** The cron reads the `ad_spend_daily` table directly; `service_role` has SELECT and bypasses RLS.
- The same hazard applies to a **View-as** admin session: `has_role` follows View-as (0182), so an admin viewing as reception would be refused. A server action that uses the caller's session may call admin-only RPCs only after `has_role` is true for the effective role. Code paths in this phase that must work whatever role is being viewed (the preview action) use the service client after a real-role check.
- The clinic now opens **Sundays 8:00–12:00 (half day)**. The public site still says Mon–Sat; that is a separate follow-up, not this phase.
- There is no "last week" helper. Use `todayManilaISODate`, `shiftISODate`, `isoDateParts`, `manilaDateTime`, `manilaTime` from `src/lib/dates/manila.ts`, and never format a date inline. `PATIENT_SOURCES_MIN_DATE` = 2023-12-01.

## 1. PR split

| PR | Contents | SQL | Depends on |
|---|---|---|---|
| **5a** | "as of" stamp (Patient Sources page + CSV + Booking Sources); dashboard trend card incl. cost-per-new-patient overlay; "New patients today" tile fed from the same report | none | — |
| **5b** | weekly + monthly owner email, shared digest builder, "Send me a preview" in Email Alerts, `npm run email:preview` | 1 migration (2 alert keys) | the stamp helper from 5a (or duplicate the 3-line helper if 5b lands first) |
| **5c** | `patient_sources_people` rebuilt over the 0206 arrays via closed `_ps_sec_people` + equivalence proof | 1 migration | — (parallel worktree) |

Each PR gets a fresh worktree off origin/main. Claim migration numbers with `npm run claim -- migration` at build time; P-codes only if a new raise is added (none planned). Gate: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. 5b and 5c also need db proofs on an isolated stack (`npx supabase`, repo-pinned 2.118, ports 563xx). Bump the guide version at merge time.

## 2. Shared pure helpers (`src/lib/marketing/patient-sources.ts` unless noted)

- `asOfLabel(at: Date): string` → `"Numbers as of 9:14 AM, Thu 1 Oct 2026"`, built from `manilaDateTime`/`manilaTime` (whichever matches the existing format; no inline formatting). One helper, used by the page, both CSVs, Booking Sources, the card, the email and the preview script.
- `lastCompletedWeek(todayISO)` → `{ from: Monday, to: Sunday }` of the most recent **complete** Mon–Sun week strictly before the week containing `todayISO` (Manila). On a Monday this is the 7 days ending yesterday.
- `previousWeek(p)` → the Mon–Sun before `p`.
- `lastCompletedMonth(todayISO)` / `previousMonth(p)` → calendar months.
- Each of these is clamped through `comparisonPeriod(…, PATIENT_SOURCES_MIN_DATE)`, so a comparison that would start before 2023-12-01 becomes `null` ("no comparison").
- `weeklyBuckets(newByDay, weeks: {from,to}[], topN=5)` → per-week totals per channel, with the top 5 channels by total over the window and the rest folded into "Other". Labels use the existing channel label function. Pure and unit-tested.
- `weeklyCostPerNew(spend, newByDay, weeks)` → for each week, run `costPerNewPatient` on that week's slice. Combined cost = total spend ÷ total matching new over both platforms, `null` when there is no spend or no new patients. It reuses the existing rule: only days with spend count, and the denominator is confirmed + unconfirmed.
- `channelDeltas(current, previous)` → rows `{channel, now, before, change, pct}` where `now`/`before` = confirmed + unconfirmed. `pct` is `null` when `before = 0`.
- `biggestMover(deltas)` → the row with the largest `|change|` where `|change| ≥ 3`. Ties go to the larger `|pct|` (`null` pct ranks last), then to the channel's position in the channel table. Returns `null` when nothing moved by 3 or more.
- `sundayNote(newByDay|servedByDay current, previous)` → returns `"The {previous label} had no Sunday clinic, so part of the change is the extra half day."` only when the current period has ≥1 encounter (served, any channel) on a Sunday **and** the previous period has none. Otherwise `null`. The check is data-driven, with no hard-coded start date. Weekly and monthly both use it.

## 3. PR 5a — stamp, trend card, tile

### 3.1 "Numbers as of" stamp
- **Patient Sources page** (`marketing/patients/page.tsx`): capture `const readAt = new Date()` right after the report promise resolves. Render `asOfLabel(readAt)` as muted small text under the page header, next to the existing sync-status line. Every card reads that one snapshot (0206), so a single stamp is true for the whole page.
- **CSV** (`api/admin/reports/patient-sources.csv/route.ts`): the first line is `# Numbers as of …`, then the existing header.
  - Check the existing CSV tests for a byte-exact header and update them.
  - If the CSV is consumed by any importer in-repo, keep the comment line out of that path; grep before deciding.
  - The people CSV (`patient-sources-people.csv`) gets the same first line.
- **Booking Sources** (`marketing/sources/page.tsx`): same stamp, read time = after its loaders resolve. Its several loaders are not one snapshot. The stamp still says when the page read them, which is accurate. Do not claim a single snapshot.

### 3.2 Trend card `admin.patient_sources_trend`
- Registered in `src/lib/dashboards/cards.ts` in group `"people"`, visible by default, guarded by `show("admin.patient_sources_trend")`. Update `cards.test.ts`.
- **Data, one call:** `loadPatientSourcesReport(supabase, { from: W1.from, to: today, grain: "week", mode: "new", prev: null })`, where W1..W8 are the 8 completed weeks ending last Sunday and the window runs on to today. Bars come from `new_by_day` via `weeklyBuckets` (the weekly `series` would also work, but `new_by_day` serves both the bars and the cost overlay from one array). "This week so far" = the sum of `new_by_day` from this Monday to today.
  - Plus `loadAdSpendTotals(supabase, W1.from, W8.to)`. This is the admin session on the admin dashboard; that loader is admin-gated, which is fine here.
- **Render:** a client chart through `next/dynamic({ ssr:false })`, copying `marketing/patients/_components/channel-chart-loader.tsx`.
  - Stacked bars W1..W8 (x labels "15 Sep"…), top 5 channels + Other, and a legend.
  - Headline: "Last week **N** ▲x% vs the week before". When W7 = 0 it shows "(no patients the week before)" instead of a percentage.
  - Sub-line: "This week so far: N".
  - **Cost overlay:** when any week has spend, a line on a secondary axis shows combined cost per new patient (₱), with a small legend entry. Weeks without spend leave a gap (`null`) and are not drawn as zero. When there are no spend rows in the window, show no line and add the footnote "Cost per new patient appears once ad spend is saved (Ad Performance → Save them to clinic records)".
  - Footer: `asOfLabel(readAt)` · "Open Patient Sources →", linking to `/staff/marketing/patients?from=W1.from&to=W8.to&grain=week`. Match the page's real query-param names; check `parseGrain`/period parsing.
  - The whole card is not a link. Only the footer link is, so the chart tooltips still work.
- **Errors:** if the report fails, the card shows the dashboard's standard inline error state for a card ("Couldn't load patient sources"); other cards are unaffected. If ad spend fails, draw the bars without the overlay and add a footnote.
- **Accessibility:** the chart has `role="img"` and an `aria-label` summarising the last week and the change. A visually-hidden table lists weeks × channels.

### 3.3 "New patients today" tile from the same report
- When the trend card **or** the tile is shown, the dashboard makes the single report call above, and the tile reads today's rows from `new_by_day`. Only when the trend card is hidden *and* the tile is shown does it keep `loadNewPatientsToday` (cheaper). Existing tile wording comes from the existing formatter.
- Test: given a report fixture, the tile values equal those that `loadNewPatientsToday` would produce for the same rows (pure mapping test).

## 4. PR 5b — owner emails

### 4.1 Alert keys (migration, claimed at build)
- Two keys, so people can opt in to each separately:
  - `patient_sources_weekly`: label "Weekly patient sources", description "Monday 7:00 AM: last week's new patients by channel, served, revenue, top referrers and cost per new patient, compared with the week before."
  - `patient_sources_monthly`: label "Monthly patient sources", description "1st of the month, 8:00 AM: the same for last month vs the month before."
  - Both `defaultRoles: ["admin"]`, sentAction `patient_sources_weekly.sent` / `patient_sources_monthly.sent`.
- Migration: re-create the `staff_alert_settings_key_check` CHECK with the full current key list plus the two new keys, and seed the rows. Follow `0186_stale_bookings_staff_alert.sql`, and take the latest list from the newest migration that touched the check (0192 at time of writing; re-grep at build). Update `STAFF_ALERT_KEYS`/`STAFF_ALERTS` and `staff-alerts.test.ts`.
- Reminder: the resolver **fails open**, so a missing row or a read error counts as enabled. That is acceptable for an owner digest (see memory "notification registry fails open").

### 4.2 Cron routes
- `/api/cron/patient-sources-weekly`: `0 23 * * 0` UTC = **Monday 07:00 Manila**, before the 8am opening.
- `/api/cron/patient-sources-monthly`: `0 0 1 * *` UTC = **1st of the month 08:00 Manila**. A cron cannot express "last day 23:00 UTC", so 08:00 is the earliest clean slot.
- Model: `api/cron/dedup-digest/route.ts`.
  - Auth is `Bearer CRON_SECRET`, and the run is wrapped in `withCronMonitor`.
  - Data comes from `createAdminClient()`, recipients from `resolveStaffAlertRecipients` + `alertSkipReason`, and sending uses `sendEmail`.
  - Audit rows: `<key>.sent` with `{ period_from, period_to, recipients }`, then `.completed`.
- **Idempotency:** before building, look for an audit row with action `<key>.sent` and `period_from = <from>` in the last 40 days. If one exists, log a skip, audit `.skipped_duplicate` and complete. This is a new guard; the dedup digest has none. It is needed because the preview button and manual re-triggers make double sends plausible. The preview action does **not** write `.sent`.
- **Four cron edits each** (recon): `vercel.json`, `CRON_HEARTBEATS`, `.github/workflows/cron-watchdog.yml` `watched` row, and the schedule-count comment.
  - Heartbeat maxAge: weekly 8×24h, monthly 32×24h.
  - activeFrom: the weekly key gets a UTC date after its first run (the Monday after merge + 1 day). The monthly key gets the day after the first 1st-of-month after merge.
  - `describeCronSchedule` has no monthly shape. Extend it ("On the 1st of every month at 8:00 AM") and `cron-schedule.test.ts`. The watchdog's `maxAge` comparison must allow 32 days.

### 4.3 Data gathering — `loadPatientSourcesDigest(admin, period: "week"|"month", todayISO)`
New module `src/lib/marketing/patient-sources-digest.server.ts`.
1. Periods: `cur = lastCompletedWeek|Month(today)` and `prev = previousWeek|Month(cur)`, clamped (`prev` may be null).
2. `loadPatientSourcesReport(admin, { ...cur, grain: "day", mode: "new", prev })` gives the summary (new/served/returning), `current` and `previous` new by channel, `new_by_day`, revenue and referrers for `cur`.
3. When `prev` is set, `loadPatientSourcesReport(admin, { ...prev, grain: "day", mode: "new", prev: null })` gives the previous summary, revenue and `new_by_day` for the week-over-week numbers and the cost comparison.
4. A served-by-day check for `sundayNote` uses `loadPatientSourcesSeries(admin, from, to, "day", "served")` for cur and prev. That call is safe: `patient_sources_series` admits service_role (0199, and the 0206 wrapper keeps the same gate). It needs at most 31 days × channels rows, so it takes one page. **Do not** call anything that would refuse service_role (revenue/overlaps/referrers single RPCs, ad-spend RPCs, people).
5. Ad spend: `admin.from("ad_spend_daily").select("spend_date, platform, spend_php")` for `[prev?.from ?? cur.from, cur.to]`, paged with `.range` (one row per ad per day can exceed 1,000 a month). Aggregate in TS to `SpendTotalRow` (sum per date × platform), then `costPerNewPatient` per period. Also `select count(*)` of the whole table (head:true) to tell "no ad spend saved at all" from "none this week".
   - Verify the table's real columns at build; the aggregate must match what `ad_spend_daily_totals` returns (compare in the isolated-stack proof).
6. `readAt = new Date()` after the report calls.
7. Return a typed `DigestData` or a `ReportResult` failure.

### 4.4 Content — pure `renderPatientSourcesDigest(data, { appUrl, period })` → `{ subject, html, text }`
New module `src/lib/marketing/patient-sources-digest.ts`; HTML via `renderEmailShell` + `emailParagraph`/`emailHighlight`/`emailAmountTable`/`emailDetailBox`/`emailButton`/`emailFinePrint`. Section order:
1. **Subject:** `Patient sources — week of 28 Sep: 41 new (▲ 8)` / `Patient sources — September: 162 new (▼ 12)`.
2. **Data health** (only when it applies), shown first as a detail box:
   - "Sheet Sync is paused — numbers include sheet rows up to {sheet_last_dates}" when `sync_paused`;
   - "Last Sheet Sync run {failed|partly failed} on {date}" for `last_run_status` other than succeeded;
   - "Sheet Sync hasn't run since {date}" when `last_synced_at` is older than 3 days.
3. **Headline:** New patients `confirmed (+ unconfirmed)` via the existing `formatNewCounts`, Served, Returning (first recorded), each with ▲/▼/= and the absolute change vs prev. When `prev` is null: "no comparison".
4. **Biggest mover** line (`biggestMover`), or "No channel moved by more than 2."
5. **Sunday note** (`sundayNote`) when non-null.
6. **Day row (weekly only):** Mon … Sat, "Sun (half day)", with new patients per day.
7. **New by channel table:** channel · this period · previous · change. Every channel with a non-zero value in either period, in the page's channel-table order.
8. **Revenue by channel** (confirmed ₱, with unconfirmed in a second column only if any are non-zero) and the total vs prev total.
9. **Top 5 referrers:** doctor · new (confirmed + unconfirmed). Shows "No referring doctor recorded" when empty.
10. **Cost per new patient:** per platform (Meta, Google): spend, new patients on spend days, cost; with prev cost.
    - When the period has no spend rows: "No ad spend saved for this week/month."
    - Additionally, when the table is empty: "Ad spend is saved from Ad Performance → Save them to clinic records."
    - Never ₱0.
11. `asOfLabel(readAt)` (fine print), then the button "Open Patient Sources", linking to `/staff/marketing/patients?from=…&to=…&grain=day`.
12. The fine print explains confirmed vs unconfirmed in one sentence, matching the page's wording, plus "You get this because you're an admin; change it in Admin Tools › Email Alerts."

`text` is a plain-text rendering of the same sections. All dynamic strings go through `escapeHtml`.

**Zero period:** still sent, with headline "No new patients recorded last week" and the tables omitted except health and cost. **Failure:** if any report call fails, throw inside `withCronMonitor` (`markFailed`). No email is sent and nothing is audited as `.sent`.

### 4.5 "Send me a preview"
- In Admin Tools › Email Alerts (`admin/settings/alerts`), the two new rows get a **Send me a preview** button.
- Server action `sendPatientSourcesPreview(period)`:
  - **real-role** admin check: the same check the alerts page uses for writes; confirm it does not follow View-as, or use the un-View-as role helper;
  - `createAdminClient()`, then `loadPatientSourcesDigest` + render;
  - send **only to the caller's own email**, with subject prefixed `[Preview] `;
  - audit `<key>.preview_sent`.
- Outside production `sendEmail` skips. The action then returns "Email sending is off outside production — run `npm run email:preview` to see it" and does not report success. Rate limit: one preview per user per minute (in-memory guard per instance is enough; it's a convenience).
- UI: pending state on the button and an inline result line, matching the existing alerts client's feedback pattern (no toast library if the page doesn't use one).

### 4.6 `npm run email:preview`
`scripts/email-preview.mts patient-sources [--month] [--today YYYY-MM-DD] [--prod --yes]`:
- builds the digest and writes `tmp/email-preview/patient-sources-{week|month}-{from}.html` plus a `.txt`, then prints the paths;
- defaults to the local/isolated env;
- `--prod` follows the scripts env-guard pattern (`--confirm`/`--yes`, see memory drmed-script-env-guard). It only reads; it never sends and never audits.

## 5. PR 5c — `patient_sources_people` over the shared arrays

- New closed helper `public._ps_sec_people(p_ids _ps_identity[], p_enc _ps_encounter[], p_from date, p_to date, p_mode text, p_channel text, p_limit int, p_offset int)`.
  - It returns the same table shape as `patient_sources_people` (`identity_kind, identity, patient_id, drm_id, display_name, first_date, total_count`).
  - Its body holds the rules moved verbatim from the 0189 body. The only change is reading from the arrays (`unnest(p_ids)`, `unnest(p_enc)`) instead of `_patient_sources_identities()` / `_patient_sources_encounters()`.
  - `security definer`, `search_path = ''`, `revoke all … from public, anon, authenticated, service_role`, matching the other `_ps_sec_*` helpers in 0206.
- `public.patient_sources_people(...)` keeps the **identical signature, return type, volatility, security, search_path, gate (admin only, same check + error), argument validation, paging semantics (limit/offset, total_count), and ACL**. It becomes: gate → validation → `return query select * from _ps_sec_people(_ps_identity_list(), _ps_encounter_list(), …)`.
  - Do not touch grants; `service_role` keeps EXECUTE exactly as today. Any revoke would turn into a refused call, and that is the segfault hazard.
- **Proof** (`scripts/` alongside the 0206 proof, same harness):
  1. Freeze the current 0189 body into `scripts/fixtures/patient-sources-people-pre-<N>.sql` under schema `ps_old`, the way `patient-sources-pre-0206.sql` does it.
  2. On the seeded world, compare `ps_old.patient_sources_people` with the new function **row for row (ordered) and on total_count** across modes × channels (incl. `not_recorded` and an unknown channel) × periods (incl. one-day, the min date, and a period with no rows) × pages (offset 0, a middle page, past the end, limit 1).
  3. Gate: the non-admin error is unchanged (same SQLSTATE + message) and the View-as behaviour is unchanged.
  4. ACL: grants on `patient_sources_people` are byte-equal before/after (`aclexplain`/`proacl`), and `_ps_sec_people` has no grants for anon/authenticated/service_role.
  5. Controls that must FAIL: mutate one rule in a scratch copy (e.g. drop the channel filter, an off-by-one on `first_date`, wrong `total_count`) and show the comparison catches each (M-style controls as in 0206).
  6. Function definition: `pg_get_function_identity_arguments` and result type identical.
- Loaders `loadPeoplePage` / `loadAllPeople` stay unchanged. App tests stay green with no app diff beyond regenerated types (expect none).
- Update `mirror-readers.test.ts` allowlist if the migration names a mirror table.

## 6. Testing summary

- Pure unit tests:
  - all §2 helpers, with periods across a month/year boundary, `PATIENT_SOURCES_MIN_DATE` clamping, and Sunday and top-5 folding;
  - `biggestMover` ties and thresholds;
  - `weeklyCostPerNew` gaps;
  - `renderPatientSourcesDigest` snapshot-style assertions on key strings: no-spend wording, never "₱0" for missing spend, health box, zero period, escaping, no comparison;
  - `describeCronSchedule` monthly.
- Route tests for both crons: unauthorised → 401; skip reason → no send; duplicate → no send; report failure → no send + failed monitor; happy path → `sendEmail` called once per recipient set plus `.sent` audit.
- Alerts action test: non-admin refused, sends to caller only, non-production message.
- Card: render test for the empty / no-spend / spend / error states, and that `show()` hides it.
- DB: the 5b migration proof (CHECK + seeds, existing keys intact) and the 5c equivalence proof, both on the isolated stack.
- Browser smoke (Playwright, authed local on :4000 or the cookie-injection recipe): Patient Sources stamp, dashboard card, Email Alerts preview button (non-production message).

## 7. Out of scope / follow-ups
- Update the public site's opening hours to include **Sunday 8am–12pm** (contact page, promo pages, `OpenNowPill`, structured data, slot picker decision). Owner reminder after this phase.
- Channel-drop alert (>50% two weeks running); attach the CSV to the email.
- Phase 6 (Sheet Sync PR 3 small tabs) — brainstorm → spec (effort high) → owner approval.
