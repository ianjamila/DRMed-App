# Sheet Sync + Patient Sources — design (v2)

**Date:** 2026-09-24 · **Branch:** `feat/sheet-sync` · **Status:** v2, revised after Fable + Codex (astra/high) review — see §12 for the finding-by-finding log.

## 1. Why

Reception still works in the old Google Sheet **"LAB SERVICES (RECEPTION)"**
(`199CjfHAO9XqVJ1Yty4eheqCTkg1CJn9YtmPeR6muVDM`, edited daily). The app's copy of
that data stops at 2026-05-25: the Customers tab was imported once on 2026-05-25 and
LAB SERVICE / DOCTOR CONSULTATION were backfilled 2026-06-03..05 with a window ending
`2026-05-26` (`scripts/clinical-backfill/engine.ts:24`). Prod has 3 live app-native
visits after that date.

The owner wants:
1. The app kept current **from the live sheet, automatically**, with **Pause sync** for
   the day the clinic moves to the app exclusively.
2. **Patient-acquisition stats** — customers per day by channel (Facebook / Google /
   walk-in / …) from the Customers tab's "How did you know about DR Med?".

### Owner decisions (2026-09-24)

| Question | Decision |
|---|---|
| Sync mode | Automatic nightly sync + **Sync now** + **Pause sync**, in-app (approach A) |
| Count unit | **Both, toggle**: default *New customers*; toggle *All customers served* |
| Channel list | **Expanded** (§4.1); existing patients re-sorted; original text kept |
| Sync scope | Customers, Lab Service, Doctor Consultation, Doctor Procedure HMO, Home service, Gift codes, Flyers, **Books** |
| Clinical data (after review) | **Reporting copy nightly + one-time conversion at switch-over.** Sheet lab/consult rows are mirrored into reporting-only tables each night; they become real visits/tests/payments (and books) **once**, from the frozen sheet, when an admin presses *Final sync, then pause*. Money screens never see mirror rows. |
| Cross-section ideas | all accepted: cost per new patient, channel revenue, top referring doctors, dashboard tile, front-desk "how did you hear" prompt |

**Accepted trade-off:** until switch-over, the existing revenue/operations dashboards stay
at May; only Patient Sources (incl. channel revenue) reflects sheet activity since.

## 2. What exists (verified 2026-09-24 by two independent reviews)

**Sheet** (service account `drmed-sheets-writer@…` has Viewer): 25 tabs.
- `CUSTOMER LIST2`: 4,870 named rows. Col 16 source answer (72 spellings, 784 blank),
  17 Referred By, 18 release medium, 19 New/Repeat (2,065 NEW / 393 REPEAT), 20 Timestamp.
  Form rows (`DD/MM/YYYY HH:MM:SS`) are rows ~1,314–3,382 and run to **today**; rows 2–1,403
  and 3,426–4,265 are manual named-month dates; **609 undated rows at 4,269–4,878**
  (938 blank timestamps overall). Junk values exist (`GCASH`, `0`, `June 28`,
  `Feb 10,20255`, `APRIL 23,20-25`, `#N/A`). 94 names occur more than once; 3 exact
  duplicate rows (same name, phone, DOB).
- `LAB SERVICE`: 21,504 named rows, last today, 2,943 dated ≥ 2026-05-26. **TEST NO is not
  unique** (one number spans 4 lines; descends 29 times). Payment method col 14
  (CASH 1,602 · HMO 497 · GCASH 364 · CARD PAY 350 · BPI 86 · BDO 32 · blank 12 since
  cutover), split payments as free text in col 15, release medium col 16, DATE RELEASED
  col 17 (blank on 1,769 of 2,943). No ₱0 rows since cutover.
- `DOCTOR CONSULTATION`: 9,047 named rows to 2026-09-19 (lags lab); 960 ≥ cutover; only 6
  rows carry a control number, none a test number; one row dated `Aug 30, 3034`.
- Small tabs: `DOCTOR PROCEDURE HMO` 79, `HOME SERVICE REQUESTS` 43, `GC Codes` 49 (codes
  already match `^GC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$`), `FLYERS` (code grid, few dispatched).

