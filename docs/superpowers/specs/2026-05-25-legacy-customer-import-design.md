# Legacy Customer Import + Attribution Capture

**Date:** 2026-05-25
**Status:** Draft — awaiting partner review
**Driver:** Staff-side beta begins 2026-05-26 (tomorrow). Need ~4,480 historical customers from the operations Google Sheet imported into `patients` so reception flows feel real, and need to start capturing referral / senior-PWD / result-preference data that the current schema discards.

## Goals

1. **Wipe** all operational test data (the app has not been used in anger; everything currently in `patients`, `visits`, `payments`, GL bridge, audit_log, etc. is dev noise) without touching reference/config tables.
2. **Migrate** the live customer list (`CUSTOMER LIST - CUSTOMER LIST2.csv`, 4,480 rows) into `patients`, lossless.
3. **Extend** the schema so attribution and entitlement data captured at intake (senior/PWD, referring physician, referral source, result-release preference) stops being thrown away.
4. **Ship** enough in-app affordance tomorrow that reception can use the imported records during beta: badges on patient cards, intake form fields, receipt discount line.
5. **Defer** anything that needs external integrations (email/SMS delivery) or larger accounting work (GL discount account, BIR senior-PWD ledger) to follow-up — capture the data now, fulfil later.

## Non-Goals

- Patient-portal login for legacy patients (beta is staff-side only). The DRM-ID + receipt-PIN flow remains untouched; legacy patients have no visits and no PINs and can't log in until reception creates a visit for them.
- The Google OAuth migration discussed earlier. Separate project, separate session.
- Backfilling stub visits to give legacy patients a portal-login path.
- Promoting referring-physician strings into the `physicians` table (follow-up).
- BIR-compliant senior/PWD discount ledger view (follow-up; data captured now so the ledger is buildable later).

## Source data shape

Sheet has 22 columns, ~4,480 rows. Key observations:

- **Last Name / First Name / M.I.** dedicated columns are **empty for almost every row**. The real name lives in `Full Name` formatted as `"Last, First"` or occasionally `"Last, First Middle"`.
- **Date of Birth** is empty for ~50%+ of rows.
- **Age** column is broken (almost every row says "126"). Ignored entirely.
- **Contact Number** present for most rows, formats vary (`09xxxxxxxxx`, `639xxxxxxxxx`, with/without spaces and dashes).
- **Email** present for very few rows.
- **Address** split across 3 columns (street, barangay, city); often empty.
- **Doctor** column holds the referring physician as free text (e.g. `"DR. KATHERINE GAYO"`).
- **How did you know about DR Med?** has values like `"Doctor Referral"`, `"Walk-in"`, etc. — inconsistent free text.
- **Senior / PWD ID** and **Senior / PWD ID Number** rarely filled.
- **Preferred Medium of Result Release**, **New / Repeat**, **Timestamp** present.
- Trailing junk rows (`, , , ,...`) at the end — must be filtered.

## Decisions made during brainstorm

| # | Decision | Choice |
|---|---|---|
| 1 | Pre-import cleanup scope | Wipe **all operational data** (nothing is real yet). Preserve reference/config tables and migrations. |
| 2 | DOB strategy | Make `birthdate` nullable; add `birthdate_confirmed boolean default false`. Lab pipeline skips age-banded ranges when unconfirmed. |
| 3 | Beta scope | Staff-side only — reception/medtech/admin walk through real workflows with the legacy list as search target. |
| 4 | New columns on `patients` | All five: `senior_pwd_type`, `senior_pwd_id`, `referring_physician`, `referral_source`, `result_release_pref`, plus `legacy_intake jsonb` for lossless raw capture. |

---

## Architecture

Three independent build streams that compose into the tomorrow-morning artefact:

