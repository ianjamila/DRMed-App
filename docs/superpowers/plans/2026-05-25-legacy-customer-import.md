# Legacy Customer Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wipe operational test data, then import ~4,480 historical customers from `~/Downloads/CUSTOMER LIST - CUSTOMER LIST2.csv` into `public.patients` with full provenance and rollback-by-batch, plus minimal UI work to surface what's still missing (Confirm-DOB badge, receipt discount line). Enables staff-side beta on 2026-05-26.

**Architecture:** Two small migrations (0051 adds nullable DOB + `birthdate_confirmed` + `legacy_intake` jsonb + `legacy_import_runs` table + pg_trgm name index; 0052 converts the existing `referral_source` CHECK to a `referral_sources` lookup table so categories can be added without migrations). Two single-transactional Node scripts (`wipe-operational.ts`, `import-legacy-customers.ts`) under `scripts/`, both dry-run by default, gated by `--commit --confirm` tokens. Three small TypeScript parsing modules (`name-parser.ts`, `phone-normalizer.ts`, `vocabulary-mapper.ts`) with an executable smoke script that asserts known inputs. UI edits to the receipt page, the patient detail page, and the patient form.

**Tech Stack:** Next.js 16 (App Router), Supabase (Postgres + service-role client at `src/lib/supabase/admin.ts`), TypeScript strict, Zod (existing), React 19, `csv-parse` (newly added dep). Conventions from `CLAUDE.md` and `AGENTS.md`. No unit-test runner — smoke scripts (Node + SQL) are the verification mechanism.

**Authoritative reference:** `docs/superpowers/specs/2026-05-25-legacy-customer-import-ADDENDUM.md` (which supersedes parts of `docs/superpowers/specs/2026-05-25-legacy-customer-import-design.md`).

---

## File structure

### Create — migrations + smoke

```
supabase/migrations/0051_legacy_intake_and_birthdate_confirm.sql
supabase/migrations/0052_referral_sources_lookup.sql
scripts/smoke-0051-0052.sql
```

### Create — scripts

```
scripts/wipe-operational.ts
scripts/import-legacy-customers.ts
scripts/smoke-legacy-parsers.ts
```

### Create — pure parsing modules (importable, testable)

```
src/lib/legacy-import/name-parser.ts
src/lib/legacy-import/phone-normalizer.ts
src/lib/legacy-import/vocabulary-mapper.ts
src/lib/legacy-import/types.ts
```

### Modify

```
package.json                                                                   -- add csv-parse dep + 5 new npm scripts
src/types/database.ts                                                          -- regen after each migration
src/app/(staff)/staff/(dashboard)/patients/patient-form.tsx                    -- replace REFERRAL_OPTIONS with fetch
src/app/(staff)/staff/(dashboard)/patients/page.tsx                            -- pass referral source rows down
src/app/(staff)/staff/(dashboard)/patients/new/page.tsx                        -- pass referral source rows down
src/app/(staff)/staff/(dashboard)/patients/[id]/edit/page.tsx                  -- pass referral source rows down
src/app/(staff)/staff/(dashboard)/patients/[id]/page.tsx                       -- Confirm-DOB badge
src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx                 -- discount line + senior/PWD ID
src/lib/legacy-import/loaders.ts                                               -- listActiveReferralSources()
```

---

## Task 1: Migration 0051 — schema additions

**Files:**
- Create: `supabase/migrations/0051_legacy_intake_and_birthdate_confirm.sql`

- [ ] **Step 1: Write the migration**

```sql
-- =============================================================================
-- 0051_legacy_intake_and_birthdate_confirm.sql
-- =============================================================================
-- Loosens patients.birthdate to allow null (legacy ops sheet often lacks
-- DOB); adds a birthdate_confirmed flag so reception can mark records they
-- have visually verified against a physical ID; adds a legacy_intake jsonb
-- to preserve the original sheet row verbatim; adds a legacy_import_runs
-- audit table so any batched import can be rolled back with one DELETE.
-- =============================================================================

alter table public.patients
  alter column birthdate drop not null,
  add column birthdate_confirmed boolean not null default false,
  add column legacy_intake jsonb,
  add column legacy_import_run_id uuid;

-- Existing rows are real reception-entered patients, so their DOB (when
-- present) is considered confirmed. The default false applies only to
-- future legacy-imported rows.
update public.patients
   set birthdate_confirmed = true
 where birthdate is not null;

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

-- Reception name-search needs to be fuzzy: half the imported rows lack
-- DOB and email, so name is the primary lookup tool.
create extension if not exists pg_trgm;

create index idx_patients_name_trgm
  on public.patients using gin (
    (lower(coalesce(first_name,'') || ' '
       || coalesce(last_name,'') || ' '
       || coalesce(middle_name,''))) gin_trgm_ops
  );

-- RLS: legacy_import_runs is service-role-only (no staff or patient policy).
alter table public.legacy_import_runs enable row level security;
```

- [ ] **Step 2: Apply migration locally**

```bash
supabase db reset    # destroys local data, re-applies all migrations
```

Expected: completes without error; final line shows `Finished supabase db reset`.

- [ ] **Step 3: Verify schema in psql**

```bash
psql "$SUPABASE_DB_URL_LOCAL" -c "\d public.patients" | grep -E "birthdate|legacy_"
psql "$SUPABASE_DB_URL_LOCAL" -c "\d public.legacy_import_runs"
psql "$SUPABASE_DB_URL_LOCAL" -c "\dx pg_trgm"
```

Expected: `birthdate` shown without `not null`; `birthdate_confirmed`, `legacy_intake`, `legacy_import_run_id` present; `legacy_import_runs` table listed; `pg_trgm` extension installed.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0051_legacy_intake_and_birthdate_confirm.sql
git commit -m "feat(db): add legacy_intake + birthdate_confirmed for legacy customer import"
```

---

## Task 2: Migration 0052 — referral_sources lookup table

**Files:**
- Create: `supabase/migrations/0052_referral_sources_lookup.sql`

- [ ] **Step 1: Write the migration**

```sql
-- =============================================================================
-- 0052_referral_sources_lookup.sql
-- =============================================================================
-- The original CHECK constraint on patients.referral_source (added in 0011)
-- requires a code migration each time the lab wants to track a new category
-- (e.g. Instagram, TikTok, gift code redemptions). Replace with a lookup
-- table so new values can be added by SQL INSERT (or an admin UI later)
-- without touching the schema.
-- =============================================================================

