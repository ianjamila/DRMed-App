# Addendum — Legacy Customer Import & Attribution Capture

**Supersedes parts of:** `2026-05-25-legacy-customer-import-design.md`
**Date:** 2026-05-25
**Reason:** Codebase audit during plan-writing surfaced that migration `0011_accounting_capture.sql` (Phase 7, shipped May 2026) already added every attribution column the original spec proposed. The patient form and visit form already use them. The discount lives per-line on `test_requests`, not per-visit. The original spec is preserved unchanged for the rationale/brainstorm trail; this addendum is the authoritative reference for the implementation plan.

## What's already shipped (do NOT re-add)

### On `public.patients` (migration 0011, lines 119-138):
- `referral_source text` — CHECK constraint values: `'doctor_referral', 'customer_referral', 'online_facebook', 'online_website', 'online_google', 'walk_in', 'tenant_employee_northridge', 'other'`
- `referred_by_doctor text` (free text)
- `preferred_release_medium text` — CHECK constraint values: `'physical', 'email', 'viber', 'gcash', 'pickup'`
- `senior_pwd_id_kind text` — CHECK constraint values: `'senior', 'pwd'`
- `senior_pwd_id_number text`
- `consent_signed_at timestamptz` (RA 10173 consent)
- `is_repeat_patient boolean` (auto-maintained by `trg_visits_repeat_flag`)

### On `public.services` (migration 0006):
- `senior_discount_php numeric(10,2)` — curated per-service peso discount amount

### On `public.test_requests` (migration 0011, lines 78-95):
- `discount_kind text` — CHECK values include `'senior_pwd_20', 'pct_10', 'pct_5', 'other_pct_20', 'custom'`
- `discount_amount_php numeric(10,2) not null default 0`
- `final_price_php numeric(10,2)` — already post-discount
- `base_price_php numeric(10,2)`

### UI already wired:
- `src/app/(staff)/staff/(dashboard)/patients/patient-form.tsx` has senior/PWD inputs, referral_source dropdown, preferred_release_medium dropdown, referred_by_doctor input.
- `src/app/(staff)/staff/(dashboard)/visits/new/visit-form.tsx` has per-line discount dropdown wired to `discountFor()` (lines 87-105) which already handles `senior_pwd_20` (uses `services.senior_discount_php` when set, else statutory 20%).

## Name corrections (use existing names, NOT what original spec proposed)

| Original spec name | **Use this instead** |
|---|---|
| `senior_pwd_type` | `senior_pwd_id_kind` |
| `senior_pwd_id` | `senior_pwd_id_number` |
| `referring_physician` | `referred_by_doctor` |
| `result_release_pref` | `preferred_release_medium` |

Importer maps sheet values to the **existing real-ops vocabularies**, not to the values the original spec invented.

## Discount-on-visits is WRONG — drop those tasks

Original spec proposed adding `discount_php` + `discount_reason` to `visits` and patching `recalc_visit_payment()`. **Do not do this.** Discounts live on `test_requests` per-line, which is more correct legally (BIR audits per-line discounts) and is already integrated with the visit form, services price snapshots, and the GL bridge. The `visits.total_php` value is gross; `sum(test_requests.final_price_php)` gives net. The payment trigger doesn't need surgery.

## What's still missing — actual work for plan

### 1. Schema additions (small migration 0051)
```sql
alter table public.patients
  alter column birthdate drop not null,
  add column birthdate_confirmed boolean not null default false,
  add column legacy_intake jsonb,
  add column legacy_import_run_id uuid;

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

create index idx_patients_legacy_import_run
  on public.patients(legacy_import_run_id)
  where legacy_import_run_id is not null;

create extension if not exists pg_trgm;
create index idx_patients_name_trgm
  on public.patients using gin (
    (lower(coalesce(first_name,'') || ' '
       || coalesce(last_name,'') || ' '
       || coalesce(middle_name,''))) gin_trgm_ops
  );
```

### 2. `referral_source` becomes extensible (migration 0052)

The original CHECK constraint locks the vocabulary at the schema level — adding a new category (e.g. "Instagram", "TikTok", "Returning Patient") requires a code migration each time. Replace with a lookup table so new values can be added by SQL `INSERT` (or admin UI later) without schema changes.

```sql
create table public.referral_sources (
  id          text primary key,        -- machine value, e.g. 'online_instagram'
  label       text not null,           -- human label, e.g. 'Instagram'
  sort_order  int  not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Seed with the existing 8 vocabulary values + a few obvious additions for
-- legacy import that the original CHECK didn't have.
insert into public.referral_sources (id, label, sort_order) values
  ('doctor_referral',             'Doctor referral',                   10),
  ('customer_referral',           'Customer referral',                 20),
  ('online_facebook',             'Facebook',                          30),
  ('online_website',              'Website',                           40),
  ('online_google',               'Google',                            50),
  ('online_instagram',            'Instagram',                         60),
  ('online_tiktok',               'TikTok',                            70),
  ('walk_in',                     'Walk-in',                           80),
  ('returning_patient',           'Returning patient',                 90),
  ('tenant_employee_northridge',  'Northridge tenant / employee',     100),
  ('gift_code',                   'Gift code',                        110),
  ('other',                       'Other',                            120);

-- Drop the old CHECK constraint and add an FK that points at the lookup.
-- This still validates input (can't insert a referral_source that doesn't
-- exist as an id in the lookup) but allows expansion via INSERT.
alter table public.patients
  drop constraint if exists patients_referral_source_check;

alter table public.patients
  add constraint patients_referral_source_fk
  foreign key (referral_source) references public.referral_sources(id);

-- RLS: anyone authenticated can read; only admin can mutate (admin UI is
-- follow-up; INSERTs via service-role until then).
alter table public.referral_sources enable row level security;
create policy "referral_sources: read by anyone"
  on public.referral_sources for select to anon, authenticated using (true);
```

