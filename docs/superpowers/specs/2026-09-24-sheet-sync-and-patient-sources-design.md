# Sheet Sync + Patient Sources — design

**Date:** 2026-09-24 · **Branch:** `feat/sheet-sync` · **Status:** draft for review (Fable + Codex astra/high)

## 1. Why

Reception still works in the old Google Sheet **"LAB SERVICES (RECEPTION)"**
(`199CjfHAO9XqVJ1Yty4eheqCTkg1CJn9YtmPeR6muVDM`, edited today). The app's copy
of that data stops in late May 2026: the Customers tab was imported once on
2026-05-25 (4,475 patients) and LAB SERVICE / DOCTOR CONSULTATION were
backfilled 2026-06-03..05 with a hard window ending `2026-05-26`
(`scripts/clinical-backfill/engine.ts:24`). Prod has 14 visits after May.

The owner wants:

1. The app kept current **from the live sheet, automatically**, with a
   **Pause sync** switch for the day the clinic moves to the app exclusively.
2. **Patient-acquisition stats**: how many customers per day came from each
   channel (Facebook / Google / walk-in / …), from the Customers tab's
   "How did you know about DR Med?" answer.

### Owner decisions (2026-09-24, this session)

| Question | Decision |
|---|---|
| Sync mode | Automatic nightly sync **+ Sync now + Pause sync** (in-app, approach A) |
| Count unit | **Both, toggle**: default *New customers* per day; toggle *All customers served* |
| Channel list | **Expanded list** (§4.1); existing patients re-sorted; original text kept |
| Sync scope | Customers + Lab Service + Doctor Consultation + Doctor Procedure HMO + Home service + Gift codes + Flyers + **Books** |
| Approach | A — the app reads the sheet itself (Vercel cron + admin page), not a laptop script or Apps Script |
| Cross-section ideas | all accepted: cost per new patient, channel revenue, top referring doctors, dashboard tile, front-desk "how did you hear" prompt |

## 2. What exists (verified 2026-09-24)

**Sheet (via service account `drmed-sheets-writer@…`, now shared Viewer):** 25 tabs.
Relevant: `CUSTOMER LIST2` (4,869 named rows; col 16 "How did you know about DR Med?",
17 "Referred By", 18 release medium, 19 New/Repeat, 20 Timestamp), `LAB SERVICE`
(21,505 named rows, TEST NO col 2 is a unique running number, date col 0,
last row today), `DOCTOR CONSULTATION` (9,051, to 2026-09-19),
`DOCTOR PROCEDURE HMO` (79), `HOME SERVICE REQUESTS` (43), `GC Codes` (49),
`FLYERS` (mostly undispatched code grid), `CUSTOMER LIST` (1,313, older
predecessor of LIST2; no rows newer than LIST2), `FREE CONSULT` (17).

Customers tab layout traps:
- Rows 2–~3,260 are Google-Form responses ordered by timestamp (to 2026-08-19);
  rows ~3,260–4,880 are a **second, manually typed block** (Jan 2025 → today);
  its most recent ~600 rows have **no timestamp at all** (e.g. a customer
  registered today sits at the bottom, undated, while their LAB SERVICE rows are
  dated 2026-09-24).
- Timestamp formats are mixed: `Dec 1, 2024`, `March 16,2024`,
  `19/11/2024 16:29:11` (**D/M** with time), `9/25/2025` / `10/02/2025` (**M/D** without time).
- ~72 distinct spellings of the source answer; 784 blank.

**App (prod `qhptbmafrosgibooelpp`, head migration 0156):**
- `patients.referral_source` → FK `referral_sources(id)` (12 rows, 0055). Counts:
  NULL 2,769 · walk_in 1,106 · **other 981** · customer_referral 777 ·
  doctor_referral 634 · online_facebook 546 · online_google 186 · online_website 57 · …
  The 2025-05 mapper (`src/lib/legacy-import/vocabulary-mapper.ts`) sent **blank → other**,
  lumped family/friends into customer_referral and dropped phone/Viber/"prefer not to say"/typos into other.
- Original answers survive: `patients.legacy_intake.raw["How did you know about DR Med?"]`
  for the 4,475 Customers-tab imports. The ~1,966 patients created by the clinical
  backfill have no source at all.