**App** (prod head migration 0156; next 0157, next P-code P0054):
- `patients.referral_source` → FK `referral_sources` (12 ids). NULL 2,769 · walk_in 1,106 ·
  other 981 · customer_referral 777 · doctor_referral 634 · online_facebook 546 · … The
  2026-05 mapper sent blank → `other` and lumped family/friends into customer_referral.
- Customers-tab imports: 4,290 live + 130 merged (`merged_into_id`), original answer in
  `legacy_intake.raw`. Backfill-created patients: 2,718 (no source). 176 `patient.merged` audits.
- `patient.updated` audit metadata carries no field list (`patients/[id]/edit-actions.ts:115`);
  audit writes never block the action (`src/lib/audit/log.ts:33`) → audit absence proves nothing.
- The June engine is **historical-only**: marks every non-HMO line collected
  (`engine.ts:218`), inserts every line `released` (`engine.ts:396`), drops ₱0 rows
  (`classify.ts:16`), groups by `tab|control_no` else `tab|name|date` (`engine.ts:204`),
  writes visit/lines/payment in separate statements.
- Rows with `legacy_import_run_id` are GL-silent (0091) but still counted by
  `cash_drawer_state` (0149 ~l.450), still claimable by the HMO claim builders
  (`hmo-claims/actions.ts:63–79,156–172`), and still exported by
  `src/lib/accounting/sync.ts` (no legacy filter; watermarks lab 2026-07-26, consult 2026-07-04).
- Payment amount UPDATEs do not recalc `visits.paid_php` (recalc on insert 0001 and void 0111 only).
- `historic_hmo_claims.source_tab` allows only LAB SERVICE / DOCTOR CONSULTATION and
  `source_row` is integer (0076:62). `gift_codes` redeemed ⇒ linked visit required (0013:51).
- Data-retention cron purges only `rate_limit_attempts` and `visit_pins`.
- `eod_close_records` is empty on prod (EOD never used yet).
- Ad spend lives only in the browser (Ad Performance CSV → localStorage).

## 3. Architecture

```
Google Sheet ─(ONE values.batchGet, all tabs, UNFORMATTED_VALUE + SERIAL_NUMBER)─► reader.ts
     ▼
tabs/*.ts  parse + validate → typed rows (+ issues)            [pure, unit-tested]
     ▼
runSheetSync(): lease → per tab: snapshot-replace mirror (one RPC, one transaction)
                               → Customers: link/create patients (strict rules, §5.3)
                               → review items   → run summary → release lease
     ▼
Reporting: v_patient_acquisition / RPCs read  visits (≤ 2026-05-25 + app-native) ∪ mirror (≥ 2026-05-26)
Switch-over (PR 4): frozen mirror → real visits/test_requests/payments, atomically per encounter
Books (PR 5): converted records → journal entries, DB-enforced posting identity
```

- **One library, three callers** — cron route, admin *Sync now* action, CLI
  (`scripts/sheet-sync.ts`, env-guarded, dry-run default) all call
  `runSheetSync({ trigger, actorId, dryRun })` in `src/lib/sheet-sync/`, with an injected
  service-role client.
- **Reader:** a single `values.batchGet` over all enabled tabs with
  `valueRenderOption=UNFORMATTED_VALUE`, `dateTimeRenderOption=SERIAL_NUMBER` — true date
  cells arrive as serials, text cells as their text, currency as numbers; one request ⇒ one
  consistent snapshot. JWT auth factored out of `src/lib/accounting/google-sheets.ts` into
  `google-auth.ts` with a **per-scope** token cache (`spreadsheets.readonly` here). Response
  size/row-count sanity checks (a tab shrinking by >5% vs the last run aborts that tab as
  `suspect_snapshot` — protects against a sort/filter/truncation mid-edit).
- **Mirror, not import, for clinical rows.** Because the mirror is replaced wholesale per run
  within the window, sheet corrections simply overwrite, deletions disappear, and unstable
  row identity cannot create duplicates. Nothing downstream (money, HMO, GL, export) reads
  mirror tables — enforced by a repo test (§11).

## 4. Data model — migration 0157 (PR 1)

### 4.1 Channels