```
┌─────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ 1. Schema migration │ →  │ 2. Operational wipe  │ →  │ 3. Legacy importer   │
│    (0051)           │    │    (script, dry-run  │    │    (script, dry-run  │
│                     │    │    by default)       │    │    by default, with  │
│                     │    │                      │    │    pre-flight report)│
└─────────────────────┘    └──────────────────────┘    └──────────────────────┘
                                                                   │
                                                                   ▼
                              ┌──────────────────────────────────────────────────┐
                              │ 4. UI surface area (intake form, patient card,   │
                              │    receipt) — enables reception to use the new   │
                              │    fields during beta                            │
                              └──────────────────────────────────────────────────┘
```

Each stream is testable in isolation. The wipe and importer are gated behind `--commit --confirm` flags; default mode is read-only.

---

## Component 1 — Schema migration `0051_legacy_intake_and_attribution.sql`

### Changes to `public.patients`

```sql
-- Make birthdate optional; legacy rows often lack it.
alter table public.patients
  alter column birthdate drop not null;

alter table public.patients
  add column birthdate_confirmed boolean not null default false,

  -- Senior Citizens Act (RA 9994) + PWD Magna Carta (RA 10754):
  -- 20% mandatory discount + VAT exemption. Type + ID number must
  -- both appear on the receipt for the discount to be compliant.
  add column senior_pwd_type text
    check (senior_pwd_type in ('senior', 'pwd')),
  add column senior_pwd_id text,
  add constraint senior_pwd_id_required_with_type
    check ((senior_pwd_type is null) = (senior_pwd_id is null)),

  -- Free-text referring physician. Future: promote frequent strings
  -- into the physicians table and back-fill referring_physician_id.
  add column referring_physician text,

  -- Controlled vocabulary; legacy values mapped on import, unmapped
  -- go to 'other' with raw string preserved in legacy_intake.
  add column referral_source text
    check (referral_source in (
      'doctor_referral', 'walk_in', 'facebook', 'instagram',
      'tiktok', 'google_search', 'word_of_mouth',
      'returning_patient', 'gift_code', 'other'
    )),

  -- Captured now; portal/email/sms delivery hooks are follow-ups.
  add column result_release_pref text not null default 'portal_only'
    check (result_release_pref in (
      'portal_only', 'portal_and_email', 'print_pickup', 'sms_link'
    )),

  -- Lossless capture of original sheet row + parse warnings.
  add column legacy_intake jsonb,

  -- Provenance for rollback-by-batch.
  add column legacy_import_run_id uuid;

-- Visits gain a discount column for senior/PWD (and future promos).
alter table public.visits
  add column discount_php   numeric(10,2) not null default 0
    check (discount_php >= 0),
  add column discount_reason text,
  add constraint visits_discount_le_total
    check (discount_php <= total_php);
```

`total_php` remains the **gross** total (sum of test_requests × prices). `discount_php` is separate so the receipt can show both lines and accounting can later route the discount to a contra-revenue account. Net amount owed = `total_php - discount_php`.

### Payment-status trigger update

`public.recalc_visit_payment()` (defined in `supabase/migrations/0001_init.sql:348`) currently compares `paid_php` against `total_php`. Migration 0051 replaces the function body so it compares against `total_php - discount_php` instead, while preserving the `waived` short-circuit and all other behaviour. The trigger binding is unchanged.

```sql
-- inside 0051
create or replace function public.recalc_visit_payment()
returns trigger language plpgsql as $$
declare
  v_net  numeric(10,2);
  v_paid numeric(10,2);
  v_status text;
begin
  select total_php - discount_php into v_net
  from public.visits where id = new.visit_id for update;

  select coalesce(sum(amount_php), 0) into v_paid
  from public.payments where visit_id = new.visit_id;
  -- ...remainder identical to 0001 version, but using v_net in place of v_total
end;
$$;
```

### New table `public.legacy_import_runs`