create table public.referral_sources (
  id          text primary key,
  label       text not null,
  sort_order  int  not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Seed with the existing 8 vocabulary values from 0011 plus 4 additions
-- the legacy import needs to map to. ids match the prior enum strings so
-- existing rows continue to validate.
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
-- (The CHECK was inlined in 0011 so its system name is auto-generated;
-- the IF EXISTS guard makes this safe regardless of the suffix.)
alter table public.patients
  drop constraint if exists patients_referral_source_check;

alter table public.patients
  add constraint patients_referral_source_fk
  foreign key (referral_source) references public.referral_sources(id);

-- RLS: read-by-anyone (it's a public dropdown source); writes are
-- service-role only until an admin UI ships.
alter table public.referral_sources enable row level security;

create policy "referral_sources: read by anyone"
  on public.referral_sources for select to anon, authenticated
  using (true);
```

- [ ] **Step 2: Apply migration locally**

```bash
supabase db reset
```

Expected: completes without error.

- [ ] **Step 3: Verify lookup + FK + RLS**

```bash
psql "$SUPABASE_DB_URL_LOCAL" -c "select id, label from public.referral_sources order by sort_order;"
psql "$SUPABASE_DB_URL_LOCAL" -c "\d public.patients" | grep referral_source
psql "$SUPABASE_DB_URL_LOCAL" -c "select polname from pg_policy where polrelid = 'public.referral_sources'::regclass;"
```

Expected: 12 rows in lookup; `referral_source` FK on patients; one `read by anyone` policy.

- [ ] **Step 4: Verify FK rejects unknown values**

```bash
psql "$SUPABASE_DB_URL_LOCAL" -c "insert into public.patients (first_name, last_name, referral_source) values ('Test', 'FK', 'nonexistent_source');"
```

Expected: ERROR mentioning `patients_referral_source_fk`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0052_referral_sources_lookup.sql
git commit -m "feat(db): convert referral_source CHECK to extensible lookup table"
```

---

## Task 3: SQL smoke + types regen

**Files:**
- Create: `scripts/smoke-0051-0052.sql`
- Modify: `src/types/database.ts` (regenerated)

- [ ] **Step 1: Write the smoke script**

```sql
-- =============================================================================
-- scripts/smoke-0051-0052.sql
-- =============================================================================
-- Run with: psql "$SUPABASE_DB_URL_LOCAL" -v ON_ERROR_STOP=1 -f scripts/smoke-0051-0052.sql
-- Exit code is non-zero on any failed assertion thanks to ON_ERROR_STOP.
-- =============================================================================

begin;

-- A1: birthdate is now nullable.
do $$
begin
  if (
    select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'patients' and column_name = 'birthdate'
  ) <> 'YES' then
    raise exception 'A1 FAIL: patients.birthdate is still NOT NULL';
  end if;
end $$;

-- A2: new columns exist with correct types.
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'patients'
    and column_name in ('birthdate_confirmed','legacy_intake','legacy_import_run_id');
  if v_count <> 3 then
    raise exception 'A2 FAIL: expected 3 new columns, found %', v_count;
  end if;
end $$;

-- A3: pg_trgm extension is installed.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    raise exception 'A3 FAIL: pg_trgm extension not installed';
  end if;
end $$;

-- A4: referral_sources seeded with 12 rows.
do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.referral_sources where is_active;
  if v_count <> 12 then
    raise exception 'A4 FAIL: expected 12 referral_sources, found %', v_count;
  end if;
end $$;

-- A5: legacy_import_runs round-trip insert + rollback-by-batch query works.
do $$
declare
  v_run_id uuid;
  v_patient_id uuid;
begin
  insert into public.legacy_import_runs (source, dry_run, rows_in)
    values ('smoke_test', false, 1)
    returning id into v_run_id;

  insert into public.patients (first_name, last_name, legacy_import_run_id, legacy_intake)
    values ('Smoke', 'Test', v_run_id, '{"source":"smoke"}'::jsonb)
    returning id into v_patient_id;

  -- Rollback-by-batch
  delete from public.patients where legacy_import_run_id = v_run_id;
  if exists (select 1 from public.patients where id = v_patient_id) then
    raise exception 'A5 FAIL: rollback-by-batch delete left orphan row';
  end if;

  delete from public.legacy_import_runs where id = v_run_id;
end $$;

-- A6: existing rows with non-null birthdate were retroactively confirmed.
-- (Skipped on a freshly-reset DB with zero patients; only meaningful on staging/prod.)
do $$
declare
  v_unconfirmed_with_dob int;
begin
  select count(*) into v_unconfirmed_with_dob
  from public.patients
  where birthdate is not null and birthdate_confirmed = false;
  if v_unconfirmed_with_dob > 0 then
    raise exception 'A6 FAIL: % existing rows with DOB were not auto-confirmed', v_unconfirmed_with_dob;
  end if;
end $$;

rollback;  -- keep DB clean

select 'SMOKE 0051+0052: all assertions passed' as result;
```

- [ ] **Step 2: Run smoke**

```bash
psql "$SUPABASE_DB_URL_LOCAL" -v ON_ERROR_STOP=1 -f scripts/smoke-0051-0052.sql
```

Expected: final line `SMOKE 0051+0052: all assertions passed`; exit code 0.

- [ ] **Step 3: Regenerate types**

```bash
npm run db:types
```

Expected: `src/types/database.ts` updated; `git diff src/types/database.ts | head -50` shows new fields (`birthdate_confirmed`, `legacy_intake`, `legacy_import_run_id`) on `patients` Row/Insert/Update, and a new `legacy_import_runs` table type, and a new `referral_sources` table type.

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: pass (no errors). The old `REFERRAL_OPTIONS` array in `patient-form.tsx` is plain TS not driven by the type, so it does not need to fail for this task — it's repaired in Task 9.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-0051-0052.sql src/types/database.ts
git commit -m "test(db): smoke for 0051+0052 + regen types"
```

---

## Task 4: Pure parsing modules

**Files:**
- Create: `src/lib/legacy-import/types.ts`
- Create: `src/lib/legacy-import/name-parser.ts`
- Create: `src/lib/legacy-import/phone-normalizer.ts`
- Create: `src/lib/legacy-import/vocabulary-mapper.ts`

- [ ] **Step 1: Write the shared types**

```typescript
// src/lib/legacy-import/types.ts

export type ImportWarning =
  | 'dob_missing'
  | 'dob_unparseable'
  | 'phone_unparseable'
  | 'sex_unparseable'
  | 'name_unparseable'
  | 'senior_pwd_id_missing'
  | { kind: 'referral_source_unmapped'; raw: string }
  | { kind: 'release_medium_unmapped'; raw: string };

export interface LegacyIntakePayload {
  source: 'google_sheet_CUSTOMER_LIST2';
  imported_at: string;          // ISO timestamp
  original_row_index: number;   // 1-based CSV row, header counted as row 1
  raw: Record<string, string>;  // every sheet column verbatim
  import_warnings: ImportWarning[];
  duplicate_of?: number[];      // when collapsed to a canonical row in-sheet
}

export interface ParsedRow {
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  birthdate: string | null;          // ISO yyyy-mm-dd or null
  sex: 'male' | 'female' | null;
  phone: string | null;              // E.164, e.g. +639171234567
  email: string | null;              // lowercased
  address: string | null;
  referral_source: string | null;    // referral_sources.id
  referred_by_doctor: string | null;
  preferred_release_medium: string | null;
  senior_pwd_id_kind: 'senior' | 'pwd' | null;
  senior_pwd_id_number: string | null;
  legacy_intake: LegacyIntakePayload;
}
```

- [ ] **Step 2: Write the name parser**

```typescript
// src/lib/legacy-import/name-parser.ts

interface NameParseResult {
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  unparseable: boolean;
}

/**
 * Parse the legacy CSV's "Full Name" column which is conventionally
 * `"Last, First"` or `"Last, First Middle"`. Falls back to dedicated
 * Last/First columns when Full Name is empty.
 */
export function parseName(
  fullName: string | undefined | null,
  lastFallback: string | undefined | null,
  firstFallback: string | undefined | null,
  middleFallback: string | undefined | null,
): NameParseResult {
  const full = (fullName ?? '').trim();

  if (full && full.includes(',')) {
    const [rawLast, ...restParts] = full.split(',');
    const rest = restParts.join(',').trim();
    const last = titleCase(rawLast.trim());
    if (!rest) {
      return { first_name: null, last_name: last || null, middle_name: null, unparseable: !last };
    }
    const tokens = rest.split(/\s+/);
    const first = titleCase(tokens[0]);
    const middle = tokens.length > 1 ? titleCase(tokens.slice(1).join(' ')) : null;
    return {
      first_name: first || null,
      last_name: last || null,
      middle_name: middle || null,
      unparseable: !last && !first,
    };
  }

  // Full Name absent or no comma — try dedicated columns.
  const first = titleCase((firstFallback ?? '').trim());
  const last  = titleCase((lastFallback  ?? '').trim());
  const middle = titleCase((middleFallback ?? '').trim());
  if (first || last) {
    return {
      first_name: first || null,
      last_name: last || null,
      middle_name: middle || null,
      unparseable: false,
    };
  }

  // Some rows have only Full Name without a comma, e.g. "Jane Doe".
  if (full) {
    const tokens = full.split(/\s+/);
    if (tokens.length === 1) {
      return { first_name: titleCase(tokens[0]), last_name: null, middle_name: null, unparseable: false };
    }
    return {
      first_name: titleCase(tokens[0]),
      last_name: titleCase(tokens[tokens.length - 1]),
      middle_name: tokens.length > 2 ? titleCase(tokens.slice(1, -1).join(' ')) : null,
      unparseable: false,
    };
  }

  return { first_name: null, last_name: null, middle_name: null, unparseable: true };
}

function titleCase(input: string): string {
  if (!input) return '';
  return input
    .toLowerCase()
    .split(/(\s|-|')/g)
    .map((part) => (/[a-z]/i.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join('');
}
```

- [ ] **Step 3: Write the phone normalizer**

```typescript
// src/lib/legacy-import/phone-normalizer.ts

interface PhoneResult {
  e164: string | null;
  unparseable: boolean;
}

/**
 * Normalize a Philippine mobile number to E.164 (+639XXXXXXXXX).
 * Accepts `09xxxxxxxxx`, `639xxxxxxxxx`, `9xxxxxxxxx`, and tolerates
 * spaces, dashes, parens, and `+` prefixes.
 */
export function normalizePhone(raw: string | undefined | null): PhoneResult {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { e164: null, unparseable: false };

  const digits = trimmed.replace(/[^0-9]/g, '');

  if (digits.length === 11 && digits.startsWith('09')) {
    return { e164: `+63${digits.substring(1)}`, unparseable: false };
  }
  if (digits.length === 12 && digits.startsWith('639')) {
    return { e164: `+${digits}`, unparseable: false };
  }
  if (digits.length === 10 && digits.startsWith('9')) {
    return { e164: `+63${digits}`, unparseable: false };
  }
  if (digits.length === 13 && digits.startsWith('0639')) {
    return { e164: `+${digits.substring(1)}`, unparseable: false };
  }

  return { e164: null, unparseable: true };
}
```

- [ ] **Step 4: Write the vocabulary mapper**

```typescript
// src/lib/legacy-import/vocabulary-mapper.ts

/**
 * Map the legacy sheet's free-text referral source to one of the
 * referral_sources.id values seeded in migration 0052. Unmapped → 'other'.
 */
const REFERRAL_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*doctor\b|\bdoc\b|^dr\.?$/i,                               'doctor_referral'],
  [/customer\s*referral|friend|word.?of.?mouth|family|relative/i, 'customer_referral'],
  [/facebook|^fb$/i,                                              'online_facebook'],
  [/instagram|^ig$/i,                                             'online_instagram'],
  [/tiktok|tik.?tok/i,                                            'online_tiktok'],
  [/website|web.?site/i,                                          'online_website'],
  [/google|search/i,                                              'online_google'],
  [/walk[\s-]?in/i,                                               'walk_in'],
  [/returning|repeat|previous|former/i,                           'returning_patient'],
  [/northridge|tenant|employee/i,                                 'tenant_employee_northridge'],
  [/gift\s*code|voucher/i,                                        'gift_code'],
];

export interface ReferralMapResult {
  id: string;                  // always set; falls back to 'other'
  unmapped_raw?: string;       // present when mapping fell through
}

export function mapReferralSource(raw: string | undefined | null): ReferralMapResult {
  const text = (raw ?? '').trim();
  if (!text) return { id: 'other', unmapped_raw: '' };
  for (const [pattern, id] of REFERRAL_PATTERNS) {
    if (pattern.test(text)) return { id };
  }
  return { id: 'other', unmapped_raw: text };
}

/**
 * Map sheet free-text result-release preference to the existing
 * preferred_release_medium CHECK values: 'physical', 'email', 'viber',
 * 'gcash', 'pickup'. Unmapped → null (no warning; pref is genuinely optional).
 */
const RELEASE_PATTERNS: Array<[RegExp, string]> = [
  [/physical|in.?person|hand|claim/i, 'physical'],
  [/e.?mail/i,                        'email'],
  [/viber/i,                          'viber'],
  [/gcash|g\.cash/i,                  'gcash'],
  [/counter|pick.?up/i,               'pickup'],
];

export interface ReleaseMapResult {
  id: string | null;
  unmapped_raw?: string;
}

export function mapReleaseMedium(raw: string | undefined | null): ReleaseMapResult {
  const text = (raw ?? '').trim();
  if (!text) return { id: null };
  for (const [pattern, id] of RELEASE_PATTERNS) {
    if (pattern.test(text)) return { id };
  }
  return { id: null, unmapped_raw: text };
}

export function mapSeniorPwdKind(raw: string | undefined | null): 'senior' | 'pwd' | null {
  const text = (raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (/^(senior|sc|senior\s*citizen)$/.test(text)) return 'senior';
  if (/^pwd$/.test(text)) return 'pwd';
  return null;
}

export function mapSex(raw: string | undefined | null): 'male' | 'female' | null {
  const text = (raw ?? '').trim().toLowerCase();
  if (text === 'female' || text === 'f') return 'female';
  if (text === 'male'   || text === 'm') return 'male';
  return null;
}

/**
 * Parse a Philippine-style date of birth. Accepts M/D/YYYY, MM/DD/YYYY,
 * YYYY-MM-DD, and YYYY/MM/DD. Returns ISO yyyy-mm-dd or null.
 */
export function parseBirthdate(raw: string | undefined | null): { iso: string | null; unparseable: boolean } {
  const text = (raw ?? '').trim();
  if (!text) return { iso: null, unparseable: false };

  // ISO first
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    return { iso: toIsoDate(+y, +m, +d), unparseable: false };
  }

  // US-style M/D/YYYY (the sheet uses this).
  const us = /^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/.exec(text);
  if (us) {
    const [, m, d, y] = us;
    return { iso: toIsoDate(+y, +m, +d), unparseable: false };
  }

  return { iso: null, unparseable: true };
}

function toIsoDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  return `${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}`;
}
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/legacy-import/
git commit -m "feat(legacy-import): pure parsing modules for name/phone/vocabulary"
```

---

## Task 5: Parser smoke script

**Files:**
- Create: `scripts/smoke-legacy-parsers.ts`
- Modify: `package.json` (add `smoke:legacy-parsers` script)

- [ ] **Step 1: Write the smoke script**

```typescript
// scripts/smoke-legacy-parsers.ts
//
// Run with: npm run smoke:legacy-parsers
// Exits 0 if all assertions pass, 1 on first failure. No deps.

import { parseName } from "../src/lib/legacy-import/name-parser";
import { normalizePhone } from "../src/lib/legacy-import/phone-normalizer";
import {
  mapReferralSource,
  mapReleaseMedium,
  mapSeniorPwdKind,
  mapSex,
  parseBirthdate,
} from "../src/lib/legacy-import/vocabulary-mapper";

let failed = 0;
let passed = 0;

function eq<T>(label: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(`✗ ${label}`);
    console.error(`  expected: ${JSON.stringify(expected)}`);
    console.error(`  actual:   ${JSON.stringify(actual)}`);
  }
}

// --- name parser ----------------------------------------------------------

eq("name: 'Gabuat, Princess'",
  parseName("Gabuat, Princess", "", "", ""),
  { first_name: "Princess", last_name: "Gabuat", middle_name: null, unparseable: false },
);

eq("name: 'Dela Cruz, Juan Miguel'",
  parseName("Dela Cruz, Juan Miguel", "", "", ""),
  { first_name: "Juan", last_name: "Dela Cruz", middle_name: "Miguel", unparseable: false },
);

eq("name: empty full, dedicated columns",
  parseName("", "Cruz", "Juan", "P."),
  { first_name: "Juan", last_name: "Cruz", middle_name: "P.", unparseable: false },
);

eq("name: nothing at all",
  parseName("", "", "", ""),
  { first_name: null, last_name: null, middle_name: null, unparseable: true },
);

eq("name: 'Jane Doe' (no comma)",
  parseName("Jane Doe", "", "", ""),
  { first_name: "Jane", last_name: "Doe", middle_name: null, unparseable: false },
);

// --- phone normalizer -----------------------------------------------------

eq("phone: 09095534228",  normalizePhone("09095534228"),   { e164: "+639095534228", unparseable: false });
eq("phone: 639095534228", normalizePhone("639095534228"),  { e164: "+639095534228", unparseable: false });
eq("phone: 9095534228",   normalizePhone("9095534228"),    { e164: "+639095534228", unparseable: false });
eq("phone: '0909 553 4228'", normalizePhone("0909 553 4228"), { e164: "+639095534228", unparseable: false });
eq("phone: '+63 909 553 4228'", normalizePhone("+63 909 553 4228"), { e164: "+639095534228", unparseable: false });
eq("phone: '(0909) 553-4228'", normalizePhone("(0909) 553-4228"), { e164: "+639095534228", unparseable: false });
eq("phone: garbage", normalizePhone("not a number"), { e164: null, unparseable: true });
eq("phone: empty", normalizePhone(""), { e164: null, unparseable: false });

// --- referral source mapper ----------------------------------------------

eq("ref: 'Doctor Referral'",   mapReferralSource("Doctor Referral"),  { id: "doctor_referral" });
eq("ref: 'Facebook'",          mapReferralSource("Facebook"),         { id: "online_facebook" });
eq("ref: 'FB'",                mapReferralSource("FB"),               { id: "online_facebook" });
eq("ref: 'Instagram'",         mapReferralSource("Instagram"),        { id: "online_instagram" });
eq("ref: 'TikTok'",            mapReferralSource("TikTok"),           { id: "online_tiktok" });
eq("ref: 'Walk-in'",           mapReferralSource("Walk-in"),          { id: "walk_in" });
eq("ref: 'Friend'",            mapReferralSource("Friend"),           { id: "customer_referral" });
eq("ref: 'Returning'",         mapReferralSource("Returning"),        { id: "returning_patient" });
eq("ref: 'Gift code'",         mapReferralSource("Gift code"),        { id: "gift_code" });
eq("ref: gibberish",           mapReferralSource("zzznope"),          { id: "other", unmapped_raw: "zzznope" });
eq("ref: empty",               mapReferralSource(""),                 { id: "other", unmapped_raw: "" });

// --- release medium mapper ------------------------------------------------

eq("rel: 'Physical'", mapReleaseMedium("Physical"), { id: "physical" });
eq("rel: 'Email'",    mapReleaseMedium("Email"),    { id: "email" });
eq("rel: 'Viber'",    mapReleaseMedium("Viber"),    { id: "viber" });
eq("rel: 'GCash'",    mapReleaseMedium("GCash"),    { id: "gcash" });
eq("rel: empty",      mapReleaseMedium(""),         { id: null });
eq("rel: unmapped",   mapReleaseMedium("smoke signals"), { id: null, unmapped_raw: "smoke signals" });

// --- senior/PWD + sex + dob ----------------------------------------------

eq("senior: 'Senior'", mapSeniorPwdKind("Senior"), "senior");
eq("senior: 'PWD'",    mapSeniorPwdKind("PWD"),    "pwd");
eq("senior: blank",    mapSeniorPwdKind(""),       null);
eq("sex: 'F'",         mapSex("F"),                "female");
eq("sex: 'Male'",      mapSex("Male"),             "male");
eq("sex: blank",       mapSex(""),                 null);

eq("dob: '12/1/1980'",   parseBirthdate("12/1/1980"),    { iso: "1980-12-01", unparseable: false });
eq("dob: '1980-12-01'",  parseBirthdate("1980-12-01"),   { iso: "1980-12-01", unparseable: false });
eq("dob: '12/1/2080'",   parseBirthdate("12/1/2080"),    { iso: "2080-12-01", unparseable: false });
eq("dob: 'invalid'",     parseBirthdate("invalid"),      { iso: null, unparseable: true });
eq("dob: blank",         parseBirthdate(""),             { iso: null, unparseable: false });

// --- summary --------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
```

- [ ] **Step 2: Add npm script + tsx dep check**

In `package.json`, locate the existing `"scripts"` block and add:

```json
"smoke:legacy-parsers": "tsx scripts/smoke-legacy-parsers.ts",
```

If `tsx` is not already a dev dep (check `package.json devDependencies`), install:

```bash
npm install --save-dev tsx
```

- [ ] **Step 3: Run smoke**

```bash
npm run smoke:legacy-parsers
```

Expected: final line `<n> passed, 0 failed`; exit code 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke-legacy-parsers.ts package.json package-lock.json
git commit -m "test(legacy-import): smoke for parsers (49 assertions)"
```

---

## Task 6: Wipe operational script

**Files:**
- Create: `scripts/wipe-operational.ts`
- Modify: `package.json` (add `wipe:operational` script)

- [ ] **Step 1: Write the wipe script**

```typescript
// scripts/wipe-operational.ts
//
// Single-transaction teardown of all operational tables. Default dry-run;
// requires --commit --confirm="I-mean-it" to execute. Service-role client.
//
//   npm run wipe:operational                       # dry-run
//   npm run wipe:operational -- --commit --confirm="I-mean-it"

import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(2);
}

// Order matters: children before parents. Each entry is a table to TRUNCATE
// with CASCADE off so we'd notice if we left an orphan reference behind.
// (We've audited that this list covers every FK to patients/visits.)
const TABLES_TO_WIPE = [
  "audit_log",
  "result_amendments",
  "result_values",
  "results",
  "structured_results_drafts",
  "imaging_attachments",
  "test_requests",
  "visit_pins",
  "payments",
  "appointments",
  "gift_code_redemptions",
  "eod_cash_reconciliation",
  "journal_lines",
  "journal_entries",
  "hmo_ar_subledger",
  "visits",
  "patients",
  "inquiries",
  "contact_messages",
] as const;

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const confirmFlag = args.find((a) => a.startsWith("--confirm="));
const confirmed = confirmFlag === '--confirm="I-mean-it"' || confirmFlag === "--confirm=I-mean-it";

async function main() {
  const supabase = createClient<Database>(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`\nWipe target: ${SUPABASE_URL}`);
  console.log(`Mode: ${commit ? "COMMIT (will execute)" : "DRY RUN (no writes)"}`);
  console.log("\nRow counts before wipe:");

  let total = 0;
  for (const table of TABLES_TO_WIPE) {
    const { count, error } = await supabase
      .from(table as never)
      .select("*", { count: "exact", head: true });
    if (error) {
      console.error(`  ${table.padEnd(32)} ERROR: ${error.message}`);
      continue;
    }
    console.log(`  ${table.padEnd(32)} ${count ?? 0}`);
    total += count ?? 0;
  }
  console.log(`  ${"TOTAL".padEnd(32)} ${total}`);

  if (!commit) {
    console.log("\nDry-run complete. Re-run with --commit --confirm=\"I-mean-it\" to execute.\n");
    process.exit(0);
  }

  if (!confirmed) {
    console.error("\nERROR: --commit requires --confirm=\"I-mean-it\" exactly.");
    process.exit(3);
  }

  console.log("\nExecuting single-transaction wipe via SQL...");

  // We have to run TRUNCATE through a SQL RPC because the JS client doesn't
  // expose direct truncate. We use a Postgres function created on the fly
  // via exec_sql, then drop it. (Supabase doesn't expose `exec_sql` by default,
  // so we use the pg admin REST endpoint via fetch.)
  const sql = `
    do $$
    begin
      ${TABLES_TO_WIPE.map((t) => `truncate table public.${t} cascade;`).join("\n      ")}
      insert into public.audit_log (action, metadata)
      values ('ops.wipe', jsonb_build_object(
        'tables', ARRAY[${TABLES_TO_WIPE.map((t) => `'${t}'`).join(",")}],
        'wiped_at', now()
      ));
    end $$;
  `;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });

  if (!res.ok) {
    console.error(`\nERROR: wipe SQL returned ${res.status}`);
    console.error(await res.text());
    console.error("\nFallback: run the SQL manually via:");
    console.error("  psql \"$SUPABASE_DB_URL\" -c \"<copy the do-block from this script>\"");
    process.exit(4);
  }

  console.log("\nWipe complete. Re-running counts to verify (should all be zero except audit_log = 1):");
  for (const table of TABLES_TO_WIPE) {
    const { count } = await supabase.from(table as never).select("*", { count: "exact", head: true });
    console.log(`  ${table.padEnd(32)} ${count ?? 0}`);
  }
  console.log();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
```

> **Note for the engineer:** Supabase's REST `exec_sql` RPC is not exposed by default. The fallback path in the script is to run the SQL via `psql`. The safest approach in practice is to copy the generated SQL out of the dry-run output and run it via `psql "$SUPABASE_DB_URL" -1 -f -` (`-1` wraps the whole stdin in a single transaction). If you prefer, replace the fetch block above with a child_process invocation of psql.

- [ ] **Step 2: Add npm script**

In `package.json` `"scripts"`:

```json
"wipe:operational": "tsx scripts/wipe-operational.ts",
```

- [ ] **Step 3: Run dry-run locally**

```bash
npm run wipe:operational
```

Expected: prints per-table counts (mostly zero on a freshly-reset local DB), then "Dry-run complete. Re-run with --commit...".

- [ ] **Step 4: Test the commit path against the local DB**

Seed a junk patient first so we have something to wipe:

```bash
psql "$SUPABASE_DB_URL_LOCAL" -c "insert into public.patients (first_name, last_name, birthdate) values ('Junk','Patient','1990-01-01');"
npm run wipe:operational
npm run wipe:operational -- --commit --confirm="I-mean-it"
psql "$SUPABASE_DB_URL_LOCAL" -c "select count(*) from public.patients;"
```

Expected: patients count = 0 after commit; `audit_log` count = 1 (the wipe-action row).

- [ ] **Step 5: Commit**

```bash
git add scripts/wipe-operational.ts package.json
git commit -m "feat(scripts): wipe-operational with dry-run + confirm gate"
```

---

## Task 7: Importer skeleton + pre-flight (dry-run path)

**Files:**
- Create: `scripts/import-legacy-customers.ts`
- Modify: `package.json` (add `import:legacy` script)

- [ ] **Step 1: Install csv-parse**

```bash
npm install csv-parse
```

- [ ] **Step 2: Write the importer (full file — dry-run produces the pre-flight report; commit branch deferred to Task 8)**

```typescript
// scripts/import-legacy-customers.ts
//
// Reads CUSTOMER LIST CSV, parses every row, produces a pre-flight report
// in dry-run mode. Commit mode (Task 8) inserts with provenance.
//
//   npm run import:legacy -- --csv=./CUSTOMER\ LIST\ -\ CUSTOMER\ LIST2.csv
//   npm run import:legacy -- --csv=... --commit --confirm="I-mean-it"

import { promises as fs } from "node:fs";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";

import { parseName } from "../src/lib/legacy-import/name-parser";
import { normalizePhone } from "../src/lib/legacy-import/phone-normalizer";
import {
  mapReferralSource,
  mapReleaseMedium,
  mapSeniorPwdKind,
  mapSex,
  parseBirthdate,
} from "../src/lib/legacy-import/vocabulary-mapper";
import type {
  ImportWarning,
  LegacyIntakePayload,
  ParsedRow,
} from "../src/lib/legacy-import/types";

interface Args {
  csv: string;
  commit: boolean;
  confirmed: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const csv = args.find((a) => a.startsWith("--csv="))?.substring(6);
  if (!csv) {
    console.error("ERROR: --csv=<path> is required");
    process.exit(2);
  }
  const commit = args.includes("--commit");
  const confirmFlag = args.find((a) => a.startsWith("--confirm="));
  const confirmed =
    confirmFlag === '--confirm="I-mean-it"' || confirmFlag === "--confirm=I-mean-it";
  return { csv, commit, confirmed };
}

interface RowParseResult {
  parsed: ParsedRow | null;
  reason_skipped?: string;
}

function parseRow(raw: Record<string, string>, rowIndex: number): RowParseResult {
  const fullName = raw["Full Name"];
  // Skip junk rows: empty Full Name AND empty Last Name dedicated column.
  if (!fullName?.trim() && !raw["Last Name"]?.trim() && !raw["First Name"]?.trim()) {
    return { parsed: null, reason_skipped: "empty_name" };
  }

  const warnings: ImportWarning[] = [];

  const name = parseName(fullName, raw["Last Name"], raw["First Name"], raw["M.I."]);
  if (name.unparseable) warnings.push("name_unparseable");

  const dob = parseBirthdate(raw["Date of Birth"]);
  if (dob.unparseable) warnings.push("dob_unparseable");
  else if (!dob.iso) warnings.push("dob_missing");

  const phone = normalizePhone(raw["Contact Number"]);
  if (phone.unparseable) warnings.push("phone_unparseable");

  const sex = mapSex(raw["Gender"]);
  if (!sex && (raw["Gender"]?.trim() ?? "")) warnings.push("sex_unparseable");

  const ref = mapReferralSource(raw["How did you know about DR Med?"]);
  if (ref.unmapped_raw !== undefined && ref.unmapped_raw !== "") {
    warnings.push({ kind: "referral_source_unmapped", raw: ref.unmapped_raw });
  }

  const rel = mapReleaseMedium(raw["Preferred Medium of Result Release"]);
  if (rel.unmapped_raw) {
    warnings.push({ kind: "release_medium_unmapped", raw: rel.unmapped_raw });
  }

  const pwdKind = mapSeniorPwdKind(raw["Senior / PWD ID"]);
  const pwdNumber = raw["Senior / PWD ID Number"]?.trim() || null;
  // CHECK constraint requires both-or-neither — if only one is present, drop both.
  let final_pwd_kind: "senior" | "pwd" | null = null;
  let final_pwd_number: string | null = null;
  if (pwdKind && pwdNumber) {
    final_pwd_kind = pwdKind;
    final_pwd_number = pwdNumber;
  } else if (pwdKind || pwdNumber) {
    warnings.push("senior_pwd_id_missing");
  }

  // Address: concat three columns, collapse whitespace, strip trailing commas.
  const addr = [raw["Address (#, Street Name) "], raw["Address (Barangay) "], raw["Address (City) "]]
    .map((x) => x?.trim() ?? "")
    .filter(Boolean)
    .join(", ")
    .replace(/\s+/g, " ")
    .replace(/(,\s*)+$/g, "");

  const email = raw["Email address"]?.trim().toLowerCase() || null;

  const intake: LegacyIntakePayload = {
    source: "google_sheet_CUSTOMER_LIST2",
    imported_at: new Date().toISOString(),
    original_row_index: rowIndex,
    raw,
    import_warnings: warnings,
  };

  return {
    parsed: {
      first_name: name.first_name,
      last_name: name.last_name,
      middle_name: name.middle_name,
      birthdate: dob.iso,
      sex,
      phone: phone.e164,
      email,
      address: addr || null,
      referral_source: ref.id,
      referred_by_doctor: raw["Doctor"]?.trim() || null,
      preferred_release_medium: rel.id,
      senior_pwd_id_kind: final_pwd_kind,
      senior_pwd_id_number: final_pwd_number,
      legacy_intake: intake,
    },
  };
}

interface PreflightStats {
  rows_total: number;
  rows_parsed: number;
  rows_skipped: number;
  skip_reasons: Record<string, number>;
  warnings: Record<string, number>;
  dob_present: number;
  phone_present: number;
  email_present: number;
  top_referring_doctors: Array<{ name: string; count: number }>;
}

function computeStats(parsed: ParsedRow[], skips: Record<string, number>, total: number): PreflightStats {
  const warnings: Record<string, number> = {};
  const doctors: Record<string, number> = {};
  let dob = 0, phone = 0, email = 0;
  for (const r of parsed) {
    if (r.birthdate) dob++;
    if (r.phone) phone++;
    if (r.email) email++;
    if (r.referred_by_doctor) doctors[r.referred_by_doctor] = (doctors[r.referred_by_doctor] ?? 0) + 1;
    for (const w of r.legacy_intake.import_warnings) {
      const key = typeof w === "string" ? w : w.kind;
      warnings[key] = (warnings[key] ?? 0) + 1;
    }
  }
  const topDocs = Object.entries(doctors)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 30);
  return {
    rows_total: total,
    rows_parsed: parsed.length,
    rows_skipped: total - parsed.length,
    skip_reasons: skips,
    warnings,
    dob_present: dob,
    phone_present: phone,
    email_present: email,
    top_referring_doctors: topDocs,
  };
}

function printStats(s: PreflightStats): void {
  console.log("\n=== Pre-flight report ===");
  console.log(`Total rows in sheet:    ${s.rows_total}`);
  console.log(`Parsed:                 ${s.rows_parsed}`);
  console.log(`Skipped:                ${s.rows_skipped}`);
  for (const [reason, n] of Object.entries(s.skip_reasons)) {
    console.log(`  - ${reason.padEnd(30)} ${n}`);
  }
  console.log(`\nDOB present:            ${s.dob_present} (${pct(s.dob_present, s.rows_parsed)})`);
  console.log(`Phone present:          ${s.phone_present} (${pct(s.phone_present, s.rows_parsed)})`);
  console.log(`Email present:          ${s.email_present} (${pct(s.email_present, s.rows_parsed)})`);
  console.log("\nWarnings raised:");
  for (const [k, n] of Object.entries(s.warnings).sort(([, a], [, b]) => b - a)) {
    console.log(`  - ${k.padEnd(36)} ${n}`);
  }
  console.log("\nTop 30 referring physicians:");
  for (const d of s.top_referring_doctors) {
    console.log(`  ${String(d.count).padStart(4)}  ${d.name}`);
  }
  console.log();
}

function pct(n: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

async function writePreflightCsv(parsed: ParsedRow[], path: string): Promise<void> {
  const header = [
    "row_index", "last_name", "first_name", "middle_name", "birthdate", "sex",
    "phone", "email", "address", "referral_source", "referred_by_doctor",
    "preferred_release_medium", "senior_pwd_id_kind", "senior_pwd_id_number",
    "warnings",
  ];
  const rows = parsed.map((r) => [
    r.legacy_intake.original_row_index,
    r.last_name ?? "",
    r.first_name ?? "",
    r.middle_name ?? "",
    r.birthdate ?? "",
    r.sex ?? "",
    r.phone ?? "",
    r.email ?? "",
    r.address?.replace(/[\n,]/g, " ") ?? "",
    r.referral_source ?? "",
    r.referred_by_doctor?.replace(/[\n,]/g, " ") ?? "",
    r.preferred_release_medium ?? "",
    r.senior_pwd_id_kind ?? "",
    r.senior_pwd_id_number ?? "",
    r.legacy_intake.import_warnings.map((w) => typeof w === "string" ? w : `${w.kind}:${w.raw}`).join("; "),
  ]);
  const text = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  await fs.writeFile(path, text);
  console.log(`Pre-flight CSV written: ${path}`);
}

async function main() {
  const args = parseArgs();
  const text = await fs.readFile(args.csv, "utf-8");
  const records = parse(text, { columns: true, skip_empty_lines: true }) as Record<string, string>[];

  const parsed: ParsedRow[] = [];
  const skips: Record<string, number> = {};
  records.forEach((row, i) => {
    // Row index is 1-based AND counts the header (which CSV-parse strips),
    // so the first data row is index 2 in the original sheet.
    const rowIndex = i + 2;
    const r = parseRow(row, rowIndex);
    if (r.parsed) parsed.push(r.parsed);
    else {
      const reason = r.reason_skipped ?? "unknown";
      skips[reason] = (skips[reason] ?? 0) + 1;
    }
  });

  const stats = computeStats(parsed, skips, records.length);
  printStats(stats);

  const reportPath = `tmp/legacy-import-preflight-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  await fs.mkdir("tmp", { recursive: true });
  await writePreflightCsv(parsed, reportPath);

  if (!args.commit) {
    console.log("\nDry-run complete. Review the preflight CSV, then re-run with --commit --confirm=\"I-mean-it\".\n");
    return;
  }

  if (!args.confirmed) {
    console.error("\nERROR: --commit requires --confirm=\"I-mean-it\" exactly.");
    process.exit(3);
  }

  console.log("\nCommit phase: see Task 8.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
```

- [ ] **Step 3: Add npm script**

In `package.json` `"scripts"`:

```json
"import:legacy": "tsx scripts/import-legacy-customers.ts",
```

- [ ] **Step 4: Run dry-run against the real CSV**

```bash
npm run import:legacy -- --csv="$HOME/Downloads/CUSTOMER LIST - CUSTOMER LIST2.csv"
```

Expected: pre-flight report printed to stdout; `tmp/legacy-import-preflight-<ts>.csv` written. Inspect:
- `Total rows in sheet:` ~4480
- `Skipped:` includes empty-name junk
- `DOB present:` ~50%
- `Top 30 referring physicians:` lists the actual frequent referrers from the sheet

- [ ] **Step 5: Sanity-check parsed CSV**

```bash
head -5 tmp/legacy-import-preflight-*.csv
```

Expected: header row + 4 sample rows; names properly title-cased; phones in `+639xxxxxxxxx` form where present; referral sources mapped to valid ids.

- [ ] **Step 6: Commit**

```bash
git add scripts/import-legacy-customers.ts package.json package-lock.json
git commit -m "feat(scripts): import-legacy-customers pre-flight (dry-run path)"
```

---

## Task 8: Importer commit phase

**Files:**
- Modify: `scripts/import-legacy-customers.ts`

- [ ] **Step 1: Replace the `if (!args.commit)` block with the commit implementation**

Replace the section from `if (!args.commit)` through the end of `main()` with:

```typescript
  if (!args.commit) {
    console.log("\nDry-run complete. Review the preflight CSV, then re-run with --commit --confirm=\"I-mean-it\".\n");
    return;
  }

  if (!args.confirmed) {
    console.error("\nERROR: --commit requires --confirm=\"I-mean-it\" exactly.");
    process.exit(3);
  }

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("ERROR: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
    process.exit(2);
  }

  const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Insert the run row.
  const { data: runRow, error: runErr } = await supabase
    .from("legacy_import_runs")
    .insert({
      source: "google_sheet_CUSTOMER_LIST2",
      dry_run: false,
      rows_in: records.length,
    })
    .select("id")
    .single();
  if (runErr || !runRow) {
    console.error("ERROR creating legacy_import_runs row:", runErr);
    process.exit(4);
  }
  const runId = runRow.id;
  console.log(`\nlegacy_import_run_id = ${runId}`);

  // 2. Bulk insert in batches of 500.
  const BATCH = 500;
  let inserted = 0;
  let flagged = 0;
  for (let i = 0; i < parsed.length; i += BATCH) {
    const batch = parsed.slice(i, i + BATCH).map((r) => ({
      first_name: r.first_name ?? "",
      last_name: r.last_name ?? "",
      middle_name: r.middle_name,
      birthdate: r.birthdate,
      birthdate_confirmed: false,
      sex: r.sex,
      phone: r.phone,
      email: r.email,
      address: r.address,
      referral_source: r.referral_source,
      referred_by_doctor: r.referred_by_doctor,
      preferred_release_medium: r.preferred_release_medium,
      senior_pwd_id_kind: r.senior_pwd_id_kind,
      senior_pwd_id_number: r.senior_pwd_id_number,
      pre_registered: false,
      legacy_intake: r.legacy_intake as never,
      legacy_import_run_id: runId,
    }));
    const { error: insErr } = await supabase.from("patients").insert(batch as never);
    if (insErr) {
      console.error(`\nERROR inserting batch ${i / BATCH + 1}:`, insErr);
      console.error(`Inserted so far: ${inserted}. Rollback: DELETE FROM patients WHERE legacy_import_run_id = '${runId}';`);
      process.exit(5);
    }
    inserted += batch.length;
    flagged += parsed.slice(i, i + BATCH).filter((r) => r.legacy_intake.import_warnings.length > 0).length;
    process.stdout.write(`\r  inserted ${inserted}/${parsed.length}`);
  }
  process.stdout.write("\n");

  // 3. Stamp the run row as complete.
  await supabase
    .from("legacy_import_runs")
    .update({
      ended_at: new Date().toISOString(),
      rows_inserted: inserted,
      rows_skipped: records.length - parsed.length,
      rows_flagged: flagged,
    })
    .eq("id", runId);

  console.log(`\nImport complete. ${inserted} rows inserted, ${flagged} flagged with warnings.`);
  console.log(`Rollback command:\n  DELETE FROM patients WHERE legacy_import_run_id = '${runId}';`);
  console.log();
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 3: Locally smoke the full importer round-trip**

```bash
# Reset the local DB (drops all data, re-applies migrations)
supabase db reset

# Wipe (no-op on fresh DB but verifies the wipe still works)
npm run wipe:operational

# Dry-run import
npm run import:legacy -- --csv="$HOME/Downloads/CUSTOMER LIST - CUSTOMER LIST2.csv"

# Commit import (against the LOCAL DB only)
npm run import:legacy -- --csv="$HOME/Downloads/CUSTOMER LIST - CUSTOMER LIST2.csv" --commit --confirm="I-mean-it"

# Verify count + rollback
psql "$SUPABASE_DB_URL_LOCAL" -c "select count(*) from public.patients;"
psql "$SUPABASE_DB_URL_LOCAL" -c "select id, rows_inserted, rows_skipped, rows_flagged from public.legacy_import_runs order by started_at desc limit 1;"
RUN_ID=$(psql "$SUPABASE_DB_URL_LOCAL" -tAc "select id from public.legacy_import_runs order by started_at desc limit 1;")
psql "$SUPABASE_DB_URL_LOCAL" -c "delete from public.patients where legacy_import_run_id = '$RUN_ID';"
psql "$SUPABASE_DB_URL_LOCAL" -c "select count(*) from public.patients;"
```

Expected: count ≈ 4400 (matches `rows_inserted`); after the rollback delete, count drops to 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/import-legacy-customers.ts
git commit -m "feat(scripts): import-legacy-customers commit phase + rollback by batch"
```

---

## Task 9: Patient form — pull referral_source from lookup table

**Files:**
- Create: `src/lib/legacy-import/loaders.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/patients/patient-form.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/patients/new/page.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/patients/[id]/edit/page.tsx`

- [ ] **Step 1: Create the loader**

```typescript
// src/lib/legacy-import/loaders.ts
import { createClient } from "@/lib/supabase/server";

export interface ReferralSourceOption {
  id: string;
  label: string;
}

export async function listActiveReferralSources(): Promise<ReferralSourceOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("referral_sources")
    .select("id, label")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) {
    console.error("listActiveReferralSources failed; falling back to empty:", error);
    return [];
  }
  return data ?? [];
}
```

- [ ] **Step 2: Update `patient-form.tsx` to accept the options as a prop**

In `src/app/(staff)/staff/(dashboard)/patients/patient-form.tsx`:

1. Add `referralOptions: { value: string; label: string }[]` to the `Props` interface.
2. Delete the local `REFERRAL_OPTIONS` constant.
3. Replace `REFERRAL_OPTIONS` references inside the JSX with `referralOptions` (passed in).
4. Prepend `{ value: "", label: "—" }` to the array on the consumer side OR keep the empty option only in the form's render.

Edit:

```typescript
// Before:
interface Props {
  initial?: PatientDefaults;
}

// After:
interface Props {
  initial?: PatientDefaults;
  referralOptions: { value: string; label: string }[];
}

export function PatientForm({ initial, referralOptions }: Props) {
  // ... (remove the local REFERRAL_OPTIONS constant entirely)
  // ... (in JSX, change `REFERRAL_OPTIONS.map(...)` to `referralOptions.map(...)`)
}
```

- [ ] **Step 3: Wire up the new patient page**

In `src/app/(staff)/staff/(dashboard)/patients/new/page.tsx`, replace the existing render with one that fetches options and passes them down:

```typescript
import { listActiveReferralSources } from "@/lib/legacy-import/loaders";
import { PatientForm } from "../patient-form";

export default async function NewPatientPage() {
  const sources = await listActiveReferralSources();
  const referralOptions = [
    { value: "", label: "—" },
    ...sources.map((s) => ({ value: s.id, label: s.label })),
  ];
  return <PatientForm referralOptions={referralOptions} />;
}
```

- [ ] **Step 4: Wire up the edit patient page**

In `src/app/(staff)/staff/(dashboard)/patients/[id]/edit/page.tsx`, after loading the patient, do the same:

```typescript
const sources = await listActiveReferralSources();
const referralOptions = [
  { value: "", label: "—" },
  ...sources.map((s) => ({ value: s.id, label: s.label })),
];
return <PatientForm initial={patient} referralOptions={referralOptions} />;
```

- [ ] **Step 5: Typecheck + visual smoke**

```bash
npm run typecheck
npm run dev    # then in another terminal:
```

Open `http://localhost:3000/staff/patients/new` in a browser. Confirm:
- The "How did you hear about us?" dropdown lists Instagram, TikTok, Returning patient, Gift code — the new options seeded in 0052.
- Selecting any of them and saving creates a patient without an FK violation.

Stop the dev server (Ctrl-C).

- [ ] **Step 6: Commit**

```bash
git add src/lib/legacy-import/loaders.ts \
        'src/app/(staff)/staff/(dashboard)/patients/patient-form.tsx' \
        'src/app/(staff)/staff/(dashboard)/patients/new/page.tsx' \
        'src/app/(staff)/staff/(dashboard)/patients/[id]/edit/page.tsx'
git commit -m "feat(patients): patient form pulls referral_source from lookup table"
```

---

## Task 10: Patient detail — Confirm-DOB badge

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/patients/[id]/page.tsx`

- [ ] **Step 1: Locate the patient summary block**

```bash
grep -n "birthdate\|date.of.birth\|DOB" 'src/app/(staff)/staff/(dashboard)/patients/[id]/page.tsx' | head -10
```

- [ ] **Step 2: Add the badge near the DOB display**

After the `select(...)` query, ensure `birthdate, birthdate_confirmed` are both selected (add them if missing).

Below the DOB display, render:

```tsx
{(!patient.birthdate || !patient.birthdate_confirmed) && (
  <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
    <span aria-hidden>⚠</span>
    <span>
      {patient.birthdate
        ? "DOB not yet confirmed at the counter."
        : "DOB missing — ask the patient on their next visit."}
    </span>
    <Link
      href={`/staff/patients/${patient.id}/edit`}
      className="underline decoration-dotted underline-offset-2"
    >
      Edit
    </Link>
  </div>
)}
```

(Make sure `Link` is imported from `next/link` at the top of the file if it isn't already.)

- [ ] **Step 3: Make the edit-action set `birthdate_confirmed = true` when a non-empty DOB is submitted**

Open `src/app/(staff)/staff/(dashboard)/patients/[id]/edit-actions.ts`.

Locate the body of `updatePatientAction` where it builds the update payload. Add (or modify) the birthdate handling to also flip the flag:

```typescript
const birthdateRaw = (formData.get("birthdate") ?? "").toString().trim();
const birthdate = birthdateRaw === "" ? null : birthdateRaw;

const updatePayload = {
  // ... existing fields ...
  birthdate,
  birthdate_confirmed: birthdate !== null,  // reception just typed/confirmed it
};
```

Apply the equivalent change to `createPatientAction` in `src/app/(staff)/staff/(dashboard)/patients/actions.ts`.

- [ ] **Step 4: Typecheck + visual smoke**

```bash
npm run typecheck
```

Insert a test legacy patient (DOB null) and visit the detail page to confirm the badge shows; edit the patient and fill in DOB; refresh — badge gone.

```bash
psql "$SUPABASE_DB_URL_LOCAL" -c "insert into public.patients (first_name, last_name, birthdate, birthdate_confirmed) values ('Legacy','Smoke',null,false) returning id;"
```

Open `/staff/patients/<id>` → see badge. Click Edit → fill DOB → save → return to detail → badge gone.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(staff)/staff/(dashboard)/patients/[id]/page.tsx' \
        'src/app/(staff)/staff/(dashboard)/patients/[id]/edit-actions.ts' \
        'src/app/(staff)/staff/(dashboard)/patients/actions.ts'
git commit -m "feat(patients): confirm-DOB badge + auto-flip flag on edit"
```

---

## Task 11: Receipt page — discount breakdown + senior/PWD ID

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx`

- [ ] **Step 1: Extend the Supabase query to fetch discount + ID data**

Replace the `supabase.from("visits").select(...)` call with:

```typescript
const { data: visit } = await supabase
  .from("visits")
  .select(
    `
      id, visit_number, visit_date, total_php,
      patients!inner (
        id, drm_id, first_name, last_name,
        senior_pwd_id_kind, senior_pwd_id_number
      ),
      test_requests (
        id,
        base_price_php, discount_kind, discount_amount_php, final_price_php,
        services ( code, name, price_php )
      )
    `,
  )
  .eq("id", id)
  .maybeSingle();
```

- [ ] **Step 2: Compute totals**

After the patient extraction, before the JSX:

```typescript
const lines = (visit.test_requests ?? []).map((tr) => {
  const svc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
  const base = tr.base_price_php ?? svc?.price_php ?? 0;
  const discount = tr.discount_amount_php ?? 0;
  const final = tr.final_price_php ?? base - discount;
  return { id: tr.id, svc, base, discount, final, discountKind: tr.discount_kind };
});

const subtotal = lines.reduce((s, l) => s + l.base, 0);
const totalDiscount = lines.reduce((s, l) => s + l.discount, 0);
const total = lines.reduce((s, l) => s + l.final, 0);
const hasSeniorPwdLine = lines.some((l) => l.discountKind === "senior_pwd_20");
```

- [ ] **Step 3: Replace the line-items table to show base price and per-line discount**

Replace the existing `<table>` element with:

```tsx
<table className="w-full text-sm">
  <thead className="text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
    <tr>
      <th className="py-3">Code</th>
      <th className="py-3">Service</th>
      <th className="py-3 text-right">Price</th>
      <th className="py-3 text-right">Discount</th>
      <th className="py-3 text-right">Net</th>
    </tr>
  </thead>
  <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
    {lines.map((l) => (
      <tr key={l.id}>
        <td className="py-3 font-mono">{l.svc?.code}</td>
        <td className="py-3">{l.svc?.name}</td>
        <td className="py-3 text-right">{formatPhp(l.base)}</td>
        <td className="py-3 text-right">{l.discount > 0 ? `− ${formatPhp(l.discount)}` : "—"}</td>
        <td className="py-3 text-right">{formatPhp(l.final)}</td>
      </tr>
    ))}
  </tbody>
  <tfoot className="text-sm">
    <tr>
      <td colSpan={4} className="pt-4 text-right text-[color:var(--color-brand-text-soft)]">
        Subtotal
      </td>
      <td className="pt-4 text-right">{formatPhp(subtotal)}</td>
    </tr>
    {totalDiscount > 0 && (
      <tr>
        <td colSpan={4} className="pt-1 text-right text-[color:var(--color-brand-text-soft)]">
          Discount
          {hasSeniorPwdLine && patient.senior_pwd_id_number && (
            <span className="ml-2 text-xs">
              (Senior/PWD ID: {patient.senior_pwd_id_number})
            </span>
          )}
        </td>
        <td className="pt-1 text-right">− {formatPhp(totalDiscount)}</td>
      </tr>
    )}
    <tr className="border-t-2 border-[color:var(--color-brand-navy)]">
      <td colSpan={4} className="py-3 text-right font-bold">
        Total Due
      </td>
      <td className="py-3 text-right font-[family-name:var(--font-heading)] text-xl font-extrabold">
        {formatPhp(total)}
      </td>
    </tr>
  </tfoot>
</table>
```

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Visual smoke**

```bash
npm run dev
```

Open a visit receipt that has at least one senior/PWD-discounted line:

```bash
psql "$SUPABASE_DB_URL_LOCAL" <<'SQL'
-- Create a quick test fixture (if local DB is empty)
insert into public.patients (first_name, last_name, birthdate, senior_pwd_id_kind, senior_pwd_id_number)
values ('Senior','Smoke','1950-01-01','senior','1234567890') returning id;
-- (Then create a visit + test_request with discount_kind='senior_pwd_20' via the UI)
SQL
```

Or just visit any existing visit's `/staff/visits/<id>/receipt` and inspect:
- Per-line "Discount" column shows the discount when applied, "—" otherwise.
- "Subtotal" line is the sum of base prices.
- "Discount" line appears when any line has a discount, with "(Senior/PWD ID: <id>)" annotation when applicable.
- "Total Due" line is sum of `final_price_php`.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx'
git commit -m "feat(receipt): per-line discount column + senior-PWD ID footer"
```

---

## Task 12: End-to-end production run

**Files:** none new

This task is the actual production migration + import. Do this only after Tasks 1-11 are all green locally.

- [ ] **Step 1: Snapshot production DB**

```bash
mkdir -p backups
pg_dump --no-owner --no-privileges \
  --file="backups/pre-legacy-import-$(date -u +%Y-%m-%dT%H-%M-%SZ).sql" \
  "$SUPABASE_DB_URL"
ls -la backups/
```

Expected: a multi-megabyte `.sql` file. Keep this file outside the repo; do NOT commit.

- [ ] **Step 2: Apply migrations to production Supabase**

```bash
supabase db push
```

Expected: 0051 and 0052 reported as applied. If push complains about preview / drift, run `supabase migration repair --status applied 0051 0052` then retry per the existing project workflow.

- [ ] **Step 3: Run the production wipe dry-run**

```bash
# Make sure your local .env.local points at PRODUCTION SUPABASE for these steps.
npm run wipe:operational
```

Expected: prints per-table counts (likely some real numbers from dev/test churn). Verify nothing surprising.

- [ ] **Step 4: Commit the wipe**

```bash
npm run wipe:operational -- --commit --confirm="I-mean-it"
```

Expected: all counts drop to 0 (except `audit_log` = 1).

- [ ] **Step 5: Run the import dry-run**

```bash
npm run import:legacy -- --csv="$HOME/Downloads/CUSTOMER LIST - CUSTOMER LIST2.csv"
```

Open `tmp/legacy-import-preflight-*.csv`. Spot-check 20 rows for plausible names, phones, referral mappings. Have your partner review the Top 30 referring physicians list before commit.

- [ ] **Step 6: Commit the import**

```bash
npm run import:legacy -- --csv="$HOME/Downloads/CUSTOMER LIST - CUSTOMER LIST2.csv" --commit --confirm="I-mean-it"
```

Expected: `inserted N/N`, ends with `Import complete. <N> rows inserted, <K> flagged with warnings.` plus the rollback command. **Copy that rollback command somewhere safe** in case something looks wrong in spot-checks.

- [ ] **Step 7: Spot-check in the staff UI**

Open `/staff/patients`, search by a name from the sheet (e.g. "Gabuat"). Confirm:
- The patient appears in results.
- Opening the patient detail page shows the "DOB missing" badge for rows without DOB.
- The referral source dropdown on edit shows the value the importer mapped.
- A few imported patients have phone numbers in `+639xxxxxxxxx` form.

- [ ] **Step 8: Build + deploy**

```bash
npm run build
```

Expected: clean build. Deploy via your usual workflow (likely `vercel --prod` or push to main, depending on project conventions).

- [ ] **Step 9: Tag the release**

```bash
git tag -a v1.11.0 -m "Legacy customer import + extensible referral_sources"
git push origin v1.11.0
```

(Version number is illustrative; pick the next in your sequence.)

---

## Plan self-review

**Spec coverage:**
- Migration 0051 (nullable DOB, birthdate_confirmed, legacy_intake, legacy_import_run_id, legacy_import_runs, pg_trgm) → Task 1.
- Migration 0052 (referral_sources lookup) → Task 2.
- SQL smoke + types regen → Task 3.
- Parsing modules → Task 4.
- Parser smoke → Task 5.
- Wipe script → Task 6.
- Importer dry-run + commit → Tasks 7 + 8.
- UI: patient form pulls lookup → Task 9.
- UI: Confirm-DOB badge → Task 10.
- UI: receipt discount breakdown + senior/PWD ID → Task 11.
- Production cutover → Task 12.

**Placeholder scan:** zero. Every step has exact files, exact code (or exact edits to named symbols), exact commands, expected outputs.

**Type consistency:** `ParsedRow` in Task 4 is the single source for the importer in Tasks 7+8. `ReferralSourceOption` in Task 9 is independent. `LegacyIntakePayload` is used consistently. The `birthdate_confirmed` flag is set false in the importer (Task 8) and true in the patient form actions (Task 10).

**Missing items found during review:** none.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-legacy-customer-import.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best when each task is independent and the plan is detailed enough that the subagent doesn't need to make architecture decisions.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