`referral_sources` gains `channel_group text not null default 'other'` (check in
`online, walk_in, referral, direct_contact, partner, returning, other`) and rows:

| id | label | group | sheet answers like |
|---|---|---|---|
| online_facebook | Facebook | online | FACEBOOK (ONLINE), FACEBOOK, FB |
| online_google | Google | online | GOOGLE (ONLINE) |
| online_website | Website | online | WEBSITE (ONLINE) |
| online_instagram / online_tiktok | Instagram / TikTok | online | (existing, unused) |
| walk_in | Walk-in | walk_in | WALK-IN, WALK IN |
| **walk_in_signage** | Walk-in (saw poster/signage) | walk_in | WALK-IN (SAW POSTER / SIGNAGE) |
| doctor_referral | Doctor referral | referral | DOCTOR REFERRAL, DOCTOR'S REFFERAL, DOCTO'S REFFERAL… |
| customer_referral | Customer referral | referral | CUSTOMER REFERRAL, CUSTOMER'S REFFERAL |
| **family_friends** | Family / friends | referral | FAMILY / FRIENDS, FAMIL/FRIENDS, FRIENDS/FAMILY… |
| **phone_text_viber** | Phone call / text / Viber | direct_contact | PHONE CALL, VIBER, CALL/TEXT |
| **flyers** | Flyers | other | FLYERS |
| **partner_corporate** | Partner / corporate | partner | LIKHAAN, WOMEN'S, GICA… |
| tenant_employee_northridge | Northridge tenant / employee | partner | NORTHRIDGE… |
| returning_patient | Returning patient | returning | RETURNING PX, OLD PATIENT, OLD PX |
| gift_code | Gift code | other | GIFT CODE |
| **prefer_not_to_say** | Prefer not to say | other | PREFER NOT TO SAY |
| other | Other | other | typed answers matching nothing |

"**Not recorded**" = `referral_source IS NULL` (display label only).

**Mapper** `src/lib/sheet-sync/referral-mapper.ts`: normalise (uppercase, strip punctuation,
collapse spaces, typo folds) → (1) `referral_source_aliases` exact lookup
(`raw_normalized text pk`, `referral_source_id` FK, `created_by`, `created_at`) → (2) ordered
rules → (3) blank → NULL → (4) else `other` + `unmapped_source` review item.

**Field ownership.** New `patients.referral_source_origin text` check in
`('staff','sheet','legacy_import')`. A `BEFORE UPDATE` trigger sets it to `'staff'` whenever
`referral_source` changes **unless** the transaction-local setting `drmed.sheet_sync = 'on'`
(set only inside sync RPCs). Staff New-Patient inserts default to `'staff'`. The sync may
change `referral_source` only when it is NULL, or when origin is `'sheet'`/`'legacy_import'`
(never `'staff'`) — checked in the same conditional `UPDATE … WHERE` (atomic, no
check-then-write race). This also makes alias re-application safe.

**Re-sort of existing patients** — a separate CLI step (`scripts/sheet-sync-resort.ts`,
dry-run → `--commit --confirm`), not part of the nightly sync: for patients with
`legacy_intake.raw` and `merged_into_id IS NULL`, if `referral_source = oldMapper(raw)` set
origin `'legacy_import'` and apply `newMapper(raw)`; otherwise mark origin `'staff'`
(conservative: provenance unknown ⇒ treat as staff-owned). Before-images go to
`sheet_sync_changes` (§4.2) so the batch is reversible.

### 4.2 Control tables (all RLS on; SELECT policy `has_role(array['admin'])`; no write policies)

- **`sheet_sync_settings`** (singleton, `booking_settings` shape): `paused boolean not null
  default true` (**seeded paused** — nothing runs until an admin has reviewed a dry-run and
  unpaused), `paused_at`, `paused_by`, `pause_reason`, `mirror_window_start date not null
  default '2026-05-26'`, `final_synced_at`, `converted_at`, `updated_at`. Sheet id stays in env
  (`LEGACY_SHEET_ID`).