```sql
create table public.legacy_import_runs (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  rows_in         int,
  rows_inserted   int,
  rows_skipped    int,
  rows_flagged    int,
  dry_run         boolean not null,
  run_by          uuid references auth.users(id),
  notes           text
);

alter table public.patients
  add constraint patients_legacy_import_run_fk
  foreign key (legacy_import_run_id) references public.legacy_import_runs(id);

-- Rollback ergonomic: DELETE FROM patients WHERE legacy_import_run_id = $1.
create index idx_patients_legacy_import_run
  on public.patients(legacy_import_run_id)
  where legacy_import_run_id is not null;

-- Reception name-search needs to be fuzzy because half the imported
-- rows have no DOB / no email, so name will be the main lookup tool.
create extension if not exists pg_trgm;
create index idx_patients_name_trgm
  on public.patients using gin (
    (lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(middle_name,''))) gin_trgm_ops
  );
```

### Lab pipeline — no code change required

Verified during spec self-review: the age-banding logic in `src/lib/results/types.ts:190-243` already returns `null` for `ageMonths` when `birthdateIso` is null, and the range-match expression already falls back to unbanded ranges in that case (`r.age_min_months == null && r.age_max_months == null`). Null DOB is handled gracefully without modification.

**Cosmetic follow-up only**: the result PDF renderer prints "Age: unconfirmed" instead of blank when DOB is null AND `birthdate_confirmed = false`. Optional polish; not blocking.

---

## Component 2 — `scripts/wipe-operational.ts`

Single transactional teardown. Default dry-run; requires `--commit --confirm="I-mean-it"` to execute.

**Wipes** (in dependency order, single `BEGIN; … COMMIT;`):

```
audit_log
result_amendments → result_values → results → structured_results_drafts
imaging_attachments
test_requests
visit_pins
payments
appointments
gift_code_redemptions
eod_cash_reconciliation
journal_lines → journal_entries
hmo_ar_subledger
visits
patients
inquiries
contact_messages
```

**Preserves:**

```
services, service price history
physicians, physician_schedules
result_templates, result_template_params, result_template_param_ranges
gift_code SKUs (definitions, not redemptions)
gl_accounts
staff_profiles
vendors, ap_*
payroll_*
clinic_closures
RLS policies, migrations, RLS context functions
```

**Behaviour:**

- Dry-run prints the row count it WOULD delete from each table.
- `--commit` requires the confirm token; aborts on bad input.
- Service-role client (`src/lib/supabase/admin.ts`).
- Writes one final `audit_log` row of its own AFTER the wipe — `action='ops.wipe', actor_id=<runner>, metadata={tables_cleared:[...], counts:{...}}` — so we have a trail of the wipe itself.
- Exits non-zero on any failure inside the transaction; partial-wipe impossible.

---

## Component 3 — `scripts/import-legacy-customers.ts`

Reads `<path>/CUSTOMER LIST - CUSTOMER LIST2.csv`. Default dry-run.

### Pre-flight report (always produced)

CSV at `tmp/legacy-import-preflight-<timestamp>.csv` plus a human summary to stdout:

- Total rows, parseable rows, junk rows skipped, with sample
- DOB present rate, phone format distribution, email present rate
- Top 30 referring physicians (frequency-sorted) — partner reviews
- Within-sheet duplicates by `(normalized_last, normalized_first, phone)`
- Potential matches against existing `patients` (will be empty after wipe; included for re-runs against partial state)
- Per-row preview of parse output for the first 50 rows

### Row parser

1. **Skip** rows where `Full Name` is empty/whitespace-only OR matches `/^,\s*$/`.
2. **Name parse** from `Full Name`:
   - Split on first `,` → `[last_part, rest]`.
   - `rest.trim().split(/\s+/)` → first token = `first_name`, remainder joined = `middle_name`.
   - Title-case each token; preserve apostrophes/hyphens.
   - Fallback: if `Full Name` empty but dedicated `Last Name` / `First Name` populated, use those.
3. **DOB parse**:
   - Try `M/D/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`. Reject Age column entirely.
   - If unparseable → `birthdate = NULL`, add `dob_missing` or `dob_unparseable` warning.