- `referral_source` is required on the staff New Patient form, optional on edit, and
  never captured by `/schedule` or `/register`.
- No acquisition analytics exist. `/staff/marketing/sources` (Booking Sources) reads
  `appointments.source` + `contact_messages.attribution` only. The June spec's
  `v_ops_patient_acquisition` (Part B of `2026-06-05-operational-analytics-dashboards-design.md`) was never built.
- Ad spend is **not in the database**: Ad Performance parses uploaded Meta/Google CSVs
  client-side into `localStorage`.
- `src/lib/accounting/sync.ts` appends app visits to a **separate** accounting sheet
  (`ACCOUNTING_SHEET_ID`), watermarking lab on `test_requests.released_at` and
  consults/procedures on `visits.created_at`, with **no filter on
  `legacy_import_run_id`** — sheet-imported rows would be exported again.
- 0091 makes rows with `legacy_import_run_id` GL-silent (payment bridge,
  release bridge, EOD lock early-return).
- Cron conventions: `src/app/api/cron/<name>/route.ts`, `CRON_SECRET` bearer,
  `withCronMonitor`, audit `.completed` with `actor_type='system'` (manual runs
  write `'staff'`), and the **three-place rule** (`vercel.json`,
  `src/lib/ops/cron-heartbeats.ts`, `.github/workflows/cron-watchdog.yml` `watched()`).
- Singleton switch pattern: `booking_settings` (0153) + upsert server action + audit + `src/components/ui/switch.tsx`.

## 3. Architecture

```
Google Sheet ──(Sheets API values.batchGet, readonly scope)──► src/lib/sheet-sync/reader.ts
                                                                   │  rows as {cells, formatted}
                                                                   ▼
                              tabs/<tab>.ts  (parse + validate one tab → typed records + row_key)
                                                                   ▼
                              engine.ts  (diff against sheet_sync_rows ledger → plan → apply)
                                   │                │                     │
                         patients/visits/…   sheet_sync_review_items   sheet_sync_runs
                                                                   ▲
           /api/cron/sheet-sync (nightly) ── Sync now (admin action) ── scripts/sheet-sync.ts (catch-up CLI)
```