- **`sheet_sync_runs`**: `id`, `trigger` (`cron|manual|cli`), `actor_id`, `dry_run`,
  `status` (`running|succeeded|partial|failed|skipped_paused`), `lease_token uuid`,
  `heartbeat_at`, `started_at`, `ended_at`, `per_tab jsonb`, `error`.
  Unique partial index `on sheet_sync_runs ((status)) where status = 'running'`.
- **Lease + fencing.** `sheet_sync_acquire(trigger, actor)` (security definer, service_role
  only) atomically: if a `running` row has `heartbeat_at` within 10 min → refuse; otherwise
  mark it `failed ('lease expired')` and insert a new row with a fresh `lease_token`. Every
  write RPC takes `p_lease_token` and begins `select … from sheet_sync_runs where
  lease_token = p_lease_token and status = 'running' for update` — a worker whose lease
  was taken over fails its next write instead of overlapping. The runner renews
  `heartbeat_at` between tabs and every 500 rows.
- **`sheet_sync_review_items`**: `id`, `run_id`, `tab`, `item_key` (stable per issue so reruns
  update, not duplicate — unique `(kind, item_key)` where open), `kind` (`ambiguous_patient`,
  `identity_conflict`, `unmapped_source`, `unparseable_date`, `invalid_row`,
  `suspect_snapshot`), `payload jsonb`, `status (open|resolved|dismissed)`, `resolution jsonb`,
  `resolved_by`, `resolved_at`. Payloads hold names ⇒ admin-only; audit metadata carries ids and
  kinds only, never names.
- **`sheet_sync_changes`** (before-images): `run_id`, `patient_id`, `column_name`, `old_value`,
  `new_value`, `changed_at`. Written in the same statement as every sync patient update.
  A per-run **revert** restores `old_value` only where the current value still equals
  `new_value` (a later staff edit wins). Patients created by a run are soft-reverted by the
  existing batch path only if nothing references them.
- **`sheet_patient_links`**: durable identity decisions — `source_key` (see §5.3), `patient_id`,
  `method` (`auto_exact|admin`), `decided_by`, `decided_at`. Survives mirror refreshes.

### 4.3 Mirror tables (reporting only)

- **`sheet_customer_rows`**: `sheet_row int`, `source_key text`, `full_name_raw`,
  `name_norm`, `phone_norm`, `dob date`, `registered_on date` (nullable), `source_raw`,
  `referral_source_id` (mapped), `referred_by_raw`, `new_repeat` (`new|repeat|null`),
  `release_medium_raw`, `patient_id` (nullable), `link_state`
  (`linked|ambiguous|conflict|unlinked`), `row_hash`, `run_id`.
- **`sheet_encounter_lines`**: `tab` (`lab|consult|procedure_hmo|home_service`), `sheet_row`,
  `service_date date`, `name_norm`, `name_raw`, `patient_id` (nullable), `identity_key`
  (`patient:<uuid>` or `name:<name_norm>`), `service_raw`, `doctor_raw`, `hmo_raw`,
  `base_php`, `final_php`, `payment_method_raw`, `payment_detail_raw`, `release_medium_raw`,
  `released_on date`, `control_no`, `test_no`, `row_hash`, `run_id`. Only rows with
  `service_date >= mirror_window_start` and `≤ today (Manila)`.
- **`sheet_small_rows`** (PR 3): gift codes / flyers as typed jsonb rows keyed by natural key.

Refresh = `sheet_mirror_replace(p_lease_token, p_tab, p_rows jsonb)` — one transaction:
fence check → `delete … where tab = p_tab` → insert all rows. Readers never see a half-written
tab. Retention: mirror tables are purged 30 days after `converted_at` (PR 4); resolved review
items after 90 days — both added to the data-retention cron in the PR that creates them.

## 5. PR 1 — foundation, channels, Customers sync, clinical mirror, admin page

### 5.1 Dates (per cell, never per block)

- Serial number → calendar date by integer arithmetic (`serial − 25569` days from 1970-01-01
  as an ISO date via `isoDateParts`-style math); fractional part ignored for dates. No
  `new Date()` truncation (`manila-usage.test.ts`).
- Text: `D/M/YYYY H:MM:SS` (with time) → D/M; `M/D/YYYY` (no time) → M/D (empirically: all
  1,130 slash dates with day > 12 carry a time; all 16 with month-slot > 12 do not);
  named-month forms (`Dec 1, 2024`, `March 16,2024`, `SEPT 3,2024`) → named.