4. **Phone normalize to E.164**:
   - Strip non-digits.
   - 11 digits starting `09` → `+639xxxxxxxxx`
   - 12 digits starting `639` → `+639xxxxxxxxx`
   - 10 digits starting `9` → `+639xxxxxxxxx`
   - Anything else → `phone = NULL`, raw preserved in `legacy_intake.raw.contact_number`, warning `phone_unparseable`.
5. **Email**: lowercase + trim; if empty after trim → NULL.
6. **Address**: join `street, barangay, city` with `, `, collapse whitespace, trim trailing commas.
7. **Sex**: map `Female/female/F` → `female`; `Male/male/M` → `male`; else NULL.
8. **Senior/PWD**: if both type ("Senior" / "PWD") and ID number present, populate both. If only type, warning `senior_pwd_id_missing` and leave both NULL (the CHECK constraint requires both-or-neither).
9. **Referring physician**: free-text copy of `Doctor` column, trim only.
10. **Referral source mapping** (from `How did you know about DR Med?`):

    ```
    "Doctor Referral"     → doctor_referral
    "Walk-in" / "Walk in" → walk_in
    "Facebook" / "FB"     → facebook
    "Instagram" / "IG"    → instagram
    "TikTok"              → tiktok
    "Google"              → google_search
    "Friend" / "Word"     → word_of_mouth
    "Returning"           → returning_patient
    "Gift Code"           → gift_code
    everything else       → 'other' + warning referral_source_unmapped:<raw>
    ```
11. **Result-release pref**: parse `Preferred Medium of Result Release` similarly; default `portal_only` if unmapped.
12. **`legacy_intake` payload**:

    ```ts
    {
      source: 'google_sheet_CUSTOMER_LIST2',
      imported_at: <ISO>,
      original_row_index: <CSV line>,
      raw: { /* all 22 columns verbatim */ },
      import_warnings: string[]
    }
    ```

### Dedup cascade (against live DB)

Within-sheet dedup first (collapse exact dupes by `(normalized_last, normalized_first, phone)` — keep earliest row, append duplicate row indexes to `legacy_intake.duplicate_of`). Then against live `patients`:

1. `(lower(last_name), lower(first_name), birthdate)` if DOB present.
2. `(lower(last_name), lower(first_name), normalized_phone)` if phone present.
3. `(lower(last_name), lower(first_name), lower(email))` if email present.
4. Otherwise: insert; flag in report as `name_only_match_possible` so reception can merge later via the existing migration-0025 merge tool.

**Never auto-merge on weak keys.** Existing tooling lets reception merge manually if needed.

### Commit phase (`--commit`)

- Insert `legacy_import_runs` row with `dry_run=false`.
- Bulk insert parsed `patients` rows in batches of 500 with `legacy_import_run_id` set.
- One `audit_log` row per insert: `action='patient.legacy_import', metadata={row_index, warnings}`.
- Update `legacy_import_runs` row with `ended_at` + counts.
- Print rollback command: `DELETE FROM patients WHERE legacy_import_run_id = '<uuid>';`.

---

## Component 4 — UI surface area

### Intake form (reception + public)

**Reception:** edit the shared patient form at `src/app/(staff)/staff/(dashboard)/patients/patient-form.tsx` (used by both `/staff/patients/new` and `/staff/patients/[id]/edit`) plus the matching server actions in `actions.ts` and `[id]/edit-actions.ts`. Add fields:

- Senior/PWD type (radio: None / Senior / PWD) + conditional ID number input.
- Referring physician (free-text input with autocomplete from `distinct(referring_physician) order by count desc limit 100`).
- Referral source (dropdown: 10 controlled values from the CHECK constraint).
- Result-release preference (dropdown: 4 values; default `portal_only`).
- DOB (existing field; on submit set `birthdate_confirmed = true` whenever DOB is non-empty).

**Public booking:** `src/app/(marketing)/schedule/booking-form.tsx` — add referral-source dropdown only. Other fields stay reception-only for now to avoid form bloat.