- **One library, three callers.** `src/lib/sheet-sync/*` is pure TS that takes an
  injected Supabase service-role client and in-memory rows. The cron route, the admin
  "Sync now" server action and a CLI wrapper (for the one-off catch-up, which can exceed
  a function's time budget) all call `runSheetSync({ tabs, trigger, actorId, dryRun })`.
- **The reader** reads each tab twice in one `values.batchGet`: `UNFORMATTED_VALUE` +
  `dateTimeRenderOption=SERIAL_NUMBER` (true date cells become serials — no D/M vs M/D
  guessing) and `FORMATTED_VALUE` (for text-typed dates and display). It uses the
  existing JWT flow from `src/lib/accounting/google-sheets.ts`, factored into a shared
  `google-auth.ts`, with scope `spreadsheets.readonly` for reads.
- **Idempotency by content, not row number.** Sheet rows move (inserts, sorts), so every
  imported record is keyed by a stable `row_key` (§4.3) stored in the
  `sheet_sync_rows` ledger together with a fingerprint of the row's contents.
- **Reuse, don't fork.** The clinical-backfill classify/match/insert logic moves from
  `scripts/clinical-backfill/` into `src/lib/sheet-sync/clinical/` behind
  `(rows, client, window)` inputs; the old CLIs become thin wrappers over it, so
  history and nightly sync share one implementation. `src/lib/legacy-import/*` is already
  pure and is reused as-is (the referral mapper is replaced, §4.1).

## 4. Data model — migration 0157 (PR 1) and later additions

### 4.1 Channels

`referral_sources` gains `channel_group text not null` (check in
`online, walk_in, referral, direct_contact, partner, returning, other`) and new rows.
Final list (sort order as shown; ids kept stable, labels editable):

| id | label | group | from sheet answers like |
|---|---|---|---|
| online_facebook | Facebook | online | FACEBOOK (ONLINE), FACEBOOK, FB |
| online_google | Google | online | GOOGLE (ONLINE) |
| online_website | Website | online | WEBSITE (ONLINE) |
| online_instagram / online_tiktok | Instagram / TikTok | online | (unused so far) |
| walk_in | Walk-in | walk_in | WALK-IN, WALK IN |
| **walk_in_signage** | Walk-in (saw poster/signage) | walk_in | WALK-IN (SAW POSTER / SIGNAGE) |
| doctor_referral | Doctor referral | referral | DOCTOR REFERRAL, DOCTOR'S REFFERAL, DOCTO'S REFFERAL… |
| customer_referral | Customer referral | referral | CUSTOMER REFERRAL, CUSTOMER'S REFFERAL |
| **family_friends** | Family / friends | referral | FAMILY / FRIENDS, FAMIL/FRIENDS, FRIENDS/FAMILY… |
| **phone_text_viber** | Phone call / text / Viber | direct_contact | PHONE CALL, VIBER, CALL/TEXT, PHONE TEXT |
| **flyers** | Flyers | other | FLYERS |
| **partner_corporate** | Partner / corporate | partner | LIKHAAN, WOMEN'S, GICA… |
| tenant_employee_northridge | Northridge tenant / employee | partner | NORTHRIDGE, TENANT EMPLOYEE NORTHRIDGE |
| returning_patient | Returning patient | returning | RETURNING PX, OLD PATIENT, OLD PX |
| gift_code | Gift code | other | GIFT CODE |
| **prefer_not_to_say** | Prefer not to say | other | PREFER NOT TO SAY |
| other | Other | other | typed answers that match nothing |

"**Not recorded**" is `referral_source IS NULL`, displayed as a label — never a row, so
a missing answer can't be mistaken for a chosen one.

**Mapping** = new `src/lib/sheet-sync/referral-mapper.ts`: normalise (uppercase, strip
punctuation, collapse spaces, common typo folds `REFFERAL→REFERRAL`, `FRIENS→FRIENDS`,
`FIRIENDS→FRIENDS`), then (1) exact lookup in a new **`referral_source_aliases`** table
(`raw_normalized text pk`, `referral_source_id` FK, `created_by`, `created_at`) — admins
teach it new spellings from the review screen; (2) ordered regex rules; (3) blank → NULL;
(4) else `other` + a review item `unmapped_source` carrying the raw text and row count.
The 2025 mapper is kept only for the one-time "was this value untouched?" check below.

**Re-sorting existing patients (one-off, in PR 1, run by the CLI with dry-run first):**
for each patient with `legacy_intake.raw`, compute `old = oldMapper(raw)` and
`new = newMapper(raw)`. Update only if `patients.referral_source` is still `old`
(i.e. no staff edit since import; additionally skip any patient with an
`audit_log` patient-update row touching `referral_source`). Blank raw + `other` → NULL.
Every change writes one batch audit row with counts, and `legacy_intake.referral_resort`
records `{from, to, at}` per patient so it is reversible.

### 4.2 Sync control tables

- **`sheet_sync_settings`** — singleton copied from `booking_settings`: `id boolean pk
  check(id)`, `paused boolean not null default false`, `paused_at`, `paused_by`,
  `pause_reason text`, `spreadsheet_id text not null`, `enabled_tabs text[]`,
  `clinical_window_start date not null default '2026-05-26'`, `updated_at`. RLS on,
  admin read, **no write policy** (service role via server action, audited).
- **`sheet_sync_runs`** — `id`, `trigger` (`cron|manual|cli`), `actor_id`, `dry_run`,
  `started_at`, `ended_at`, `status` (`running|succeeded|failed|skipped_paused`),
  `per_tab jsonb` (rows read / new / updated / unchanged / held / errors),
  `error text`. **Partial unique index on `(true) where status='running'`** so cron and
  Sync now can never overlap; a run older than 15 min in `running` is marked `failed`
  (stale-lock recovery) before a new one starts.
- **`sheet_sync_rows`** (ledger) — `tab`, `row_key`, `fingerprint`, `entity_type`,
  `entity_id`, `first_seen_at`, `last_seen_at`, `last_sheet_row int` (display only),
  `state` (`imported|held|ignored|missing_from_sheet`), unique `(tab,row_key)`.
- **`sheet_sync_review_items`** — `id`, `run_id`, `tab`, `row_key`, `kind`
  (`ambiguous_patient`, `unmapped_source`, `unmapped_service`, `changed_after_settle`,
  `possible_duplicate_app_visit`, `missing_from_sheet`, `unparseable_date`,
  `invalid_row`), `payload jsonb` (the row, candidates), `status`
  (`open|resolved|dismissed`), `resolution jsonb`, `resolved_by`, `resolved_at`.
  Admin-only; payloads contain patient names (RA 10173 — never exposed beyond admin,
  purged 90 days after resolution by the existing data-retention cron).

### 4.3 Row keys and fingerprints

| Tab | row_key | Notes |
|---|---|---|
| CUSTOMER LIST2 | `sha1(normName ‖ normPhone ‖ dob ‖ timestamp)` | no ID column exists; an edited row gets a new key but re-links to the same patient via matching, so no duplicate patient |
| LAB SERVICE | `test:<TEST NO>` | TEST NO is a unique running number (verify uniqueness each run; duplicates → `invalid_row`) |
| DOCTOR CONSULTATION | `sha1(date ‖ normName ‖ doctor ‖ control_no ‖ occurrence#)` | no test number; `occurrence#` disambiguates identical same-day rows |
| DOCTOR PROCEDURE HMO | `sha1(approval_date ‖ normName ‖ service ‖ amount)` | |
| HOME SERVICE REQUESTS | `sha1(date ‖ normName ‖ phone)` | |
| GC Codes | `code:<CODE>` | natural key |

`fingerprint = sha1(canonical JSON of the parsed record)`. Existing Customers-tab
patients are **seeded into the ledger** by recomputing their `row_key` from
`legacy_intake.raw`, so the first sync does not treat 4,475 old rows as new.

### 4.4 Later-PR tables

- PR 2: nothing new (reuses `visits/test_requests/payments` + ledger); adds
  `sheet_sync` provenance by setting `legacy_import_run_id` to a
  `legacy_import_runs` row created per sync run (source `sheet_sync:<tab>`), so every
  existing GL-silence and rollback-by-batch path applies unchanged.
- PR 3: `ad_spend_daily (date, platform check in ('meta','google'), campaign text,
  spend_php numeric(12,2), impressions, clicks, uploaded_by, uploaded_at,
  unique(date,platform,campaign))` — the Ad Performance CSV upload also saves here
  (admin only); localStorage stays as a cache. View `v_patient_acquisition` and
  RPCs in §7.
- PR 4: `home_service_requests` (date, patient_id nullable, patient_name, phone,
  address, home_fee_php, medtech_name, visit_id nullable); `historic_hmo_claims` rows
  with `source_tab='DOCTOR PROCEDURE HMO'`; `gift_codes` rows; `flyer_codes`
  (code, batch, dispatched_on, availed_on).

## 5. PR 1 — foundation + channels + Customers sync

**Sync algorithm (Customers tab):** read → parse each row with a patient name
(skip `,  ` placeholders and `#N/A`) → `row_key` → look up ledger:
1. key known, fingerprint same → touch `last_seen_at`.
2. key known, fingerprint changed → **fill-blanks update** of the linked patient.
3. key unknown → match patient by normalised name (`scripts/clinical-backfill/lib/patient-match.ts`,
   moved into the lib) **plus** phone/DOB as tie-breakers:
   - exactly one candidate → link + fill blanks;
   - several → review item `ambiguous_patient` (never auto-pick);
   - none → create patient (`legacy_intake.source='sheet_sync:CUSTOMER LIST2'`,
     `legacy_intake.raw`, `legacy_import_run_id` = this run's import-run row).

**Fill-blanks rule:** the sync only writes a patient field that is currently NULL/empty
— it never overwrites staff-entered data. `referral_source` is filled when NULL; a
different sheet answer on a patient who already has one is ignored (the app wins).
The ~1,966 backfill-created patients with no source are filled this way.

**Dates:** a timestamp cell that is a true date serial is used directly (Asia/Manila);
text dates are parsed with the format of their block (with time → D/M/Y; without → M/D/Y;
`Mon D, YYYY` → named); anything still ambiguous or invalid → `unparseable_date` item and
the date is left NULL. Stored on the patient as `legacy_intake.sheet_timestamp`.

**Pause semantics:** when `paused`, the cron writes a `sheet_sync_runs` row
`skipped_paused` and still writes its `.completed` heartbeat (metadata `paused:true`) so the
watchdog does not cry wolf; Sync now is disabled with the pause reason shown. Pausing and
resuming are audited (`sheet_sync.paused/resumed`). A **"Final sync, then pause"** button
runs a full sync and sets `paused` in the same action (used at switch-over, PR 6).

**Cron:** `/api/cron/sheet-sync` at `0 16 * * *` UTC (00:00 Manila, after the day is
closed; before sync-accounting at 09:00 UTC), `maxDuration = 300`, `withCronMonitor('sheet-sync')`,
added in all **three** places with `active_from` = merge date + 2 days.

**Admin page** `/staff/admin/sheet-sync` (Admin Tools, next to Import Patients):
status card (last run, next run, paused/active switch), per-tab table (last read,
new/updated/held counts), **Sync now** (dry-run toggle shows the plan without writing),
run history (last 30), and the **review queue** with per-kind resolvers: pick the right
patient / create new, map an unknown answer to a channel (writes an alias and re-applies
to all rows with that text), dismiss. Every resolve is audited.

**Security:** all tables RLS-on with admin read only and no write policies; routes use
the service-role client only after `requireAdminStaff()` / `CRON_SECRET`; functions (if any)
get explicit `GRANT … TO service_role` (functions are born closed); `seed.sql` tail mirrors
any revokes (`seed-grant-parity.test.ts`). The service account key stays in
`GOOGLE_SERVICE_ACCOUNT_JSON`; the sheet id is not a secret.

## 6. PR 2 — Lab Service + Doctor Consultation sync

- Moves the backfill core into `src/lib/sheet-sync/clinical/` with `(rows, client, window)`
  inputs; `WINDOW.cutoverExclusive` becomes `sheet_sync_settings.clinical_window_start`
  (2026-05-26) as the **lower bound**; rows before it are never touched (they belong to
  the June backfill, whose `legacy_source_ref` keys used row numbers and must not be
  re-derived).
- New keys use `legacy_source_ref = 'LAB SERVICE test=<TEST NO>'` /
  `'DOCTOR CONSULTATION key=<row_key>'`, plus the ledger.
- **Settling window (7 days):** rows dated within the last 7 days are re-checked each run;
  a changed fingerprint updates the imported visit/test/payment **only if no staff user has
  touched it in the app** (no audit rows by a staff actor on those ids); otherwise
  `changed_after_settle`. Older changes → `changed_after_settle` review item, never auto-applied.
- A row that disappears from the sheet → `missing_from_sheet` item; nothing is deleted.
- **Duplicate guard for the switch-over period:** if an app-native visit
  (`legacy_import_run_id IS NULL`) exists for the same patient on the same date,
  hold as `possible_duplicate_app_visit`.
- Ambiguous names and unmapped service names go to the review queue instead of the
  June CSV worksheets; resolutions persist (`hmo_service_aliases` for services).
- **Accounting-sheet export fix (must ship in this PR, before the first clinical sync):**
  `fetchLabRows/fetchConsultRows/fetchProcedureRows` in `src/lib/accounting/sync.ts` add
  `.is("visits.legacy_import_run_id", null)` (and `test_requests.legacy_import_run_id`),
  with a test proving a legacy row is excluded and a native row is not.
- Catch-up (26 May → today, ~3–4k lab rows) runs via `scripts/sheet-sync.ts`
  dry-run → commit, then the nightly cron takes over.

## 7. PR 3 — Marketing › Patient Sources

New tab `/staff/marketing/patients` "Patient Sources" (admin only, like the rest of Marketing).

**Definitions (view `v_patient_acquisition`, security_invoker, admin-granted RPCs):**
- `acquired_on` (Manila date) = earliest non-deleted visit date; else the sheet form
  timestamp date; else (app-native only) `created_at` date. Patients with none are
  counted as "undated" in a footnote, never on a day.
- **New customers** on day D = patients with `acquired_on = D`, grouped by `referral_source`.
- **All customers served** on day D = distinct patients with a non-deleted visit on D,
  grouped by their `referral_source`.

**UI:** range presets (Today, Yesterday, Last 7 days, This month, Last month, Custom) and
grain (Day/Week/Month); stacked bar chart per channel (recharts via `next/dynamic`, like
`ad-charts.tsx`), toggle New / All served, a "group channels" switch (Online / Walk-in /
Referral / …); table with count, share, change vs previous period; click a cell →
patient list for that channel+date (links to `/staff/patients?source=…&acquired=…`);
CSV export (`/api/admin/reports/patient-sources.csv`, `maxDuration = 60`).

**Cross-section (all accepted):**
- **Cost per new patient** — `ad_spend_daily` (Meta ↔ Facebook, Google ↔ Google) ÷ new
  patients from that channel per period; shown only for days with uploaded spend.
- **Channel revenue** — sum of `test_requests.final_price_php` for each channel's patients
  in range (new vs all).
- **Top referring doctors** — from `patients.referred_by_doctor` (normalised), new patients per doctor.
- **Admin dashboard tile** "New today: 3 Facebook · 1 Google · 5 walk-in", configurable via Dashboard Cards.
- **Front-desk prompt:** the reception visit flow shows "How did you hear about us?" when a
  patient's `referral_source` is NULL (one click, optional), so the stats keep working
  after switch-over; `/register` self-registration gains the same optional question.

## 8. PR 4 — small tabs

Doctor Procedure HMO → `historic_hmo_claims` (`source_tab`, `source_row` = row_key),
Home service → `home_service_requests` (linked to a patient/visit when matched),
GC Codes → `gift_codes` (status from purchased/redeemed columns, `batch_label='sheet'`),
Flyers → `flyer_codes`; Patient Sources gains "Flyers" and "Gift code" redemption counts.

## 9. PR 5 — Books

Reuses `scripts/history-import/{lab-services,doctor-consultations}.ts` logic, moved into
the lib. Posting is **not automatic**: each synced day appears on the Sheet Sync page as
"Ready to post to books" with the totals the entries would create; an admin clicks
**Post day** (or a range), which writes the journal entries with the existing idempotency
note (`sheet <TAB> <row_key>`), and refuses days already closed by EOD or overlapping
app-native sales. Backlog 2026-05-26 → today is posted in reviewed batches.

## 10. PR 6 — switch-over

"Final sync, then pause" flow, user-guide chapter (Sheet Sync + Patient Sources),
a duplicate-count check (sheet-imported vs app-native visits per day for the last 30 days),
and removing the June CLI worksheets superseded by the review queue.

## 11. Errors, testing, rollout

- **Failure isolation:** each tab runs in its own try/catch; one bad tab fails its
  `per_tab` entry, not the run. Per-row errors become `invalid_row` items. A Sheets API
  error (403/404/quota) fails the run with a clear message on the admin page and in Sentry.
- **Tests (vitest):** reader date handling (serial, D/M with time, M/D without, named,
  junk); referral mapper against every distinct value in today's sheet (fixture) —
  asserts no known spelling lands in `other`; row-key stability; engine plan against
  fixtures (new / changed / unchanged / ambiguous / placeholder rows); fill-blanks never
  overwrites; pause → `skipped_paused` + heartbeat; overlap lock; accounting export
  excludes legacy rows (mutation-checked); cron three-place drift tests updated.
- **Local proof:** run the CLI dry-run against the real sheet into the local stack and compare
  counts to the sheet by hand for 3 sample days.
- **Rollout per PR:** migration via `supabase db push` from the worktree right before merge,
  verified by object; first prod run is a dry-run from the admin page, then commit.

## 12. Open questions for the owner

1. Should sheet-imported visits ever go to the accountant's sheet? Design says **no**
   (they came from the sheet already). Confirm.
2. Settling window of 7 days — right for how late reception corrects rows?
3. Who resolves the review queue — admin only, or also reception lead?