- Range check `2023-12-01 ≤ d ≤ today (Manila)`; otherwise `unparseable_date`
  (catches `3034`, `20255`, `20-25`, `June 28`) and the date is NULL.

### 5.2 Clinical mirror

Lab and consult rows (window ≥ 2026-05-26) are parsed and snapshot-replaced. Each line gets
`identity_key`: `patient:<id>` when its name resolves to exactly one patient via
`sheet_patient_links` or an exact full-name match with no conflict (§5.3); otherwise
`name:<name_norm>`. Nothing else is written. Consult rows lagging lab (last consult
2026-09-19 vs lab 2026-09-24) are shown per tab on the admin page as "sheet last updated".

### 5.3 Customers sync — identity rules

- `source_key` = `sha1(name_norm ‖ phone_norm ‖ dob ‖ registered_on)`; exact duplicates
  (same key) collapse to one row with a count.
- **Candidates** = live patients (`merged_into_id IS NULL`; a merged row resolves to its
  survivor) whose normalised **full** name (all tokens, not just surname + first token)
  equals the row's.
- **Auto-link** only if: exactly one full-name candidate **and** no hard conflict
  (both DOBs present and different ⇒ conflict; both phones present and different ⇒ soft,
  allowed only when DOB matches). Decision saved to `sheet_patient_links`.
- **Review (`ambiguous_patient`)**: several full-name candidates, or zero full-name but ≥1
  loose (surname + first token) candidate — the loose matcher from
  `scripts/clinical-backfill/lib/names.ts` is used **only to find suggestions**, never to link.
- **Review (`identity_conflict`)**: sole candidate with a hard conflict.
- **Create patient**: zero full-name and zero loose candidates. `legacy_intake.source =
  'sheet_sync:CUSTOMER LIST2'`, `raw`, `registered_on`; origin `'sheet'`.
- **Fill blanks** on linked patients via `sheet_sync_fill_patient(p_lease_token, …)`: one
  conditional `UPDATE … SET col = coalesce(col, new) … WHERE id = … RETURNING` per patient,
  before-images to `sheet_sync_changes`, `referral_source` governed by §4.1 ownership.
- A row whose key changed (edited in the sheet) is re-matched; the full-name rule usually
  finds the same patient; a changed name with no full-name match goes to review — never a
  silent duplicate. `sheet_patient_links` decisions by admins persist across edits for the
  same `name_norm ‖ dob` pair.

### 5.4 Pause, cron, admin page

- **Paused:** cron records `skipped_paused` and writes heartbeat `sheet_sync.skipped`
  (listed in the heartbeat's `actions` beside `sheet_sync.completed`, like
  `accounting.sync.skipped`), so the watchdog stays honest. *Sync now* is disabled while paused
  except for **dry-run**. Pause/resume audited (`sheet_sync.paused/resumed`, no names).
- **Partial:** a tab failure sets run `partial`; `withCronMonitor` reports error for
  `partial|failed`; the admin page shows which tab failed and why.
- **Cron** `/api/cron/sheet-sync`, `0 16 * * *` UTC (00:00 Manila), `maxDuration = 300`,
  `CRON_SECRET`, `withCronMonitor('sheet-sync')`, `actor_type 'system'` (manual = `'staff'`).
  Added in all three places with `active_from` = merge date + 2 days. The initial catch-up
  (≈4.9k customer rows, ≈3.9k mirror rows) runs through the CLI first; the page records its
  duration as evidence the nightly run fits in 300 s.
- **Admin page** `/staff/admin/sheet-sync` (Admin Tools): status + switch
  (`src/components/ui/switch.tsx`), per-tab last read / rows / issues / "sheet last updated",
  *Sync now* (dry-run toggle shows the plan: patients to create/link/fill, mirror counts),
  run history (paged, not capped), review queue with resolvers (pick patient / create new /
  map answer to channel → writes alias and re-applies / dismiss). Every resolve audited.
- **User guide** section for Sheet Sync ships in this PR.

### 5.5 Security

