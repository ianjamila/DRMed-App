# Patient Sources (Sheet Sync PR 2) — design

**Date:** 2026-09-28 · **Branch:** `feat/patient-sources` (worktree `.worktrees/patient-sources`, off `origin/main` 23117c28)
**Status:** approved direction (user, 2026-09-28) — awaiting review of this written spec.
**Parent spec:** `2026-09-24-sheet-sync-and-patient-sources-design.md` (v3) §6. This document is binding for PR 2 and
**supersedes §6 wherever the two differ**; everything in §6 not mentioned here stands.

## 0. Decisions already made

| # | Decision | Source |
|---|---|---|
| S1 | ONE PR carries all of §6: the report, channel revenue + reconciliation, top referring doctors, admin dashboard tile, reception prompt, ad spend + cost per new patient, guide. | User, 2026-09-28 |
| S2 | **A′** — Patient Sources is its own Marketing tab. Booking Sources keeps a "New patients" card computed by the SAME summary as Patient Sources, shown split (confirmed · unconfirmed), with a link carrying the period; its duplicate "by how they heard" table is removed. | User, after Codex astra/high plan review |
| S3 | Interim fix shipped separately as **PR #244**: Booking Sources' created_at count excludes `legacy_import_run_id is not null` and is labelled "New app registrations". PR 2 replaces that card (S2) and removes the table. | User |
| S4 | `/register` and `/schedule` already REQUIRE "How did you hear about us?" (#206, 0158). §6's "`/register` gains the same optional question" is **dropped**; only the reception prompt is new. | Codex P2 #6, verified |

## 1. Counting definitions (the SQL layer)

All counting lives in SQL (PostgREST caps selects at 1,000 rows and cannot aggregate). One migration (number claimed
with `npm run claim -- migration` at plan time).

### 1.1 Canonical identity (Codex P1 #1)

Merging patients moves `visits`, `appointments`, `audit_log`, `critical_alerts`, `patient_consents` and
`appointment_attachments` (`scripts/patient-dedup/engine.ts` FK_TABLES, the admin merge action) but NOT
`sheet_encounter_lines.patient_id`, `sheet_customer_rows.patient_id` or `patient_acquisition_facts` — those are
rebuilt only by the next sync run, and facts are never moved.

- Every `patient_id` read by the report is resolved to its **survivor** by following `patients.merged_into_id`
  (bounded, like `buildPatientIndex().survivor`, 10 hops) before any grouping. Identity = `patient:<survivor id>`.
- A survivor that is **deleted** (`deleted_at is not null`) drops out of every count, series, revenue and list —
  the app's active-record rule. Its mirror lines are NOT re-labelled as name identities.
- **Acquisition facts for a merged group:** `registered_on` = the earliest non-null value across the group;
  `sheet_new_repeat` = the value on the fact that supplied that earliest date (a tie → `'repeat'` wins, the
  conservative answer). Computed in SQL; nothing is written.
- `name:<loose_key>` identities (unlinked sheet lines) stay as they are: unconfirmed.

### 1.2 Encounters (mirror mode only)

- (a) live app visits: `visits.deleted_at is null`, patient resolved per 1.1, and (`visit_date < mirror_window_start`
  **or** `legacy_import_run_id is null`); (b) `sheet_encounter_lines` (all tabs present).
- **Converted mode is not built in PR 2.** `sheet_deferred_rows` does not exist yet. When
  `sheet_sync_settings.converted_at is not null` the functions raise `feature_not_supported` with a message PR 4
  must replace (PR 4 owns the before/after/purge equivalence proof, §8 of the parent spec).
- Encounters before **2023-12-01** are ignored everywhere.

### 1.3 New customers

- **First encounter** per identity is computed over the WHOLE history (2023-12-01 → today) first, and only then
  filtered to the requested period (Codex P2 #4). A person's first-visit day never depends on the period asked.
- A confirmed identity whose facts say `sheet_new_repeat = 'repeat'` counts as **Returning, first time in our
  records** — its own figure, never in New.
- **Registration without an encounter** counts on its registration day:
  - sheet-created or sheet-linked patients → `patient_acquisition_facts.registered_on` (group rule 1.1);
  - app-native patients (`legacy_import_run_id is null`) with no facts row → `(created_at at time zone
    'Asia/Manila')::date`;
  - an imported patient (`legacy_import_run_id is not null`) with no `registered_on` → **undated**, never
    `created_at` (that would recreate the import-night spike).
  - A name identity with the same loose key that already has an encounter suppresses the registration (§6).
- **Restatement is intended and explained on screen:** someone who registers in September and first visits in
  October counts in September (registration); once the October visit exists, their first encounter is October,
  so September's figure drops by one. The page says: "Counts can move when an earlier registration later gets its
  first recorded visit."

### 1.4 All customers served

Distinct identities with an encounter on the day (bucket), confirmed and unconfirmed separately; a patient with both an
app visit and mirror lines on the same day counts once.

### 1.5 Channel

Confirmed → the survivor's `referral_source` (NULL → "Not recorded"). Name identity → the mapped
`sheet_customer_rows.referral_source_id` only when exactly one Customers row has that loose key; otherwise
"Not recorded".

### 1.6 Revenue (channel revenue)

As §6: `test_requests.final_price_php` for (a) (live rows: `test_requests.deleted_at is null` and
`visits.deleted_at is null`; consult lines are the clinic fee), `revenue_php` for (b). Mirror lines for a
(survivor, date) that also has an app visit are excluded from revenue and listed in the reconciliation panel.
Labelled "billed (clinic share)", never "collected".

### 1.7 Functions (all `security definer`, `set search_path = ''`, first statement
`if not has_role(array['admin']) then raise exception using errcode = '42501'`, `grant execute to authenticated`,
revoked from `public, anon`)

| Function | Returns |
|---|---|
| `patient_sources_summary(p_from date, p_to date)` | one row: `new_confirmed, new_unconfirmed, returning_first_recorded, served_confirmed, served_unconfirmed, undated_registrations, source_recorded, source_total, sheet_last_dates jsonb (per tab)` |
| `patient_sources_series(p_from, p_to, p_grain text /*day|week|month*/, p_mode text /*new|served*/)` | `(bucket_start date, channel text, confirmed int, unconfirmed int)` — only non-empty cells |
| `patient_sources_revenue(p_from, p_to)` | `(channel, confirmed_php, unconfirmed_php)` + a second function `patient_sources_overlaps(p_from, p_to)` → `(patient_id, service_date, app_php, sheet_php)` for the reconciliation panel |
| `patient_sources_referrers(p_from, p_to, p_limit int default 20)` | `(doctor_label, new_confirmed, new_unconfirmed)` — normalised `referred_by` (sheet `referred_by_raw` ∪ `patients.referred_by_doctor`): lower-case, strip `dr.`/`dra.`/`doc`, punctuation, collapse spaces; the most common raw spelling is the label |
| `patient_sources_people(p_from, p_to, p_mode, p_channel text, p_limit int, p_offset int)` | the drill-through list: `(identity kind, patient_id, drm_id, display_name, first_date)`, total order `(first_date, identity)` |

Week buckets start Monday (ISO); month buckets are calendar months; all bucket math is on `date` values, no
`timestamptz`. The summary is the ONE definition every surface reads (Patient Sources, Booking Sources card,
dashboard tile, CSV header).

## 2. Ad spend and cost per new patient (Codex P1 #2)

### 2.1 Table

`ad_spend_daily (id bigint identity, spend_date date, platform text check in ('meta','google'), campaign_key text,
ad_key text, campaign_label text, spend_php numeric(12,2) check >= 0, impressions int, clicks int,
uploaded_by uuid, uploaded_at timestamptz, upload_id uuid, unique (spend_date, platform, campaign_key, ad_key))`.
RLS on; SELECT for admin; no write policies (writes only through the RPC). No patient data.

Stored per **ad**, not per campaign, so a later upload that contains only some of a campaign's ads replaces only those
ads' rows and cannot overwrite the campaign total. `campaign_key` = the campaign name normalised the same way
Ad Performance already matches campaigns to bookings; `ad_key` = the ad's id column when the export has one, else its
normalised ad name, else `'(campaign)'`.

### 2.2 Import contract

A pure TS parser (`src/lib/marketing/ad-spend-import.ts`, unit-tested) turns an uploaded Meta/Google CSV into rows and
**rejections**, then one RPC `ad_spend_import(p_upload_id uuid, p_rows jsonb)` upserts them in one transaction.

- **Daily rows only.** A row whose date cell is a range with different start and end (Meta "Reporting starts /
  Reporting ends", "2026-09-01 - 2026-09-30") is rejected, not collapsed to its first date. The upload screen says how
  many rows were rejected and why ("export with a 1-day breakdown").
- Platform must be recognised (Meta or Google headers); unknown → the whole file is refused.
- Currency: a currency column that is present and not PHP rejects the file. No column → PHP assumed and stated.
- Dates are calendar dates as exported (the ad accounts are set to Asia/Manila); no timezone conversion.
- Duplicate (date, platform, campaign, ad) rows inside one file are summed before the upsert.
- The RPC checks `has_role(array['admin'])`, writes an `audit_log` row `ad_spend.imported` (counts only), and
  returns inserted / replaced counts shown in the UI.
- **Correction:** an admin can remove uploaded spend for a platform and date range (RPC
  `ad_spend_delete(p_platform, p_from, p_to)`, audited `ad_spend.deleted`, confirm dialog).

### 2.3 Where it shows

- Ad Performance keeps its current in-browser view unchanged; its upload additionally calls `ad_spend_import`
  and shows "Saved to clinic records: N days, M rows rejected".
- Patient Sources shows **Cost per new patient** per platform (Meta ↔ Facebook channel, Google ↔ Google channel)
  = spend ÷ new customers (confirmed + unconfirmed, labelled as such) on days that have spend only; days without
  spend are excluded and the card says so.

## 3. Pages and components

### 3.1 Shared period controls (Codex P2 #5)

`marketing/_components/period-controls.tsx` (moved up from `sources/_components/period-chips.tsx`) with presets
**Today, Yesterday, Last 7 days, This month, Last month, Custom** (two date inputs, validated `isISODate`,
`from <= to`, max span 400 days). Links and the custom form carry every other query param on the page (`mode`,
`grain`), so changing the period never resets them. Preset maths via `buildPeriodPresets` + `shiftISODate` —
extended, tested at Manila month/year boundaries. Booking Sources uses the same component.

### 3.2 `/staff/marketing/patients` — "Patient Sources" (admin)

Order on the page:
1. Header + period controls + toggles **New customers / All customers served** and **Day / Week / Month**.
2. Banner when the sync is paused or has never committed: "Sheet data is not included yet — the sheet sync is paused.
   Showing app records only." (reads `sheet_sync_settings.paused` + last succeeded run).
3. Stat cards from `patient_sources_summary`: New (N confirmed · M unconfirmed), Returning first time in our
   records, All served, Source recorded (x of y), and a footnote line: "U registrations have no date and are not on
   any day" (the 962 undated Customers rows land here) + "Sheet last updated" per tab.
4. Stacked bar chart per channel (recharts via `next/dynamic`, like `ad-charts.tsx`); unconfirmed drawn as a hatched
   band per channel; legend explains "unconfirmed = a name in the sheet not yet matched to a patient record".
5. Table per channel: confirmed, unconfirmed, share, change vs the previous period of equal length. Each channel links
   to the people list.
6. Cost per new patient (section 2.3).
7. Channel revenue table + "Possible double entry" reconciliation panel (DRM-ID, date, app amount, sheet amount;
   collapsed when empty).
8. Top referring doctors (top 20).
9. Restatement note (1.3) and definitions ("first visit recorded since Dec 2023").

Empty states for every section. No bare `.limit()`; the people list pages with `p_limit/p_offset` and shows the total.

### 3.3 People list `/staff/marketing/patients/people`

Admin only. Lists the identities behind a channel/period/mode: confirmed rows link to the patient page; name
identities show the name as typed. Each view writes `audit_log` `patient_sources.viewed` (period, mode, channel,
count — no names). Paged.

### 3.4 CSV

Route handler `/staff/marketing/patients/export` (report-CSV pattern): `requireAdminStaff()`, RLS-scoped server client
calling the RPCs, row ceiling `REPORT_EXPORT_MAX_ROWS`, `audit_log` `patient_sources.exported`, `src/lib/csv/escape.ts`.
Two exports: the channel × bucket series (counts only) and the people list (names; its own audit action).

### 3.5 Booking Sources (A′)

The "New app registrations" card from #244 is replaced by **New patients — N confirmed · M unconfirmed** from
`patient_sources_summary`, hint "first visit recorded, same count as Patient Sources", link "See by channel →"
carrying `from`/`to`. The "by how they heard about us" table is removed (its completeness figure is the "Source
recorded" card on Patient Sources). The page subtitle no longer calls the four cards a funnel. Its patients read goes
away (update the patients query-surfaces inventory).

### 3.6 Admin dashboard tile

A new `DASHBOARD_CARDS` entry `admin.new_patients_today` (admin dashboard, on by default): "New today: 3 Facebook ·
1 Google · 5 Walk-in" from `patient_sources_series(today, today, 'day', 'new')`, top 4 channels + "N more", confirmed
and unconfirmed summed with a "(M unconfirmed)" suffix when M > 0; links to Patient Sources for today.

### 3.7 Reception prompt

On `/staff/visits/new` (`visit-form.tsx` + `actions.ts`), once a patient is picked and their `referral_source` is
NULL: an optional "How did you hear about us?" select (the staff option list from `referral-sources.ts`). Saved with the
visit action as a patient update WITHOUT `app.referral_origin`, so the 0170 ownership trigger records origin
`'staff'`. Never shown when the source is already set; never required; skipping it changes nothing. Guard tests
(`write-guards.test.ts`) must still pass — the patient update goes through the existing active-patient guard.

### 3.8 Wiring

`ROUTE_NAME` (`/staff/marketing/patients` "Patient Sources", people list), `marketing-tabs.tsx` (Ad Performance ·
Ops Tracker · Booking Sources · Patient Sources), `mirror-readers.test.ts` allowlist for the new migration and the
Patient Sources files only (money surfaces stay forbidden), user guide section + glossary ("Confirmed / unconfirmed",
"Returning, first time in our records"), `drmed-staff-ui` skill if a shared component moves.

## 4. Error handling

- RPC 42501 → the page shows the standard admin-only message (the page gate already blocks non-admins).
- `feature_not_supported` (converted mode) → a plain banner "Patient Sources is being switched to the converted
  records — ask the developer" (only reachable after PR 4 starts).
- Ad import: whole-file refusals and per-row rejections are shown with counts and reasons; the RPC is all-or-nothing.
- Every new P-code (if any) is claimed and translated in `pg-errors.ts`; standard SQLSTATEs preferred.

## 5. Testing

- **Pure TS (vitest):** ad-spend parser (ranges rejected, platforms, currency, summing duplicates, ad keys),
  referrer normaliser, preset builder incl. Today/Yesterday/Last 7/Custom at Manila month/year boundaries and param
  preservation, dashboard tile formatter, channel labels.
- **SQL proof script** (hand-run, local only, like `scripts/sheet-sync-db-proof.ts`): merged A→B with sheet lines on A
  and an app visit on B the same day (counts once, revenue overlap detected); deleted survivor drops out; repeat →
  Returning; undated imported registration → footnote, never on created_at; app-native registration without visit
  → created_at Manila date; registration later restated by a first visit; >1,000 input rows and >1,000 returned
  series rows; both deletion filters; access matrix — anon, patient JWT, reception, inactive staff, admin, admin
  "View as" reception → only admin passes. Run on Postgres **17.6.1.167** locally (`.106/.111` segfault on
  EXECUTE-denied calls — see memory), with every control proven to bite (mutate and re-run).
- **Equality:** Booking Sources card, Patient Sources cards, dashboard tile and CSV header show the same numbers for
  the same period (a test over the summary function's single call site per surface).
- Repo gates: `npm test && npm run typecheck && npm run lint`, guard tests (query-surfaces, manila-usage,
  date-render-surfaces, mirror-readers, pg-error-coverage, route names).

## 6. Deployment

Additive migration only (new functions, one new table) → push to prod before merge, verify by object. App rollback
never needs the table dropped. With the sync paused, prod shows app records only (banner, 3.2); the full picture
appears after the owner unpauses.

## 7. Out of scope / follow-ups (for the user to prune)

- Ad Performance reading spend back from the database (shared across admins, survives a browser change) instead of
  localStorage.
- PR 3 small tabs (gift codes, flyers, home service, procedure HMO) — feeds this page later.
- A weekly "new patients by channel" email to the owner, reusing `patient_sources_summary`.
- A per-channel trend line on the admin dashboard.

## 8. Planning refinements (2026-09-28)

Binding decisions made while planning (Task 0 of the implementation plan), each already reflected in the
sections above; listed here for a single audit trail against `00-context.md`.

- **P1** — Migration **0189** (`0189_patient_sources.sql`), claimed 2026-09-28. No new P-codes: standard
  SQLSTATEs only (`42501` not admin, `22023` bad period/grain/mode/ad rows, `feature_not_supported` = `0A000`
  converted mode).
- **P2** — Survivor resolution is a SQL helper `_ps_survivors()`, a recursive walk of `patients.merged_into_id`
  capped at 10 hops (mirrors `buildPatientIndex().survivor`); a chain past 10 hops or a cycle drops the row
  rather than mis-attributing it.
- **P3** — The loose key of a confirmed patient is computed in SQL by `_ps_loose_key(last, first)`, the twin of
  `looseKeyOf`/`normalizeName`; parity proven against the TS function in the DB proof's case table.
- **P4** — Returning is read from `patient_acquisition_facts` only: the `sheet_new_repeat` of the group's
  earliest-dated fact (tie → `repeat`); when no fact has a date, any `repeat` wins. Name identities are never
  Returning.
- **P5** — Undated = a confirmed or name identity with no encounter since 2023-12-01, no registration date, and
  (for confirmed) no live visit before 2023-12-01; a patient who only visited before Dec 2023 counts nowhere
  (`basis = 'before_window'`), not as undated. User-approved exception to §1.2 (2026-09-28, Codex review #9).
  **Owner decision 2026-09-28:** a live visit before 2023-12-01 also outranks a registration date — such a
  customer is never New, even when they also have a later registration date (sheet `registered_on` or app
  `created_at`). The `confirmed` CTE's CASE order is encounter → suppressed → before_window → registration →
  undated (before_window ahead of registration); an encounter since December 2023 still wins over everything.
- **P6** — Unlinked Customers rows (`patient_id is null`) are unconfirmed name identities `name:<loose_key>`;
  with no encounter they count on `min(registered_on)` across the rows sharing that key, undated when none has
  a date.
- **P7** — `patient_sources_series` also accepts `p_grain = 'period'` (one bucket = the whole period), used by
  the per-channel table, the previous-period comparison and the CSV.
- **P8** — `patient_sources_summary` returns four more columns than §3.2's list — `sync_paused`,
  `last_synced_at`, `sheet_rows_present`, `last_run_status` — for the sheet banner (P19), in one call.
- **P9** — `patient_sources_overlaps` also returns `drm_id`; `patient_sources_people` also returns `identity`
  and `total_count`, and accepts `p_mode = 'returning'`.
- **P10** — Two admin-gated functions the spec implies but does not name: `ad_spend_daily_totals(from, to)` and
  `ad_spend_coverage()` — PostgREST cannot aggregate.
- **P11** — The referrer normaliser lives in SQL (`_ps_doctor_norm`), not TS, because the grouping happens
  there; it also drops placeholder answers (`none`, `n a`, `na`, `no`, `nil`, `self`).
- **P12** — CSV routes follow the report-CSV pattern: `/api/admin/reports/patient-sources.csv` (counts) and
  `/api/admin/reports/patient-sources-people.csv` (names), via `reportCsvResponse`, audit actions
  `report.patient_sources.exported` / `report.patient_sources_people.exported`.
- **P13** — Period presets on both Marketing report pages: Today, Yesterday, Last 7 days, This month, Last
  month (spec) + Year-to-date, Last 12 months, Last year (kept from Booking Sources) + Custom. "This year" is
  dropped (identical to Year-to-date for these reports). Max span 400 days still holds for every preset.
- **P14** — The Ad Performance upload is re-parsed on the server from the raw CSV text (≤ 5 MB); browser-computed
  rows are never trusted. Google's title lines and a UTF-8 BOM are skipped; "Total:" rows are ignored, not
  rejected. Ambiguous numeric dates follow the in-browser view. No spend column → whole file refused; a blank
  spend cell → that row rejected; an explicit 0 is kept (a correction upload can zero a day). Any row whose
  platform isn't Meta or Google refuses the whole file. **Fixed 2026-09-28 (final review, Codex #1/#2/#3, Sonnet
  #3):** a date cell's trailing text must be a real timestamp suffix (`[ T]HH:MM[:SS][.ffff][Z|±HH:MM]`) or the
  whole cell is rejected — an "A to B" / "A - B" range in one cell is `date_range`, never silently truncated to
  its first day. A row PapaParse itself flags as malformed (`TooManyFields`/`TooFewFields`/a quote error — e.g.
  an unquoted comma inside "1,234.50") is rejected as `malformed_row` and never reaches the money/campaign
  parsing. A campaign name that normalises to empty (e.g. "---") is rejected as `no_campaign`, not passed through
  to fail the DB's `campaign_key` check and abort the whole upload. **Fixed 2026-09-28 (recheck, Codex #1/#2/#3):**
  a Quotes-type PapaParse error (`MissingQuotes`/`InvalidQuotes` — an unterminated or malformed quote) refuses
  the WHOLE file rather than being mapped to `malformed_row`, because PapaParse's own `row` index for that error
  type does not reliably point at the record it names (it can merge several source lines into one field,
  collapsing rows and shifting every later index) — only a `FieldMismatch` error (`TooManyFields`/`TooFewFields`,
  e.g. an unquoted comma inside "1,234.50") is still mapped per-row to `malformed_row`. The whole
  locateHeader → Papa.parse → error-classification pipeline lives in ONE pure function, `parseAdSpendText`, so
  the server action never re-derives it. **`ad_spend_import`'s replace rule is now PARTIAL-preserving, not
  whole-group:** each `ad_key` has a KIND — `(campaign)` = campaign total, `id:…` = per ad ID, anything else =
  per ad name. A later upload for a `(spend_date, platform, campaign_key)` group that keeps the SAME kind only
  touches the `ad_key`s it mentions — a partial correction for one ad leaves its sibling ads saved (spec §2.1
  lines 108–111). Only a KIND CHANGE (e.g. a campaign total superseding per-ad rows) replaces everything saved
  for that group, and only when the whole file had zero rejected rows (`p_rejected_count`, a new RPC parameter
  the parser's rejection count feeds) — a kind change from a file that also had rejections is refused outright
  (`22023`, all-or-nothing) rather than risk replacing a full breakdown with an incomplete one. The parser
  refuses a file that mixes more than one KIND (campaign total, per ad name, per ad ID) for the same campaign
  and day. `ad_spend_import` and `ad_spend_delete` both take `pg_advisory_xact_lock(hashtext('ad_spend_import'))`
  right after their admin check, so an import can never race another import or a removal and stack two different
  representations for an empty/stale group.
- **P15** — Reception prompt: the patient update uses the RLS server client, is conditional on
  `referral_source is null`, never blocks the visit, and is audited `patient.referral_source_recorded`
  (`{ referral_source, via: 'new_visit' }`). Sits inside `createVisitAction`.
- **P16** — Cost per new patient maps Meta → `online_facebook` and Google → `online_google` only; Instagram/
  TikTok are not attributed to Meta spend.
- **P17** — `has_role` follows View-as (0182): an admin viewing as reception is refused by every report
  function — that is the access matrix, not a bug.
- **P18** — Registration date of a confirmed (merged) group = the earliest `registered_on` among the group's
  facts rows when any has a date; otherwise the earliest Manila `created_at` date among the group's app-native
  members; otherwise undated. User-approved 2026-09-28 (Codex plan review #1).
- **P19** — The sheet banner has three states read from the summary (`sheet_rows_present`, `sync_paused`,
  `last_run_status`): nothing loaded yet → "Sheet data is not included yet …"; loaded but paused → "The sheet
  sync is paused …"; last run partial/failed → "The last sheet sync did not finish every tab …". Pausing never
  hides data already in the mirror (Codex plan review #10; supersedes §3.2.2's single sentence).
- **P20** — Every disclosure is audited: the Patient Sources page writes `patient_sources.overlaps_viewed`
  (payload `{ from, to, count, truncated }`, no names or amounts) whenever the double-entry panel carries rows;
  the people list writes `patient_sources.viewed`; the CSVs write `report.*.exported`.
- **P21** — `resolvePeriod` rejects impossible calendar dates (e.g. `2026-02-30`), not just malformed strings, so
  a crafted URL never reaches SQL (Codex plan review P3).