The patient form's hardcoded `REFERRAL_OPTIONS` list gets replaced with a fetch from `referral_sources where is_active = true order by sort_order` at render time. Future additions: `INSERT INTO referral_sources (id, label) VALUES ('online_threads', 'Threads');` and the dropdown gets the new option on next render. No code change.

### 3. Wipe script — `scripts/wipe-operational.ts`
Unchanged from original spec. Single transactional teardown, dry-run by default.

### 4. Importer — `scripts/import-legacy-customers.ts`
Unchanged from original spec's logic, with **column names** and **vocabulary mappings** corrected:

**Inserted columns:** `first_name, last_name, middle_name, birthdate, sex, phone, email, address, referral_source, referred_by_doctor, preferred_release_medium, senior_pwd_id_kind, senior_pwd_id_number, legacy_intake, legacy_import_run_id, pre_registered (false)`.

**Vocabulary mapping** (sheet text → existing enum/lookup id):

| Sheet text | → `referral_source` |
|---|---|
| `"Doctor Referral"` | `doctor_referral` |
| `"Customer Referral"`, `"Friend"`, `"Word of mouth"` | `customer_referral` |
| `"Facebook"`, `"FB"` | `online_facebook` |
| `"Instagram"`, `"IG"` | `online_instagram` |
| `"TikTok"` | `online_tiktok` |
| `"Website"` | `online_website` |
| `"Google"`, `"Google Search"` | `online_google` |
| `"Walk-in"`, `"Walk in"` | `walk_in` |
| `"Returning"`, `"Repeat"` | `returning_patient` |
| `"Northridge"`, `"Tenant"`, `"Employee"` | `tenant_employee_northridge` |
| anything else (incl. blank) | `other` + warning `referral_source_unmapped:<raw>` |

| Sheet text | → `preferred_release_medium` |
|---|---|
| `"Physical"`, `"Pickup"`, `"Print pickup"`, `"In person"` | `physical` |
| `"Email"`, `"E-mail"` | `email` |
| `"Viber"` | `viber` |
| `"GCash"`, `"Gcash"` | `gcash` |
| `"Counter"`, `"Pickup at counter"` | `pickup` |
| anything else (incl. blank) | `NULL` (not required; physical is the implied default at this clinic) |

| Sheet text | → `senior_pwd_id_kind` |
|---|---|
| `"Senior"`, `"SC"` | `senior` |
| `"PWD"` | `pwd` |
| anything else (or blank) | `NULL` |

### 5. Receipt page — `src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx`
Currently selects only `services.price_php` and displays `visit.total_php`. Needs:
- Select per-line `base_price_php, discount_kind, discount_amount_php, final_price_php` from `test_requests`.
- Select `senior_pwd_id_kind, senior_pwd_id_number` from `patients`.
- Render per-line discount column when any line has `discount_kind != null`.
- Render subtotal / discount lines / total at the foot.
- When any line has `discount_kind = 'senior_pwd_20'`, show `(ID: <senior_pwd_id_number>)` under the discount line — required for BIR compliance.

### 6. Patient card — "Confirm DOB" badge
When `birthdate IS NULL OR birthdate_confirmed = false`, show an inline warning badge linking to the edit form. Locate the patient summary component (probably on `/staff/patients/[id]/page.tsx`) during implementation.

## Tasks now DROPPED from original spec scope

- ❌ Add `senior_pwd_type`, `senior_pwd_id`, `referring_physician`, `referral_source`, `result_release_pref` columns (already exist under different names).
- ❌ Add `discount_php` + `discount_reason` to `visits` (lives on test_requests).
- ❌ Patch `recalc_visit_payment()` trigger (not needed; discount on lines).
- ❌ Add senior/PWD radio + ID input to patient form (already there).
- ❌ Add referral-source dropdown (already there — but is replaced with a lookup-table-driven version per decision 2).
- ❌ Add referring-physician input (already there).
- ❌ Add result-release-pref dropdown (already there).
- ❌ Add senior/PWD discount checkbox to visit form (already there per-line).
- ❌ Receipt subtotal/discount line as a NEW concept (it's an EDIT of the existing receipt, not a new feature).

## Tasks unchanged from original spec

- ✅ Make `birthdate` nullable, add `birthdate_confirmed`.
- ✅ Add `legacy_intake` jsonb + `legacy_import_run_id` + `legacy_import_runs` table.
- ✅ pg_trgm name-search index.
- ✅ Wipe script (dry-run → commit, single transaction).
- ✅ Importer script (dry-run → pre-flight CSV → commit; rollback-by-batch).
- ✅ Decisions log + deferrals.

## Tasks added by this addendum

- ➕ Migration 0052: `referral_sources` lookup table + drop old CHECK + FK + seed.
- ➕ Patient form: replace hardcoded `REFERRAL_OPTIONS` with a fetch from `referral_sources`.
- ➕ Patient card: "Confirm DOB" badge (was buried in original spec UI section; promoted to its own task here).
- ➕ Receipt page: discount line + senior/PWD ID display.