RLS on every new table, admin-only SELECT, no write policies. Every RPC `security definer`,
`set search_path = ''`, `revoke all … from public`, `grant execute … to service_role` only
(sync RPCs) — functions are born closed since 0119; `seed.sql` tail mirrors revokes
(`seed-grant-parity.test.ts`). Server actions: `requireAdminStaff()` then service-role RPC.
Direct-access tests (local DB) for anon, portal-patient JWT, reception, inactive staff, admin.

## 6. PR 2 — Marketing › Patient Sources

**Definitions** — one SQL function `patient_sources_series(p_from date, p_to date,
p_grain text, p_mode text)` (`security definer`, `grant execute to authenticated`, body starts
with `if not has_role(array['admin']) then raise exception using errcode = '42501'`):

- **Encounter stream** = (a) live visits (`deleted_at is null`) with `visit_date <
  mirror_window_start`, or app-native (`legacy_import_run_id is null`) on any date; ∪
  (b) `sheet_encounter_lines` (≥ window start). Identity = `patient:<id>` / `name:<norm>`.
  Legacy visits end 2026-05-25 and the mirror starts 2026-05-26, so they are disjoint by
  construction; app-native + mirror on the same day for the same linked patient count once.
  After conversion (PR 4) the mirror is gone and (a) covers everything.
- **New customers on D** = identities whose first encounter since **1 Dec 2023** is D,
  **excluding** those whose Customers-tab row says REPEAT/OLD (counted separately as
  "Returning, first time in our records"). Labelled on screen: *"first visit recorded since
  Dec 2023"*. Customers-tab rows with `registered_on` but no encounter count on
  `registered_on`. Undated identities are a footnote count, never on a day.
- **All customers served on D** = distinct identities with an encounter on D.
- **Channel** = patient's `referral_source` (or the customer row's mapped source for
  `name:` identities that match a customer row by `name_norm`); else Not recorded.
- `created_at` fallbacks use `(created_at at time zone 'Asia/Manila')::date`.

**UI** `/staff/marketing/patients` "Patient Sources" (admin, like all Marketing): presets
(Today, Yesterday, Last 7 days, This month, Last month, Custom), grain Day/Week/Month,
stacked bar chart per channel (recharts via `next/dynamic` like `ad-charts.tsx`), toggle
New / All served, table (count, share, change vs previous period), click-through to the
patient list (linked identities) or a name list (admin, audited `patient_sources.viewed`),
CSV via the report-CSV pattern (RLS-scoped server client, admin gate, row ceiling, audit row).

**Cross-section (accepted):**
- **Channel revenue** — billed amount on the service date: `test_requests.final_price_php`
  (live rows, both deleted filters) for (a), `final_php` for mirror lines; excludes voided/
  deleted; labelled "billed", not "collected".
- **Top referring doctors** — normalised `referred_by` (Customers tab + `patients.referred_by_doctor`).
- **Admin dashboard tile** "New today: 3 Facebook · 1 Google · 5 walk-in" via Dashboard Cards.
- **Front-desk prompt** — reception visit flow asks "How did you hear about us?" when
  `referral_source` is NULL (optional, one click, origin `'staff'`); `/register` gains the
  same optional question.
- **Cost per new patient** — `ad_spend_daily (spend_date, platform meta|google,
  campaign_key, spend_php, impressions, clicks, uploaded_by, uploaded_at,
  unique(spend_date, platform, campaign_key))`; the Ad Performance upload also upserts here
  (re-upload of the same day/campaign replaces it; multiple ads in one campaign are summed
  before upsert). Meta ↔ Facebook, Google ↔ Google; shown only for days with spend.
- User-guide section ships in this PR.

## 7. PR 3 — small tabs (mirror only)

Home service, Doctor Procedure HMO → `sheet_encounter_lines` (`tab` values above; they feed
"All served" and channel revenue); GC Codes, Flyers → `sheet_small_rows`. Patient Sources
gains gift-code and flyer counts. No writes to `gift_codes`, `historic_hmo_claims` or any
money table before conversion.

## 8. PR 4 — switch-over conversion (from the frozen sheet)

