# Patient Sources Phase 5: weekly/monthly owner email, dashboard trend, "as of" stamp, people page on the shared arrays

Date: 2026-10-01 · Status: design approved in brainstorm (owner); spec revised after Codex (Astra high) + Fable (high) review; awaiting owner review
Base: origin/main 8b3e03c7 (#281, 0206 `patient_sources_report` on prod)
Recon: `docs/superpowers/phase5-recon-2026-10-01.md`
Origin: PR2 spec §7 follow-ups + Phase 5 scope additions (2026-10-01).

## 0. Facts this design rests on (verified 2026-10-01)

- **No ad spend on prod.** Prod `ad_spend_daily` has **0 rows**. Every cost figure must say "no ad spend saved" instead of ₱0 until the owner clicks **Save them to clinic records** on Ad Performance.
- **Who can call the report.** `patient_sources_report` and `patient_sources_series` admit `has_role(admin) OR coalesce(auth.role(),'')='service_role'` (0199; kept in 0206:293,388).
  - The report's jsonb holds `summary, series, current, previous, new_by_day, revenue, overlaps, referrers`, all from one snapshot.
  - `new_by_day` is always day-grain, `new` mode, over the whole `[p_from, p_to]` (0206:424-426), whatever `p_grain`/`p_mode` are.
  - `_ps_check_period` allows a future `p_to`, caps a period at 400 days and floors it at 2023-12-01.
- **The refused-call hazard.** These functions are **admin-only inside the body**, while `service_role` still holds EXECUTE: `patient_sources_revenue / _overlaps / _referrers / _people`, `ad_spend_daily_totals`, `ad_spend_coverage` and `ad_spend_rows` (0203). A service-key call to any of them is a *refused function call*, and on prod image .111 that **segfaults Postgres**.
  - Server code holding the service key never calls them.
  - The cron reads the `ad_spend_daily` table directly (columns `spend_date, platform, spend_php` + keys, 0189:711-724).
- **Admin gating follows View-as.** `has_role` follows View-as (0182), and `requireAdminStaff` gates on the **effective** role, so a View-as admin never reaches admin pages or actions. That is the existing model and this phase keeps it.
- **Sunday half day.** The clinic now opens **Sundays 8:00–12:00 (half day)**. The site update is a separate follow-up.
- **Date helpers.** There is no "last week" helper and no weekday helper in `manila.ts`. Use `todayManilaISODate`, `shiftISODate`, `isoDateParts`, `manilaDateTime`, `bucketLabel`. Never format a date inline: `date-render-surfaces.test.ts` and `manila-usage.test.ts` enforce it. `PATIENT_SOURCES_MIN_DATE` = 2023-12-01.
- **Email Alerts "Last sent".** The Email Alerts page shows a "Last sent" line from the newest `sentAction` audit row via `normaliseAlertSentMetadata`, which expects `{ recipients, sent|emailed, failed, skipped }`. The cron heartbeat/watchdog reads the `.completed` row.

## 1. PR split

| PR | Contents | SQL | Depends on |
|---|---|---|---|
| **5a** | "as of" stamp (Patient Sources page + both CSVs + Booking Sources); dashboard trend card incl. cost overlay; "New patients today" tile fed from the same report | none | — |
| **5b** | weekly + monthly owner email, per-recipient send claims, "Send me a preview", `npm run email:preview` | 1 migration (2 alert keys + send-claim table + service_role SELECT on `ad_spend_daily`) | §2 helpers from 5a (5b rebases on 5a) |
| **5c** | `patient_sources_people` rebuilt over the 0206 arrays via closed `_ps_sec_people` + equivalence proof | 1 migration | — (parallel worktree) |

- **Worktrees and numbers.** Each PR gets a fresh worktree off origin/main. Claim migration numbers with `npm run claim -- migration` at build time; no new P-codes are planned.
- **Gate.** Every PR runs `npm test`, `npm run typecheck`, `npm run lint` and `npm run build`. 5b and 5c add db proofs on an isolated stack (`npx supabase`, 2.118, ports 563xx).
- **Merging.** Bump the guide version at merge time.
- **Rollback.**
  - 5b: switch both alert keys off in Email Alerts first; nothing else depends on them.
  - 5c: a forward migration restores the frozen 0189 body (the proof fixture), with ACLs unchanged.

## 2. Shared pure helpers (`src/lib/marketing/patient-sources.ts` unless noted)

- **`asOfLabel(at: Date)`** → `` `Numbers as of ${manilaDateTime(at)}` `` (e.g. "Numbers as of Oct 1, 2026, 9:14 AM"). It is the only stamp text, used by the page, both CSVs, Booking Sources, the card, the email and the preview script.
- **`isoWeekday(iso)`** → 0–6 via `new Date(`${iso}T00:00:00Z`).getUTCDay()`, built in UTC exactly like `shiftISODate`. It lives in `manila.ts` next to `shiftISODate`; if a lint/usage test objects, it goes in an allowlist entry with a `why`.
- **Periods:**
  - `lastCompletedWeek(todayISO)` → the Mon–Sun week before the week containing `todayISO`. On a Monday that is the 7 days ending yesterday.
  - `previousWeek(p)` → the Mon–Sun before `p`.
  - `lastCompletedMonth(todayISO)` / `previousMonth(p)` → calendar months, leap-February safe.
  - Each result goes through `comparisonPeriod(…, PATIENT_SOURCES_MIN_DATE)`. A previous period that would start before 2023-12-01 → `null` ("no comparison"). A **current** period that would start before the minimum date makes the digest builder return `{ kind: "too_early" }`; the cron completes without sending (only reachable via `--today` in the preview script).
- **`weeklyBuckets(newByDay, weeks, topN = 5)`** → per-week totals per channel. The top 5 channels by total over the window are kept and the rest fold into "Other". Labels come from the existing channel label function.
- **`weeklyCostPerNew(spend, newByDay, weeks)`** → applies `costPerNewPatient` to each week's slice.
  - Combined = total spend ÷ total matching new across both platforms.
  - `null` when the week has no spend or no new patients.
  - The rule is unchanged: only days with spend count, and the denominator is confirmed + unconfirmed.
- **Change helpers:**
  - `channelDeltas(current, previous)` → `{ channel, now, before, change, pct }`, with `now`/`before` = confirmed + unconfirmed. `pct` is `null` when `before = 0`. It includes channels that are zero now but were positive before.
  - `biggestMover(deltas)` → the largest `|change|` where `|change| ≥ 3`. Ties go to the larger `|pct|` (null ranks last), then to channel-table order. Returns `null` otherwise.
- **`sundayObservation(curServedByDay, prevServedByDay, labels)`** → an **observation, never a cause**:
  - It fires when the current period has served ≥1 on a Sunday and the previous period recorded none on Sunday.
  - Output: "Sunday activity was recorded this {week|month} ({n} served); none was recorded on Sunday the {week|month} before."
  - Otherwise it returns `null`. No claim about opening hours.

## 3. PR 5a: stamp, trend card, tile

### 3.1 "Numbers as of" stamp
- **Page.** `marketing/patients/page.tsx` captures `readAt = new Date()` after the report resolves and renders `asOfLabel(readAt)` as muted small text under the header, beside the sync-status line. One snapshot (0206) makes one stamp true for the whole page.
- **CSVs.** `reportCsvResponse` gains an optional `asOf?: string`.
  - It is written as an **in-band trailing line**, after the rows and after any TRUNCATED note, the same way the existing truncation note is written.
  - It is never counted in `rowsExported` (which uses `args.rows`), and the header stays row 1 so spreadsheets parse it.
  - Both `patient-sources.csv` and `patient-sources-people.csv` pass it.
  - Existing route tests (`sent.rows` equals `seriesCsvRows(...)`) stay valid; add assertions for the trailing line and the unchanged `rowsExported`.
- **Booking Sources.** `marketing/sources/page.tsx` shows the same stamp, read after its loaders resolve. It says when the page read its numbers and makes no single-snapshot claim.

### 3.2 Trend card `admin.patient_sources_trend`
- **Registration.** Lives in `src/lib/dashboards/cards.ts`, group `"people"`, visible by default, guarded by `show("admin.patient_sources_trend")`. `cards.test.ts` is updated.
- **Data, one call.** `loadPatientSourcesReport(supabase, { from: W1.from, to: today, grain: "week", mode: "new", prev: null })`.
  - W1..W8 are the 8 completed Mon–Sun weeks ending last Sunday.
  - The bars, "this week so far" (Monday → today) and the cost overlay all come from `new_by_day`.
  - Plus `loadAdSpendTotals(supabase, W1.from, W8.to)`: the admin session on the admin-only dashboard, the existing caller pattern.
- **Render.** A client chart via `next/dynamic({ ssr:false })`, copying `channel-chart-loader.tsx`.
  - Stacked bars W1..W8, with x labels from `bucketLabel("week", …)`. Top 5 channels + Other, with a legend.
  - Headline: "Last week **N** ▲x% vs the week before". When W7 = 0 it shows "(none the week before)" in place of the percentage.
  - Sub-line: "This week so far: N".
- **Cost overlay.**
  - When any week has spend: a line on a secondary ₱ axis for combined cost per new patient. Weeks without spend are `null` gaps, never zero.
  - When there is no spend in the window: no line, and the footnote "Cost per new patient appears once ad spend is saved (Ad Performance → Save them to clinic records)".
- **Footer.** `asOfLabel(readAt)` · "Open Patient Sources →" (`/staff/marketing/patients?from=W1.from&to=W8.to&grain=week&mode=new`). Only the footer link navigates, so chart tooltips keep working.
- **Errors.** If the report fails, the dashboard's standard per-card error state shows. If ad spend fails, the bars still render, with the footnote "Couldn't load ad spend".
- **Accessibility.** The chart wrapper has `role="img"` and an `aria-label` summarising last week and the change, plus a visually-hidden weeks × channels table.

### 3.3 "New patients today" tile from the same report
- When the trend card is shown, the tile reads today's rows from that report's `new_by_day`. Those rows are identical by construction to `loadNewPatientsToday`, which is the same `_ps_sec_series(..., 'day', 'new')`. When the card is hidden, the tile keeps `loadNewPatientsToday`.
- Test: a pure mapping test (fixture → same `formatNewToday` output as before).

## 4. PR 5b: owner emails

### 4.1 Migration (claimed at build)
1. **Alert keys.** Re-create `staff_alert_settings_key_check` with the **full literal list**: the newest list (0192's seven at time of writing; re-grep) plus `patient_sources_weekly` and `patient_sources_monthly`. Seed both rows as 0186 does. `staff-alerts.test.ts` pins the registry to the *last* CHECK across sorted migrations.
2. **Send-claim table `public.patient_sources_digest_sends`:**
   - Columns: `alert_key text`, `period_from date`, `period_to date`, `recipient text` (lower-cased), `status text check (status in ('sending','sent','failed'))`, `attempts int not null default 1`, `provider_id text`, `last_error text`, `updated_at timestamptz not null default now()`.
   - `primary key (alert_key, period_from, recipient)`.
   - RLS enabled with no policies. `revoke all … from public, anon, authenticated`; `grant select, insert, update on … to service_role`. Server code only.
3. **Grant.** `grant select on public.ad_spend_daily to service_role`. Prod has it from Supabase default privileges; a fresh replay gets it only via seed.sql, so the isolated-stack proof would otherwise differ from prod.
4. **Post-checks in the migration** (0206-style DO block): the CHECK contains every key, both seed rows exist, the claim table has no anon/authenticated grants, and RLS is on.

### 4.2 Registry entries (`STAFF_ALERT_KEYS` / `STAFF_ALERTS`)
- **Weekly**
  - Key: `patient_sources_weekly`
  - Label: "Weekly patient sources"
  - Description: "Monday 7:00 AM: last week's new patients by channel, served, revenue, top referrers and cost per new patient, compared with the week before."
  - `defaultRoles: ["admin"]`, `sentAction: "system.patient_sources_weekly.sent"`
- **Monthly**
  - Key: `patient_sources_monthly`
  - Label: "Monthly patient sources"
  - Description: "1st of the month, 8:00 AM: the same for last month vs the month before."
  - `sentAction: "system.patient_sources_monthly.sent"`
- The resolver fails open (a missing row or read error counts as enabled), which is acceptable for an owner digest.

### 4.3 Cron routes
- **Schedules:**
  - `/api/cron/patient-sources-weekly`: `0 23 * * 0` UTC = **Monday 07:00 Manila**, before the 8am opening.
  - `/api/cron/patient-sources-monthly`: `0 0 1 * *` UTC = **1st 08:00 Manila**. "Last day 23:00 UTC" is not expressible as a cron.
- **Model.** `dedup-digest/route.ts`: `Bearer CRON_SECRET`, `withCronMonitor`, `createAdminClient()`, `resolveStaffAlertRecipients` + `alertSkipReason`.
- **Per-recipient send, idempotent:**
  1. **Claim.** `insert … values (key, from, to, recipient, 'sending') on conflict (alert_key, period_from, recipient) do update set status='sending', attempts = attempts+1, updated_at = now() where patient_sources_digest_sends.status = 'failed' or (patient_sources_digest_sends.status = 'sending' and patient_sources_digest_sends.updated_at < now() - interval '15 minutes') returning recipient`. No row returned → already sent or in flight → count as `skipped` for this run.
     - This is one atomic statement via a tiny closed SQL function `_ps_digest_claim(...)`, granted to service_role only, or a PostgREST upsert if it can express the WHERE. Decide at plan time; the function is the default.
  2. **Send** with `sendEmail({ …, idempotencyKey: `${key}:${from}:${recipient}` })`.
     - `sendEmail` gains an optional `idempotencyKey`, sent as Resend's `Idempotency-Key` header.
     - A crash after Resend accepted the email but before it was recorded is then de-duplicated by Resend on retry, within Resend's window.
  3. **Record.** `sent` with `provider_id`, or `failed` with `last_error`. A `skipped` result from `sendEmail` (non-production) → mark the row `failed` with the reason, so a production re-run is not blocked. A record-write error is logged and calls `markFailed()`, never thrown after a send.
- **Audit (sentAction).** `system.patient_sources_{weekly|monthly}.sent` with `{ period_from, period_to, recipients, sent, failed, skipped, recipients_error? }`, the dedup-digest shape plus the period, so the Email Alerts "Last sent" line reads correctly. It is written on every run that resolved recipients.
- **Heartbeat.** `.completed` is written on **every non-throwing path**: disabled/skip reason, zero recipients, all-already-sent, `too_early`, and success. Any `failed > 0` → `markFailed()`.
- **Retry.** Recipients that failed are retried by re-triggering the cron (manual Vercel "Run" or `curl` with CRON_SECRET). Sent recipients are never re-sent. Documented in the guide's admin notes.
- **Four cron edits each** (recon):
  - `vercel.json`
  - `CRON_HEARTBEATS`: weekly maxAge 8×24h; monthly `interval '32 days'`, which the watchdog regex accepts.
  - the `.github/workflows/cron-watchdog.yml` `watched` row
  - the schedule-count comment
- **activeFrom.**
  - Weekly: the first run is Sunday 23:00 UTC, so activeFrom = the following Monday (UTC date).
  - Monthly: the 1st of the first month after merge + 1 day.
- **`describeCronSchedule` monthly.** Gains a monthly shape ("On the 1st of every month at 8:00 AM"), applying the same `dayShift` as the weekly case: an hour ≥ 16 UTC moves to the 2nd in Manila. `cron-schedule.test.ts`'s "every registered schedule" regex is widened to accept the monthly sentence, with new monthly cases.

### 4.4 Data gathering: `loadPatientSourcesDigest(admin, period: "week"|"month", todayISO)`
`src/lib/marketing/patient-sources-digest.server.ts`; two report calls, each one snapshot per period.
1. **Periods.** `cur` and `prev` per §2. `too_early` → return early.
2. **Current period.** `loadPatientSourcesReport(admin, { ...cur, grain: "day", mode: "served", prev: null })`:
   - `summary` → new / served / returning;
   - `series` → served by day per channel (Sunday observation, served totals);
   - `new_by_day` → new by day, and new by channel = `totalsByChannel(new_by_day)`, identical to the 'period' grain because identities bucket by `first_date` (0206:139-148);
   - `revenue`, `referrers`.
3. **Previous period.** The same call for `prev`, when it is non-null.
4. **Ad spend.**
   - `admin.from("ad_spend_daily").select("spend_date, platform, spend_php")` over `[prev?.from ?? cur.from, cur.to]`, paged with `.range` under a **total order**: `.order("spend_date").order("platform").order("campaign_key").order("ad_key")`, or the table's full unique key (verify at build).
   - Any page error → the whole digest fails; a partial spend read never produces a number.
   - Rows are aggregated in TS to `SpendTotalRow` (sum per date × platform). A test proves equivalence with `ad_spend_daily_totals` on a multi-page fixture: repeated dates/platforms, distinct campaign/ad keys, more than 1,000 rows.
   - A separate `count: "exact", head: true` on the whole table tells "nothing ever saved" from "none this period".
5. **Read time.** `readAt = new Date()` after the report calls.
6. **Result.** A typed `DigestData`, or a `ReportResult` failure, or `too_early`.

**Never-call list for this module:** revenue/overlaps/referrers/people single RPCs, `ad_spend_daily_totals`, `ad_spend_coverage`, `ad_spend_rows`. A unit test asserts the module source contains none of those RPC names.

### 4.5 Content: pure `renderPatientSourcesDigest(data, { appUrl, period })` → `{ subject, html, text }`
`src/lib/marketing/patient-sources-digest.ts`; HTML via `renderEmailShell` + existing `email*` helpers; every dynamic string goes through `escapeHtml`. Labels come from `bucketLabel("week"|"month", cur.from)` / `manilaDate`, never hand-built.
1. **Subject:** `Patient sources, {period label}: {N} new ({▲|▼|=} {Δ})`. Without a comparison: `…: {N} new`.
2. **Data health** (only when it applies): the page's own `sheetBanner(summary)` text verbatim. It covers app-only (no sheet rows), partial/failed last run, and paused, so no invented failure dates. A null summary field → no line.
3. **Headline:** New `formatNewCounts`, Served, Returning (first recorded), each with ▲/▼/= and the absolute change, or "no comparison".
4. **Biggest mover:** the `biggestMover` line, or "No channel moved by more than 2."
5. **Sunday observation** when non-null.
6. **Day row (weekly only):** Mon … Sat, "Sun (half day)": new per day; served per day as a second row.
7. **New by channel:** channel · this · previous · change. Every channel non-zero in either period, so falls to zero stay visible, in channel-table order.
8. **Revenue by channel:** confirmed ₱, plus an unconfirmed column only if any are non-zero; total vs previous total.
9. **Top 5 referrers:** doctor · new (confirmed + unconfirmed), or "No referring doctor recorded this {week|month}."
10. **Cost per new patient:** per platform, spend · new on spend days · cost, with the previous cost.
    - When the period has no spend rows: "No ad spend saved for this {week|month}."
    - When the table is empty: also "Ad spend is saved from Ad Performance → Save them to clinic records."
    - Never ₱0.
11. **Footer:** `asOfLabel(readAt)` as fine print, then the button "Open Patient Sources" (`/staff/marketing/patients?from=…&to=…&grain=day&mode=new`).
12. **Fine print:** a one-sentence confirmed/unconfirmed explanation in the page's wording, plus "You get this as an admin; change it in Admin Tools › Email Alerts."

**Empty states are per section.** Zero new patients does not hide served/returning, revenue, referrers-vs-before or the channel table when the previous period had any. A section is omitted only when it is empty in **both** periods; the headline then reads "No new patients recorded this {week|month}". `text` is the plain-text rendering of the same sections.

### 4.6 "Send me a preview" (Email Alerts)
- **Placement.** The two new rows in `admin/settings/alerts` get a **Send me a preview** button.
- **Action.** `sendPatientSourcesPreviewAction(period)` is modelled on `sendTestAlertAction` (actions.ts:341-399):
  - `requireAdminStaff()`, the effective-role gate, the same as every action on this page;
  - `createAdminClient()` → `loadPatientSourcesDigest` → render;
  - send to the **caller's own email only**, subject prefixed `[Preview] `, no idempotency key;
  - audit `staff_alert.preview_sent` with `{ alert_key, period_from }`, actor = staff.
- **It never touches the claim table or `.sent`.**
- **Skipped sends.** When `sendEmail` returns `skipped`, the action returns its `reason` (the shared `emailStatus()` wording) and not success. No rate limit, matching the sibling.
- **UI.** Pending state + inline result line, matching the page's existing test-alert feedback.

### 4.7 `npm run email:preview`
- **Command.** `tsx --require ./scripts/lib/server-only-shim.cjs scripts/email-preview.mts patient-sources [--month] [--today YYYY-MM-DD] [--prod --yes]`, following the package.json precedent for scripts importing `server-only`.
- **Output.** Writes `tmp/email-preview/patient-sources-{week|month}-{from}.html` + `.txt` and prints the paths. `too_early` prints a message and exits 0.
- **Environment.** Local/isolated by default. `--prod --yes` is a read-only target and needs no `--confirm`. It never sends, never claims, never audits. `.mts` is covered by the guard-coverage test.

## 5. PR 5c: `patient_sources_people` over the shared arrays

- **New helper `public._ps_sec_people(p_ids _ps_identity[], p_enc _ps_encounter[], p_from date, p_to date, p_mode text, p_channel text, p_limit int, p_offset int)`.**
  - It returns the same table shape: `identity_kind, identity, patient_id, drm_id, display_name, first_date, total_count`.
  - The body holds the 0189 rules moved verbatim, reading `unnest(p_ids)` / `unnest(p_enc)` in place of `_patient_sources_identities()` / `_patient_sources_encounters()`.
  - It keeps the name lookups (`sheet_encounter_lines` then `sheet_customer_rows` fallback, survivor join) exactly as written.
  - `security definer`, `search_path = ''`, `revoke all … from public, anon, authenticated, service_role`, matching 0206's `_ps_sec_*`.
- **`public.patient_sources_people(...)` itself.**
  - Kept **identical**: signature, return type, volatility, security, search_path, gate (admin-only check + error), argument validation, paging (limit/offset, `total_count`) and ACL.
  - Its body becomes gate → validation → `return query select * from public._ps_sec_people(public._ps_identity_list(), public._ps_encounter_list(), …)`.
  - Grants untouched; `service_role` keeps EXECUTE, because a revoke would make a refused call.
- **`mirror-readers.test.ts` allowlist:** add the new migration (the body names both mirror tables). This is definite.
- **Proof** (same harness as the 0206 proof, isolated stack):
  1. **Freeze.** Freeze the 0189 body into `scripts/fixtures/patient-sources-people-pre-<N>.sql` under schema `ps_old`, like `patient-sources-pre-0206.sql`.
  2. **Seeded world, non-vacuous.** It must contain:
     - unconfirmed identities whose `display_name` resolves via **each** fallback (encounter lines, then customer rows);
     - a null-name identity;
     - `is_returning` identities;
     - merged patients (a survivor join hit);
     - several channels incl. `not_recorded`;
     - served encounters with several dates per identity.
     The proof first asserts non-zero counts per category, so an empty category fails the run.
  3. **Grid.** Compare `ps_old.patient_sources_people` with the new function **row for row (ordered) and on `total_count`** across:
     - modes `new | returning | served`;
     - channels: each seeded channel, `not_recorded`, an unknown channel and null;
     - periods: one-day, the min date, an empty period, a 400-day period;
     - paging: offset 0, a middle page, past the end, limit 1, and null/out-of-range limit/offset;
     - invalid inputs (bad mode, `p_to < p_from`, before the min date), which must give the same SQLSTATE + message.
  4. **Gate parity.** The non-admin error is unchanged (SQLSTATE + message) and View-as behaviour is unchanged.
     - Denial probes run **only on the isolated stack**, whose image must not be one that segfaults on a refused call. Record the image version in the proof output.
  5. **ACL and definition.** `proacl` of `patient_sources_people` is byte-equal before/after. `_ps_sec_people` has no EXECUTE for anon/authenticated/service_role, and its body contains no `service_role` literal (0206:525-style check). `pg_get_function_identity_arguments` and the result type are identical.
  6. **Controls that must FAIL**, each run against a scratch copy:
     - drop the channel filter;
     - off-by-one on `first_date`;
     - wrong `total_count`;
     - drop the survivor left join;
     - first instead of `min(service_date)` in served;
     - drop the customer-rows name fallback.
  7. **Performance.** Before/after timing of one page call on the seeded world, and on prod after the push (`explain analyze` via a read-only admin path or the existing timing script), recorded in the PR.
- **App side.** Loaders `loadPeoplePage` / `loadAllPeople` are unchanged; regenerated types are expected to have no diff.

## 6. Testing summary

- **Pure unit tests:**
  - §2 helpers: month/year boundaries, leap February, Sunday-UTC vs Monday-Manila, min-date clamping incl. `too_early`, top-5 folding, `biggestMover` ties/threshold, `weeklyCostPerNew` gaps, and the Sunday observation for prev-none / both-none / incomplete data.
  - Digest render: no-spend wording and never "₱0" for missing spend; table-empty hint; each `sheetBanner` state; zero-new with non-zero revenue; current-zero/previous-positive channels; monthly wording; no comparison; escaping.
  - `describeCronSchedule` monthly incl. a day shift.
- **Spend aggregation:** the multi-page equivalence fixture (§4.4).
- **Cron route tests:**
  - 401 without the secret;
  - a skip reason → no send + `.completed`;
  - all recipients already claimed → no send;
  - two concurrent invocations (claim returns one winner) → each recipient emailed once;
  - partial failure → `failed` rows retried on re-run, `sent` rows not;
  - non-production `skipped` → row `failed`, not blocking;
  - report failure → no send + failed monitor;
  - idempotency key passed to `sendEmail`;
  - audit metadata shape read back through `normaliseAlertSentMetadata`.
- **Preview action:** non-admin refused; sends only to the caller; a `skipped` reason is surfaced; no claim/`.sent` written.
- **Module guard:** the digest module never names the never-call RPCs.
- **Card:** render tests for the empty / no-spend / spend / error states; `show()` hides it; tile mapping equivalence.
- **DB:** 5b migration proof (CHECK + seeds + existing keys intact, claim-table ACL/RLS, the claim function's concurrency on two sessions) and the 5c equivalence proof, both on the isolated stack.
- **Browser smoke** (Playwright, authed local :4000 or cookie injection): the Patient Sources stamp, the dashboard card, and the Email Alerts preview button (the non-production reason is shown).

## 7. Out of scope / follow-ups
- Update the public site's opening hours to include **Sunday 8am–12pm**: contact page, promo pages, `OpenNowPill`, structured data, the slot-picker decision. This is an owner reminder after this phase.
- A channel-drop alert (>50% two weeks running); attaching the CSV to the email.
- Phase 6 (Sheet Sync PR 3 small tabs): brainstorm → spec (effort high) → owner approval.