### Patient card

Find the existing patient summary card component (likely `src/components/staff/patient-*` or inline on patient detail page) and add badge row:

- 🟡 **Senior/PWD** — when `senior_pwd_type` is set. Tooltip shows ID number + discount note.
- 👨‍⚕️ **Referred by: DR. NAME** — when `referring_physician` is set.
- 📤 **Prefers: print pickup / portal+email / sms** — when `result_release_pref != 'portal_only'`.
- ⚠️ **Confirm DOB** — when `birthdate_confirmed = false`. Clicking opens DOB edit modal.

### Visit creation

`src/app/(staff)/staff/(dashboard)/visits/new/`:

- If patient is senior/PWD-eligible, show a checkbox "Apply 20% Senior-PWD discount" (default checked; reception can untick).
- When checked, visit-level `discount_php` is computed as 20% of subtotal, and `discount_reason` is set to `"Senior-PWD (ID: <id>)"`. The discount columns are added to `visits` in migration 0051 (confirmed not present in 0001 nor any later migration as of 2026-05-25).

### Receipt page

`src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx` (HTML, not PDF) — add lines between subtotal and total:

```
Subtotal:                      ₱ 1,500.00
Senior-PWD Discount (20%):   − ₱   300.00
   (ID: 1234567890)
─────────────────────────────────────────
Total Due:                     ₱ 1,200.00
```

The ID line is mandatory for legal compliance (BIR will ask).

---

## Build sequence

1. **Migration 0051** + types regen.
2. **Operational wipe** (dry-run → review counts → commit). Tag DB snapshot before commit.
3. **Pre-flight import** (dry-run → review report with partner → make any mapping corrections).
4. **Commit import**.
5. **Intake form updates** (reception first; public form is one field).
6. **Patient card badges**.
7. **Visit creation discount checkbox** + receipt page discount line.
8. **Smoke test**: create a visit for a senior/PWD legacy patient, take payment, release a result. Verify discount appears on receipt, age-banded ranges skip cleanly when DOB unconfirmed.
9. **Typecheck + lint**. Commit per Conventional Commits.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Wipe deletes something we should have kept | Pre-wipe pg_dump tagged `pre-legacy-import-2026-05-25`. Dry-run shows row counts before commit. |
| Import inserts wrong-parsed rows en masse | Pre-flight report reviewed by partner before commit. `--dry-run` is default; `--commit` is opt-in. |
| Rollback is hard | `legacy_import_run_id` per-row + `legacy_import_runs` table → one-statement rollback. |
| Senior/PWD discount logic ships incomplete | Scoped: capture data + show on receipt now; GL contra-revenue account + BIR ledger view in follow-up. Books are clean because nothing is posted yet. |
| Reception finds typos / dupes in legacy data | Existing migration-0025 merge tool handles dupes. Patient-edit page handles typos. Confirm-DOB badge surfaces missing-DOB rows naturally. |
| Lab results pipeline breaks on null DOB | Explicit guard: age-banding skipped when `birthdate_confirmed = false`; result PDF shows "Age: unconfirmed". |
| `pg_trgm` extension not available in Supabase project | It's available by default on Supabase Postgres. Migration uses `create extension if not exists`. |

---

## Out of scope (explicit deferrals)

- **Senior/PWD discount GL bridge** — contra-revenue account `4900-Discounts-SeniorPWD`. Books aren't being posted in beta; safe to follow up.
- **Senior/PWD BIR audit ledger view** — admin report listing every discounted transaction with ID number for monthly BIR submission.
- **Promote referring-physician strings → `physicians` table** — admin tool. Free-text is fine for first weeks.
- **Email/SMS result delivery** — `result_release_pref` is captured; hooks fire later when SMTP/SMS gateway integration ships.
- **Top-referrers admin dashboard chart** — partner-facing analytics.
- **Patient-portal access for legacy patients** — no visits/PINs; covered by separate Google-OAuth project.