Prerequisites merged **and deployed first** (own small PR 4a):
- `src/lib/accounting/sync.ts`: all three fetchers and their watermark advance exclude
  `legacy_import_run_id is not null` (visits and test_requests); mutation-checked test per fetcher.
- `cash_drawer_state` and EOD collections exclude payments with `legacy_import_run_id`.
- HMO claim builders (`hmo-claims/actions.ts`) and `v_hmo_unbilled` exclude legacy lines —
  **owner of historical HMO receivables = `historic_hmo_claims` via Books (PR 5)**.
- `historic_hmo_claims`: `source_tab` check gains `DOCTOR PROCEDURE HMO`; new
  `source_key text` + unique `(source_tab, source_key)`; existing integer `source_row` kept.

Conversion (PR 4b), only when `paused` and the last run `succeeded`:
1. **Final sync, then pause**: a full run; completes only if every tab `succeeded` and there
   are no open `ambiguous_patient`/`identity_conflict` items — or the admin explicitly defers
   named items, whose encounters are then held (listed on the page) instead of converted.
   Sets `final_synced_at`, `paused = true`.
2. **Encounter = (tab, service_date, patient_id)**; lines of the same encounter across rows
   form one visit. Lines without a linked patient create the patient first under §5.3 rules.
3. **Lifecycle rules (from real columns):** payment method present and not `HMO` ⇒ one
   payment per method (split text parsed; unparseable ⇒ review) with `received_at` = service
   date; `HMO` ⇒ visit `hmo_provider_id` from `hmo_raw`, no payment; blank method ⇒
   `unpaid`, line status `ready_for_release`, never `released`. Lines are `released` only
   when paid/HMO **and** (`released_on` or release medium present); otherwise
   `ready_for_release`. ₱0 lines are kept as ₱0 lines.
4. **Atomic per encounter:** `sheet_convert_encounter(p_lease_token, p_payload jsonb)` inserts
   visit + lines + payments + a `sheet_conversion_map(tab, sheet_row_hash, visit_id,
   test_request_id, payment_id)` row in one transaction; `legacy_import_run_id` = the
   conversion's `legacy_import_runs` row; `legacy_source_ref = 'sheet:<tab>:<row_hash>'`.
   Retrying skips encounters already in the map (idempotent); an injected failure between
   inserts leaves nothing behind (tested).
5. Duplicate guard: an app-native live visit for the same patient/date ⇒ encounter held for
   review, not converted.
6. Gift codes → `gift_codes` (redeemed only when the redeeming visit converted; else held).
7. Rollback: delete-by-run for rows nothing references; otherwise reported, never forced.
8. Verification report: per-day counts and billed totals, sheet vs converted, must match
   before the mirror is purged.

## 9. PR 5 — Books

From converted records only (frozen — no later corrections to chase):
- `sheet_books_postings (business_date, tab, source_version text, journal_entry_id,
  status)` with **unique `(business_date, tab) where status = 'posted'`**.
- `sheet_post_books_day(p_date, p_tab)` (security definer, service_role; admin action):
  one transaction — eligibility checks (not already posted; no overlap with the May history
  import's `xlsx <TAB> r<N>` rows, which reach 2026-05-26..30; not an EOD-closed day), JE +
  lines + posted status + posting row. An interrupted attempt leaves nothing.
- Screen: per day, "ready to post" totals and the lab/consult lag; **Post day** / **Post
  range**; a posted day is reversed only by an explicit **Reverse** that posts a reversing JE.
- HMO receivables for converted HMO lines are booked here into `historic_hmo_claims`.

## 10. PR 6 — cut-over hygiene

Duplicate-count check (sheet-converted vs app-native per day, last 30 days), retire the June
CSV worksheets now covered by the review queue, remove the mirror purge guard after
verification, final guide pass.

## 11. Testing and acceptance

- **Unit (vitest):** date parser over every distinct timestamp string in today's sheet
  (fixture of values only — no names); mapper over all 72 source spellings (none of the known
  ones may land in `other`); identity rules (full-name vs loose, DOB conflict, merged
  survivor, duplicates); snapshot sanity (shrink >5%); ownership (staff edit sets origin);
  lease fencing (stale worker's write rejected); pause ⇒ `skipped_paused` + heartbeat;
  partial ⇒ monitor error; cron three-place drift tests.
- **Repo guard:** a test that fails if any file outside `src/lib/sheet-sync/` and the Patient
  Sources report reads `sheet_encounter_lines`/`sheet_customer_rows` (keeps mirror data out
  of money surfaces).
- **Local DB integration** (replayed stack): RLS/ACL direct-access matrix; snapshot replace
  atomicity; conditional fill never overwrites; revert restores only untouched values;
  >1,000-row reconciliation of `patient_sources_series` against a hand count.
- **Evidence before unpausing on prod:** CLI dry-run against the real sheet with counts
  (create/link/fill/review) reviewed by the owner; catch-up duration logged.
- PR 4/5: failure-injection between inserts; retry idempotency; per-day reconciliation.

## 12. Review log (Fable + Codex astra/high, 2026-09-24)

| # | Finding | Resolution |
|---|---|---|
| F-P0-1 / C | Accounting export would re-export legacy rows | PR 4a, deployed before any conversion; also watermark; per-fetcher mutation tests. Mirror phase creates no visits, so the trap is not armed by PR 1–3. |
| F-P0-2 / C-2 | TEST NO not unique; no visit key; corrections re-key | Clinical rows are mirrored by snapshot replace (identity-free); conversion keys encounters as (tab, date, patient) from the frozen sheet. |
| F-P1-1 / C-2 | Edited consult rows ⇒ duplicate visits | Same — no live visit creation. |
| F-P1-2 | Merged patients ignored | Candidates exclude `merged_into_id`; merged rows resolve to survivor. |
| F-P1-3 / C-9 | Audit-based "untouched" checks vacuous | `referral_source_origin` + trigger + conditional UPDATE; unknown provenance ⇒ staff-owned. |
| F-P1-4 | HMO double AR | Owner = `historic_hmo_claims` via Books; claim builders + `v_hmo_unbilled` exclude legacy (PR 4a). |
| F-P1-5 | Customers structure/date claims wrong; junk dates; year 3034 | §2 corrected; per-cell parsing + range check (§5.1). |
| F-P1-6 | "New" overstated | "first visit recorded since Dec 2023"; REPEAT rows excluded to "Returning"; undated footnote. |
| C-1 | Sole-candidate name match unsafe | Full-name equality + DOB hard conflict + loose matcher suggestions only (§5.3). |
| C-3 | Encounter consistency; payment updates don't recalc | Conversion inserts only (no updates), atomic per encounter with map row. |
| C-4 | Historical engine assumes paid/released, drops ₱0 | Live-lifecycle rules from real columns (§8.3); ₱0 kept. |
| C-5 | Imported payments move cash drawer | `cash_drawer_state`/EOD exclude legacy payments (PR 4a). |
| C-6 / F-P2-2 | Stale lock admits overlap | Lease + heartbeat + fencing token checked in every write RPC. |
| C-7 / F-P2-1 | Books idempotency / corrections | DB-unique posting identity, one-transaction posting, explicit Reverse; frozen source; per-row overlap with May import. |
| C-8 | Schema conflicts (HMO claims, gift codes) | `source_tab`/`source_key` migration; redeemed codes need converted visit or are held. |
| C-10 | Rollback can't undo updates | `sheet_sync_changes` before-images + conditional revert. |
| C-11 | Active by default; partial success | Seeded paused; `partial` status + monitor error; final sync requires all tabs succeeded. |
| C-P3 | Guide deferred to the end | Guide sections ship with PR 1 and PR 2. |
| F-P2-3 | ACLs, exports, retention | In-body `has_role` admin check; report-CSV pattern; retention work in the PR creating each table. |
| F-P2-4 | Manila dates | Integer serial math; `at time zone 'Asia/Manila'`. |
| F-P3 | YAGNI | Dropped `enabled_tabs` and DB sheet id; kept ad spend (owner accepted) but in PR 2 scope only. |

## 13. Open questions for the owner

1. Settle review items: admin only (default), or also a reception lead?
2. Is 00:00 Manila a good nightly time (reception may still be editing late)? Alternative 02:00.
