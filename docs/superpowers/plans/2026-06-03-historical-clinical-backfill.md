# Historical Clinical Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill the empty clinical operational layer (`visits` / `test_requests` / `payments`) from `DR MED MASTERSHEET.xlsx` (2023-12 → app cutover) as a full operational mirror, consistent with the already-loaded books and GL-silent.

**Architecture:** Standalone TS importers (per the 12.B pattern): a one-time migration adds `legacy_import_run_id`/`legacy_source_ref` provenance to the three operational tables and guards three insert-path triggers so legacy rows skip GL posting and EOD-lock checks. Pure logic (name matching, classification, MOP→method, service mapping, visit-number, HMO) lives in tested modules under `scripts/clinical-backfill/lib/`; a shared commit engine reads each tab, matches patients, groups rows into visits, builds records, and (dry-run → review CSVs → `--commit --confirm`) writes them via the service-role client. `recalc_visit_payment` stays live so `payment_status` computes from inserted payments.

**Tech Stack:** Next.js 16 + Supabase (Postgres 17), TypeScript strict, `tsx` script runner, ExcelJS, vitest, `@supabase/supabase-js` service-role client.

**Spec:** `docs/superpowers/specs/2026-06-03-historical-clinical-backfill-design.md`

---

## File structure

```
supabase/migrations/0091_clinical_backfill_provenance.sql   CREATE  migration: provenance cols + 3 trigger guards + indexes
scripts/smoke-clinical-backfill.sql                         CREATE  GL-silence + lock-bypass smoke assertions
vitest.config.ts                                            MODIFY  include scripts/**/*.test.ts
scripts/clinical-backfill/
  lib/
    types.ts          CREATE  shared interfaces (RawRow, TabConfig, BuiltVisit, ...)
    xlsx.ts           CREATE  cell/date/number helpers + generic tab reader (proven 12.B helpers)
    names.ts          CREATE  TESTED  name normalize + parse + match-key
    names.test.ts     CREATE
    hmo.ts            CREATE  TESTED  HMO provider normalizer (from 12.B)
    hmo.test.ts       CREATE
    classify.ts       CREATE  TESTED  row classification (window / bad-date / zero / postable)
    classify.test.ts  CREATE
    mop-method.ts     CREATE  TESTED  MOP string -> payments.method (8 allowed)
    mop-method.test.ts CREATE
    visit-number.ts   CREATE  TESTED  visit_number builder + collision suffix
    visit-number.test.ts CREATE
    service-map.ts    CREATE  TESTED  service-name -> service_id via catalog index
    service-map.test.ts CREATE
    patient-match.ts  CREATE  TESTED  pure match against a candidate index
    patient-match.test.ts CREATE
  system-user.ts      CREATE  ensure "Legacy Import" auth.users + staff_profiles row (idempotent)
  report.ts           CREATE  CSV writers + dry-run summary
  engine.ts           CREATE  shared read->classify->match->group->build->report/commit engine
  lab.ts              CREATE  entrypoint: LAB SERVICE tab config + main()
  consult.ts          CREATE  entrypoint: DOCTOR CONSULTATION tab config + main()
  validate.sql        CREATE  post-commit validation + books reconciliation
package.json          MODIFY  add backfill:clinical:* npm scripts
```

**Conventions:** TS strict (no `any` without comment). Tests: `describe/it/expect`, factory helpers (mirror `src/lib/appointments/timing.test.ts`). Commits: Conventional Commits. Run a single test file with `npx vitest run scripts/clinical-backfill/lib/names.test.ts`.

---

## Dispatch 1 — Migration: provenance + GL/lock guards

### Task 1: Provenance + guard migration

**Files:**
- Create: `supabase/migrations/0091_clinical_backfill_provenance.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0091_clinical_backfill_provenance.sql
-- Historical clinical backfill provenance + GL-silence.
--
-- Adds legacy_import_run_id / legacy_source_ref to the three operational
-- tables written by the backfill, and short-circuits the three insert-path
-- trigger functions so legacy rows DO NOT post journal entries or get blocked
-- by EOD locks. recalc_visit_payment + maintain_repeat_patient_flag stay live.
--
-- See docs/superpowers/specs/2026-06-03-historical-clinical-backfill-design.md

-- ---- provenance columns ----------------------------------------------------
alter table public.visits
  add column legacy_import_run_id uuid references public.legacy_import_runs(id),
  add column legacy_source_ref text;
alter table public.test_requests
  add column legacy_import_run_id uuid references public.legacy_import_runs(id),
  add column legacy_source_ref text;
alter table public.payments
  add column legacy_import_run_id uuid references public.legacy_import_runs(id),
  add column legacy_source_ref text;

create unique index visits_legacy_source_ref_key
  on public.visits (legacy_source_ref) where legacy_source_ref is not null;
create unique index test_requests_legacy_source_ref_key
  on public.test_requests (legacy_source_ref) where legacy_source_ref is not null;
create unique index payments_legacy_source_ref_key
  on public.payments (legacy_source_ref) where legacy_source_ref is not null;

create index idx_visits_legacy_run on public.visits (legacy_import_run_id)
  where legacy_import_run_id is not null;
create index idx_test_requests_legacy_run on public.test_requests (legacy_import_run_id)
  where legacy_import_run_id is not null;
create index idx_payments_legacy_run on public.payments (legacy_import_run_id)
  where legacy_import_run_id is not null;

-- ---- guard: payment GL bridge ----------------------------------------------
-- Re-create bridge_payment_insert with a legacy short-circuit at the very top.
-- (Body identical to 0030 below the guard.)
create or replace function public.bridge_payment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_hmo         boolean;
  v_cash_id        uuid;
  v_ar_id          uuid;
  v_je_id          uuid;
  v_existing_je    uuid;
  v_suspense_id    uuid;
  v_used_suspense  boolean := false;
begin
  -- Legacy backfill rows are GL-silent (the books already hold this money).
  if NEW.legacy_import_run_id is not null then
    return NEW;
  end if;

  select id into v_existing_je
    from public.journal_entries
    where source_kind = 'payment' and source_id = NEW.id and status = 'posted'
    for update;
  if v_existing_je is not null then
    return NEW;
  end if;

  select (v.hmo_provider_id is not null) into v_is_hmo
    from public.visits v where v.id = NEW.visit_id;

  v_cash_id := public.resolve_cash_account(NEW.method);
  v_ar_id   := public.resolve_ar_account(coalesce(v_is_hmo, false));
  v_suspense_id := public.coa_uuid_for_code('9999');
  v_used_suspense := (v_cash_id = v_suspense_id);

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  ) values (
    NEW.received_at::date, 'Payment received via ' || NEW.method,
    'draft', 'payment', NEW.id, NEW.received_by
  ) returning id into v_je_id;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  values (v_je_id, v_cash_id, NEW.amount_php, 0, 1),
         (v_je_id, v_ar_id,   0, NEW.amount_php, 2);

  update public.journal_entries set status = 'posted' where id = v_je_id;

  if v_used_suspense then
    insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
    values (NEW.received_by, 'staff', 'coa.suspense_post', 'journal_entries', v_je_id,
      jsonb_build_object('source_kind','payment','source_id',NEW.id,
        'reason','no payment_method_account_map row','attempted_lookup',NEW.method));
  end if;

  return NEW;
end;
$$;

-- ---- guard: EOD lock check -------------------------------------------------
create or replace function public.payments_block_after_close()
returns trigger
language plpgsql
as $$
declare
  v_date date;
  v_shift_id uuid;
  v_row public.payments;
begin
  v_row := coalesce(NEW, OLD);
  -- Legacy backfill rows bypass EOD locks (backdated provenance data).
  if v_row.legacy_import_run_id is not null then
    return v_row;
  end if;

  v_date := (coalesce(NEW.received_at, OLD.received_at) at time zone 'Asia/Manila')::date;
  select id into v_shift_id
    from public.cash_shifts where is_active = true
    order by sort_order, code limit 1;
  if v_shift_id is null then
    return v_row;
  end if;
  perform public.eod_lock_check(v_date, v_shift_id);
  return v_row;
end;
$$;

-- ---- guard: test_request release bridge (defensive) ------------------------
-- INSERT-as-released never fires this (it is an UPDATE trigger), but guard so a
-- future UPDATE that re-releases a legacy row stays GL-silent too.
create or replace function public.bridge_test_request_released()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_hmo         boolean;
  v_service_kind   text;
  v_revenue_id     uuid;
  v_discount_id    uuid;
  v_ar_hmo_id      uuid;
  v_ar_patient_id  uuid;
  v_base           numeric(14,2);
  v_discount       numeric(14,2);
  v_final          numeric(14,2);
  v_hmo_approved   numeric(14,2);
  v_patient_share  numeric(14,2);
  v_je_id          uuid;
  v_existing_je    uuid;
  v_line_order     int := 1;
begin
  -- Legacy backfill rows are GL-silent.
  if NEW.legacy_import_run_id is not null then
    return NEW;
  end if;

  select id into v_existing_je
    from public.journal_entries
    where source_kind = 'test_request' and source_id = NEW.id and status = 'posted'
    for update;
  if v_existing_je is not null then return NEW; end if;

  select (v.hmo_provider_id is not null) into v_is_hmo
    from public.visits v where v.id = NEW.visit_id;
  select s.kind into v_service_kind from public.services s where s.id = NEW.service_id;

  v_base          := coalesce(NEW.base_price_php, 0);
  v_discount      := coalesce(NEW.discount_amount_php, 0);
  v_final         := coalesce(NEW.final_price_php, v_base - v_discount);
  v_hmo_approved  := case when v_is_hmo then coalesce(NEW.hmo_approved_amount_php, 0) else 0 end;
  v_patient_share := v_final - v_hmo_approved;

  v_revenue_id    := public.resolve_revenue_account(v_service_kind);
  v_discount_id   := public.resolve_discount_account(v_service_kind);
  v_ar_hmo_id     := public.resolve_ar_account(true);
  v_ar_patient_id := public.resolve_ar_account(false);

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  ) values (
    coalesce(NEW.released_at::date, current_date),
    'Test request released: ' || coalesce(v_service_kind, 'unknown'),
    'draft', 'test_request', NEW.id, NEW.released_by
  ) returning id into v_je_id;

  if v_hmo_approved > 0 then
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_je_id, v_ar_hmo_id, v_hmo_approved, 0, v_line_order);
    v_line_order := v_line_order + 1;
  end if;
  if v_patient_share > 0 then
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_je_id, v_ar_patient_id, v_patient_share, 0, v_line_order);
    v_line_order := v_line_order + 1;
  end if;
  if v_discount > 0 then
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
      values (v_je_id, v_discount_id, v_discount, 0, v_line_order);
    v_line_order := v_line_order + 1;
  end if;
  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    values (v_je_id, v_revenue_id, 0, v_base, v_line_order);

  update public.journal_entries set status = 'posted' where id = v_je_id;
  return NEW;
end;
$$;
```

> NOTE: the two re-created bridge bodies must stay byte-for-byte identical to `0030_op_gl_bridge.sql` apart from the added guard. Open `0030` side-by-side and diff before applying. If `0030` has been superseded by a later migration, base the re-create on the **current** function source (`select pg_get_functiondef(...)`), not on `0030`.

- [ ] **Step 2: Start local Supabase + apply migrations**

Run: `supabase start` then `npm run db:reset`
Expected: all migrations apply through `0091` with no error.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0091_clinical_backfill_provenance.sql
git commit -m "feat(backfill): 0091 provenance cols + GL/lock guards for clinical backfill"
```

### Task 2: GL-silence smoke

**Files:**
- Create: `scripts/smoke-clinical-backfill.sql`

- [ ] **Step 1: Write the smoke SQL**

```sql
-- smoke-clinical-backfill.sql — run against LOCAL supabase only.
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/smoke-clinical-backfill.sql
-- Asserts: legacy payment inserts post NO journal entry and bypass EOD lock,
-- while recalc_visit_payment still computes payment_status; a non-legacy
-- payment still posts exactly one JE.
\set ON_ERROR_STOP on
begin;

-- minimal fixtures
insert into public.legacy_import_runs (source, dry_run) values ('smoke', false)
  returning id \gset run_
-- a patient + a paid-by-cash legacy visit
insert into public.patients (drm_id, first_name, last_name)
  values ('SMOKE-1', 'Smoke', 'Test') returning id \gset pat_
insert into public.visits (patient_id, visit_number, visit_date, payment_status, total_php, paid_php, legacy_import_run_id, legacy_source_ref)
  values (:'pat_id', 'SMOKE-V1', '2024-03-01', 'unpaid', 500, 0, :'run_id', 'SMOKE r1')
  returning id \gset vis_

-- baseline JE count
select count(*) as je_before from public.journal_entries \gset

-- legacy payment: must NOT post a JE, must NOT be blocked, must recalc status
insert into public.payments (visit_id, amount_php, method, received_by, received_at, legacy_import_run_id, legacy_source_ref)
  values (:'vis_id', 500, 'cash',
    (select id from public.staff_profiles order by created_at limit 1),
    '2024-03-01T02:00:00Z', :'run_id', 'SMOKE r1 pay');

select count(*) as je_after_legacy from public.journal_entries \gset
do $$ begin
  if :je_after_legacy <> :je_before then
    raise exception 'FAIL: legacy payment posted % JE(s)', :je_after_legacy - :je_before;
  end if;
end $$;

select payment_status from public.visits where id = :'vis_id' \gset
do $$ begin
  if :'payment_status' <> 'paid' then
    raise exception 'FAIL: recalc did not set payment_status=paid (got %)', :'payment_status';
  end if;
end $$;

-- non-legacy payment on a normal visit: must post exactly one JE
insert into public.visits (patient_id, visit_number, visit_date, payment_status, total_php, paid_php)
  values (:'pat_id', 'SMOKE-V2', current_date, 'unpaid', 100, 0) returning id \gset vis2_
insert into public.payments (visit_id, amount_php, method, received_by, received_at)
  values (:'vis2_id', 100, 'cash',
    (select id from public.staff_profiles order by created_at limit 1), now());
select count(*) as je_after_real from public.journal_entries \gset
do $$ begin
  if :je_after_real <> :je_after_legacy + 1 then
    raise exception 'FAIL: non-legacy payment posted % JE(s), expected 1', :je_after_real - :je_after_legacy;
  end if;
end $$;

\echo 'SMOKE PASS: legacy GL-silent + recalc live + non-legacy posts 1 JE'
rollback;
```

- [ ] **Step 2: Run the smoke**

Run: `docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/smoke-clinical-backfill.sql`
Expected: `SMOKE PASS: legacy GL-silent + recalc live + non-legacy posts 1 JE` and no `FAIL`.

- [ ] **Step 3: Regenerate types + commit**

```bash
npm run db:types
git add scripts/smoke-clinical-backfill.sql src/types/database.ts
git commit -m "test(backfill): GL-silence + recalc smoke; regen types"
```

---

## Dispatch 2 — Pure logic library (TDD)

### Task 3: vitest include for scripts

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Extend the include glob**

Change the `include` line to:

```ts
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
```

- [ ] **Step 2: Verify the suite still runs**

Run: `npm test`
Expected: existing tests pass (no scripts tests yet).

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "chore(test): include scripts/**/*.test.ts in vitest"
```

### Task 4: Shared types

**Files:**
- Create: `scripts/clinical-backfill/lib/types.ts`

- [ ] **Step 1: Write the interfaces**

```ts
// Shared types for the clinical backfill importers.

/** One raw service line read from a master-sheet tab. */
export interface RawRow {
  row_number: number;
  posting_date: string | null; // ISO yyyy-mm-dd
  control_no: string;
  test_no: string;
  patient_name: string;
  hmo_flag: string;
  hmo_provider: string;
  service: string;
  base: number;
  final: number;
  clinic_fee: number; // consult only; 0 for lab
  doctor_pf: number;  // consult only; 0 for lab
  mop: string;
  or_number: string;
  date_paid: string | null;
}

export type Tab = "LAB SERVICE" | "DOCTOR CONSULTATION";

/** Column indices (1-based, ExcelJS) + per-tab build rules. */
export interface TabConfig {
  tab: Tab;
  sheetName: string;
  isConsult: boolean;
  cols: {
    posting_date: number; control_no: number; test_no: number; patient_name: number;
    hmo_flag: number; hmo_provider: number; service: number; base: number; final: number;
    clinic_fee?: number; doctor_pf?: number; mop: number; or_number: number; date_paid: number;
  };
}

export interface MatchedPatient {
  patient_id: string;            // existing or freshly-created
  created: boolean;              // true if we minted a new patient
}

export type RowClass =
  | "postable"
  | "out_of_window"
  | "bad_date"
  | "zero_amount";
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/clinical-backfill/lib/types.ts
git commit -m "feat(backfill): shared types"
```

### Task 5: Name normalize + parse + key (TDD)

**Files:**
- Create: `scripts/clinical-backfill/lib/names.ts`
- Test: `scripts/clinical-backfill/lib/names.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { normalizeName, parseTransactionName, matchKey } from "./names";

describe("normalizeName", () => {
  it("lowercases, strips accents, collapses spaces/punct", () => {
    expect(normalizeName("  Peñā,  José  ")).toBe("pena jose");
    expect(normalizeName("O'Brian-Smith")).toBe("obrian smith");
  });
  it("returns empty string for blank", () => {
    expect(normalizeName("   ")).toBe("");
  });
});

describe("parseTransactionName", () => {
  it("parses 'Last, First Middle'", () => {
    expect(parseTransactionName("Quinto, Lee Angelo")).toEqual({ last: "Quinto", first: "Lee Angelo" });
  });
  it("parses 'First Last' (no comma) as last token = surname", () => {
    expect(parseTransactionName("Lee Angelo Quinto")).toEqual({ last: "Quinto", first: "Lee Angelo" });
  });
  it("handles a single token", () => {
    expect(parseTransactionName("Cher")).toEqual({ last: "Cher", first: "" });
  });
  it("trims surrounding whitespace", () => {
    expect(parseTransactionName("  Gabuat, Princess ")).toEqual({ last: "Gabuat", first: "Princess" });
  });
});

describe("matchKey", () => {
  it("keys on normalized last + first given token only", () => {
    expect(matchKey("Quinto", "Lee Angelo")).toBe("quinto|lee");
    expect(matchKey("Quinto", "Lee")).toBe("quinto|lee");
  });
  it("is empty when last name is blank", () => {
    expect(matchKey("", "Lee")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/clinical-backfill/lib/names.test.ts`
Expected: FAIL — `normalizeName` is not defined.

- [ ] **Step 3: Write the implementation**

```ts
// Name normalization + parsing for patient matching.

/** Lowercase, strip diacritics, drop punctuation, collapse whitespace. */
export function normalizeName(raw: string): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")      // punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a free-text transaction name into {last, first}.
 * Primary format is "Last, First Middle" (the clinic's convention). Without a
 * comma, treat the final whitespace token as the surname.
 */
export function parseTransactionName(raw: string): { last: string; first: string } {
  const s = (raw ?? "").trim();
  if (!s) return { last: "", first: "" };
  if (s.includes(",")) {
    const [last, ...rest] = s.split(",");
    return { last: last.trim(), first: rest.join(",").trim() };
  }
  const tokens = s.split(/\s+/);
  if (tokens.length === 1) return { last: tokens[0], first: "" };
  const last = tokens[tokens.length - 1];
  const first = tokens.slice(0, -1).join(" ");
  return { last, first };
}

/** Stable match key: normalized surname + first given token. */
export function matchKey(last: string, first: string): string {
  const nl = normalizeName(last);
  if (!nl) return "";
  const nf = normalizeName(first).split(" ")[0] ?? "";
  return `${nl}|${nf}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/clinical-backfill/lib/names.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add scripts/clinical-backfill/lib/names.ts scripts/clinical-backfill/lib/names.test.ts
git commit -m "feat(backfill): name normalize/parse/matchKey (tested)"
```

### Task 6: HMO provider normalizer (TDD)

**Files:**
- Create: `scripts/clinical-backfill/lib/hmo.ts`
- Test: `scripts/clinical-backfill/lib/hmo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { normaliseHmoProvider, isHmoRow } from "./hmo";

describe("normaliseHmoProvider", () => {
  it("canonicalises known providers", () => {
    expect(normaliseHmoProvider("maxicare")).toBe("Maxicare");
    expect(normaliseHmoProvider("MED ASIA")).toBe("Med Asia");
    expect(normaliseHmoProvider("icare")).toBe("iCare");
  });
  it("title-cases unknowns and handles blank", () => {
    expect(normaliseHmoProvider("some new hmo")).toBe("Some New Hmo");
    expect(normaliseHmoProvider("")).toBe("(unknown HMO)");
  });
});

describe("isHmoRow", () => {
  it("is true when flag says yes, provider present, or mop is HMO", () => {
    expect(isHmoRow({ hmo_flag: "YES", hmo_provider: "", mop: "" })).toBe(true);
    expect(isHmoRow({ hmo_flag: "", hmo_provider: "Maxicare", mop: "" })).toBe(true);
    expect(isHmoRow({ hmo_flag: "", hmo_provider: "", mop: "HMO" })).toBe(true);
    expect(isHmoRow({ hmo_flag: "no", hmo_provider: "", mop: "CASH" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/clinical-backfill/lib/hmo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// HMO provider normalization (mirrors scripts/history-import/* 12.B logic).

function titleCase(s: string): string {
  return s.toLowerCase().split(/(\s+)/)
    .map((w) => (w.match(/^\s+$/) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");
}

export function normaliseHmoProvider(raw: string): string {
  const t = (raw ?? "").trim();
  if (!t) return "(unknown HMO)";
  const lower = t.toLowerCase();
  const map: Record<string, string> = {
    maxicare: "Maxicare", intellicare: "Intellicare", etiqa: "Etiqa",
    cocolife: "Cocolife", avega: "Avega", valucare: "Valucare", icare: "iCare",
    generali: "Generali", amaphil: "Amaphil", "med asia": "Med Asia", medasia: "Med Asia",
  };
  return map[lower] ?? titleCase(t);
}

export function isHmoRow(r: { hmo_flag: string; hmo_provider: string; mop: string }): boolean {
  return (
    r.hmo_flag.trim().toUpperCase().includes("YES") ||
    !!r.hmo_provider.trim() ||
    r.mop.trim().toUpperCase() === "HMO"
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/clinical-backfill/lib/hmo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clinical-backfill/lib/hmo.ts scripts/clinical-backfill/lib/hmo.test.ts
git commit -m "feat(backfill): HMO provider normalizer (tested)"
```

### Task 7: Row classification (TDD)

**Files:**
- Create: `scripts/clinical-backfill/lib/classify.ts`
- Test: `scripts/clinical-backfill/lib/classify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { classifyRow } from "./classify";
import type { RawRow } from "./types";

function row(over: Partial<RawRow> = {}): RawRow {
  return {
    row_number: 10, posting_date: "2024-05-01", control_no: "C1", test_no: "T1",
    patient_name: "Doe, Jane", hmo_flag: "", hmo_provider: "", service: "CBC",
    base: 300, final: 300, clinic_fee: 0, doctor_pf: 0, mop: "CASH",
    or_number: "", date_paid: null, ...over,
  };
}
const WIN = { start: "2023-12-01", cutoverExclusive: "2026-05-26" };

describe("classifyRow", () => {
  it("postable inside the window with a positive amount", () => {
    expect(classifyRow(row(), WIN, false)).toBe("postable");
  });
  it("bad_date when posting_date is null", () => {
    expect(classifyRow(row({ posting_date: null }), WIN, false)).toBe("bad_date");
  });
  it("out_of_window before start or on/after cutover", () => {
    expect(classifyRow(row({ posting_date: "2023-11-30" }), WIN, false)).toBe("out_of_window");
    expect(classifyRow(row({ posting_date: "2026-05-26" }), WIN, false)).toBe("out_of_window");
  });
  it("zero_amount for a lab row with final<=0 and base<=0", () => {
    expect(classifyRow(row({ base: 0, final: 0 }), WIN, false)).toBe("zero_amount");
  });
  it("consult zero_amount keys on clinic_fee (the clinic's revenue)", () => {
    expect(classifyRow(row({ clinic_fee: 0, base: 500, final: 500 }), WIN, true)).toBe("zero_amount");
    expect(classifyRow(row({ clinic_fee: 200 }), WIN, true)).toBe("postable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/clinical-backfill/lib/classify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import type { RawRow, RowClass } from "./types";

export interface Window { start: string; cutoverExclusive: string; }

/**
 * Classify a row for the backfill. `isConsult` switches the "has the clinic
 * any revenue?" test to clinic_fee (consults pass PF through to the doctor).
 */
export function classifyRow(r: RawRow, win: Window, isConsult: boolean): RowClass {
  if (!r.posting_date) return "bad_date";
  if (r.posting_date < win.start || r.posting_date >= win.cutoverExclusive) {
    return "out_of_window";
  }
  if (isConsult) {
    return r.clinic_fee > 0 ? "postable" : "zero_amount";
  }
  return r.final > 0 || r.base > 0 ? "postable" : "zero_amount";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/clinical-backfill/lib/classify.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clinical-backfill/lib/classify.ts scripts/clinical-backfill/lib/classify.test.ts
git commit -m "feat(backfill): row classification (tested)"
```

### Task 8: MOP → payments.method (TDD)

**Files:**
- Create: `scripts/clinical-backfill/lib/mop-method.ts`
- Test: `scripts/clinical-backfill/lib/mop-method.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mopToMethod } from "./mop-method";

describe("mopToMethod", () => {
  it("maps known MOPs to allowed payments.method values", () => {
    expect(mopToMethod("GCASH")).toBe("gcash");
    expect(mopToMethod("CASH")).toBe("cash");
    expect(mopToMethod("CARD PAY")).toBe("card");
    expect(mopToMethod("BPI")).toBe("bpi");
    expect(mopToMethod("BDO")).toBe("bank_transfer");  // no 'bdo' method exists
    expect(mopToMethod("CHEQUE")).toBe("bank_transfer");
    expect(mopToMethod("MAYA")).toBe("maya");
    expect(mopToMethod("HMO")).toBe("hmo");
  });
  it("defaults blank/unknown to cash", () => {
    expect(mopToMethod("")).toBe("cash");
    expect(mopToMethod("OK")).toBe("cash");
    expect(mopToMethod("PRE EMPLOYMENT")).toBe("cash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/clinical-backfill/lib/mop-method.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// Map a master-sheet MOP string to an allowed payments.method value.
// Allowed: cash | gcash | maya | card | bank_transfer | hmo | bpi | maybank.
export type PaymentMethod =
  | "cash" | "gcash" | "maya" | "card" | "bank_transfer" | "hmo" | "bpi" | "maybank";

export function mopToMethod(mop: string): PaymentMethod {
  const m = (mop ?? "").trim().toUpperCase();
  switch (m) {
    case "GCASH": return "gcash";
    case "MAYA": return "maya";
    case "CARD PAY":
    case "CARD": return "card";
    case "BPI": return "bpi";
    case "BDO":            // no dedicated BDO method
    case "BANK":
    case "BANK TRANSFER":
    case "CHEQUE":
    case "CHECK": return "bank_transfer";
    case "HMO": return "hmo";
    default: return "cash"; // CASH, blank, OK, PRE EMPLOYMENT, exec bundles, etc.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/clinical-backfill/lib/mop-method.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clinical-backfill/lib/mop-method.ts scripts/clinical-backfill/lib/mop-method.test.ts
git commit -m "feat(backfill): MOP->payments.method map (tested)"
```

### Task 9: visit_number builder (TDD)

**Files:**
- Create: `scripts/clinical-backfill/lib/visit-number.ts`
- Test: `scripts/clinical-backfill/lib/visit-number.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildVisitNumber } from "./visit-number";

describe("buildVisitNumber", () => {
  it("prefixes the control number", () => {
    const used = new Set<string>();
    expect(buildVisitNumber("LAB SERVICE", "12345", 7, used)).toBe("H-12345");
  });
  it("synthesizes when control_no is blank", () => {
    const used = new Set<string>();
    expect(buildVisitNumber("DOCTOR CONSULTATION", "", 42, used)).toBe("H-DOCTOR CONSULTATION-42".replace(/\s+/g, "_"));
  });
  it("suffixes on collision and records each issued number", () => {
    const used = new Set<string>(["H-12345"]);
    expect(buildVisitNumber("LAB SERVICE", "12345", 7, used)).toBe("H-12345-2");
    expect(used.has("H-12345-2")).toBe(true);
    // next collision bumps again
    expect(buildVisitNumber("LAB SERVICE", "12345", 8, used)).toBe("H-12345-3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/clinical-backfill/lib/visit-number.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import type { Tab } from "./types";

/**
 * Build a unique legacy visit_number. Base is `H-<control_no>`; when control_no
 * is blank we synthesize `H-<tab>-<rowNumber>` (spaces -> underscore). On
 * collision against `used` we append `-2`, `-3`, ... The issued number is added
 * to `used` so subsequent calls stay unique within the run.
 */
export function buildVisitNumber(tab: Tab, controlNo: string, rowNumber: number, used: Set<string>): string {
  const c = (controlNo ?? "").trim();
  const base = c ? `H-${c}` : `H-${tab}-${rowNumber}`.replace(/\s+/g, "_");
  let candidate = base;
  let n = 1;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  used.add(candidate);
  return candidate;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/clinical-backfill/lib/visit-number.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clinical-backfill/lib/visit-number.ts scripts/clinical-backfill/lib/visit-number.test.ts
git commit -m "feat(backfill): unique visit_number builder (tested)"
```

### Task 10: Service mapping (TDD)

**Files:**
- Create: `scripts/clinical-backfill/lib/service-map.ts`
- Test: `scripts/clinical-backfill/lib/service-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildServiceIndex, mapService, type CatalogService } from "./service-map";

const catalog: CatalogService[] = [
  { id: "lab-cbc", code: "CBC", name: "Complete Blood Count", kind: "lab_test", is_active: true },
  { id: "lab-fbs", code: "FBS", name: "Fasting Blood Sugar", kind: "lab_test", is_active: true },
  { id: "consult", code: "CONSULT", name: "Consultation", kind: "doctor_consultation", is_active: true },
];
const idx = buildServiceIndex(catalog);

describe("mapService", () => {
  it("consult rows always resolve to the CONSULT anchor", () => {
    expect(mapService("Pedia consult", true, idx)).toEqual({ service_id: "consult", matched: true });
  });
  it("lab rows match by normalized name", () => {
    expect(mapService("complete blood count", false, idx)).toEqual({ service_id: "lab-cbc", matched: true });
  });
  it("lab rows match by code", () => {
    expect(mapService("CBC", false, idx)).toEqual({ service_id: "lab-cbc", matched: true });
  });
  it("unmatched lab falls back to the generic legacy service", () => {
    expect(mapService("Some weird sendout", false, idx)).toEqual({ service_id: idx.legacyLabId, matched: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/clinical-backfill/lib/service-map.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { normalizeName } from "./names";

export interface CatalogService {
  id: string; code: string; name: string; kind: string; is_active: boolean;
}

export interface ServiceIndex {
  byName: Map<string, string>; // normalized name/code -> service_id
  consultId: string;           // CONSULT anchor
  legacyLabId: string;         // generic "Legacy lab test" service
}

/** Build the lookup index. `consultId`/`legacyLabId` are resolved by caller. */
export function buildServiceIndex(
  catalog: CatalogService[], consultId = "", legacyLabId = "",
): ServiceIndex {
  const byName = new Map<string, string>();
  for (const s of catalog) {
    const nName = normalizeName(s.name);
    const nCode = normalizeName(s.code);
    if (nName && !byName.has(nName)) byName.set(nName, s.id);
    if (nCode && !byName.has(nCode)) byName.set(nCode, s.id);
    if (s.code === "CONSULT") consultId = s.id;
  }
  return { byName, consultId, legacyLabId };
}

/** Resolve a sheet service string to a service_id. */
export function mapService(
  serviceText: string, isConsult: boolean, idx: ServiceIndex,
): { service_id: string; matched: boolean } {
  if (isConsult) return { service_id: idx.consultId, matched: true };
  const key = normalizeName(serviceText);
  const hit = key ? idx.byName.get(key) : undefined;
  if (hit) return { service_id: hit, matched: true };
  return { service_id: idx.legacyLabId, matched: false };
}
```

> The caller resolves `idx.consultId` (services WHERE code='CONSULT') and `idx.legacyLabId` (upsert a `services` row code='LEGACY-LAB', kind='lab_test', price 0, is_active=false) before building objects. `buildServiceIndex` also sets `consultId` if the catalog includes CONSULT.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/clinical-backfill/lib/service-map.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/clinical-backfill/lib/service-map.ts scripts/clinical-backfill/lib/service-map.test.ts
git commit -m "feat(backfill): service-name->service_id mapping (tested)"
```

### Task 11: Pure patient matcher (TDD)

**Files:**
- Create: `scripts/clinical-backfill/lib/patient-match.ts`
- Test: `scripts/clinical-backfill/lib/patient-match.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildPatientIndex, matchPatient, type PatientRow } from "./patient-match";

const patients: PatientRow[] = [
  { id: "p1", last_name: "Quinto", first_name: "Lee Angelo", sex: "male" },
  { id: "p2", last_name: "Dayego", first_name: "John Angelo", sex: "male" },
  { id: "p3", last_name: "Dayego", first_name: "John Patrick", sex: "male" }, // collision on key dayego|john
];
const idx = buildPatientIndex(patients);

describe("matchPatient", () => {
  it("unique match links", () => {
    expect(matchPatient("Quinto, Lee Angelo", "", idx)).toEqual({ kind: "match", patient_id: "p1" });
  });
  it("no candidate -> none", () => {
    expect(matchPatient("Cruz, Maria", "", idx)).toEqual({ kind: "none" });
  });
  it("multiple candidates on the same key -> ambiguous (never auto-pick)", () => {
    const r = matchPatient("Dayego, John", "", idx);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates.sort()).toEqual(["p2", "p3"]);
  });
  it("blank/unparseable name -> none", () => {
    expect(matchPatient("   ", "", idx)).toEqual({ kind: "none" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/clinical-backfill/lib/patient-match.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { parseTransactionName, matchKey } from "./names";

export interface PatientRow {
  id: string; last_name: string | null; first_name: string | null; sex?: string | null;
}

export type PatientIndex = Map<string, string[]>; // matchKey -> patient ids

export function buildPatientIndex(rows: PatientRow[]): PatientIndex {
  const idx: PatientIndex = new Map();
  for (const p of rows) {
    const k = matchKey(p.last_name ?? "", p.first_name ?? "");
    if (!k) continue;
    const arr = idx.get(k);
    if (arr) { if (!arr.includes(p.id)) arr.push(p.id); }
    else idx.set(k, [p.id]);
  }
  return idx;
}

export type MatchResult =
  | { kind: "match"; patient_id: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

/** Pure match of a transaction name against the index. Gender unused for now
 *  (kept in the signature so a future tiebreak doesn't churn callers). */
export function matchPatient(patientName: string, _sex: string, idx: PatientIndex): MatchResult {
  const { last, first } = parseTransactionName(patientName);
  const k = matchKey(last, first);
  if (!k) return { kind: "none" };
  const cands = idx.get(k);
  if (!cands || cands.length === 0) return { kind: "none" };
  if (cands.length === 1) return { kind: "match", patient_id: cands[0] };
  return { kind: "ambiguous", candidates: [...cands] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/clinical-backfill/lib/patient-match.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite + commit**

Run: `npm test`
Expected: all pure-logic tests green.

```bash
git add scripts/clinical-backfill/lib/patient-match.ts scripts/clinical-backfill/lib/patient-match.test.ts
git commit -m "feat(backfill): pure patient matcher (tested)"
```

### Task 12: XLSX reader

**Files:**
- Create: `scripts/clinical-backfill/lib/xlsx.ts`

- [ ] **Step 1: Write the reader (proven 12.B helpers + generic tab loader)**

```ts
import ExcelJS from "exceljs";
import type { RawRow, TabConfig } from "./types";

function excelSerialToISO(serial: number): string {
  const base = Date.UTC(1899, 11, 30);
  return new Date(base + serial * 86400 * 1000).toISOString().slice(0, 10);
}
export function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  if (v instanceof Date) { const t = v.getTime(); return Number.isNaN(t) ? "" : v.toISOString().slice(0, 10); }
  if (typeof v === "object" && "richText" in v && Array.isArray(v.richText)) {
    return v.richText.map((r) => r.text ?? "").join("");
  }
  if (typeof v === "object" && "text" in v) return String((v as { text: unknown }).text);
  if (typeof v === "object" && "result" in v) return cellText((v as { result: ExcelJS.CellValue }).result);
  return String(v);
}
export function parseDate(raw: ExcelJS.CellValue): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") return excelSerialToISO(raw);
  if (raw instanceof Date) { const t = raw.getTime(); return Number.isNaN(t) ? null : raw.toISOString().slice(0, 10); }
  const s = cellText(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToISO(Number(s));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return null;
}
export function fnum(raw: ExcelJS.CellValue): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return raw;
  const s = cellText(raw).trim();
  if (!s || s.toUpperCase() === "N/A" || s.toUpperCase() === "NA") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export async function loadTab(xlsxPath: string, cfg: TabConfig): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet(cfg.sheetName);
  if (!ws) throw new Error(`${cfg.sheetName} sheet not found in ${xlsxPath}`);
  const c = cfg.cols;
  const out: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= 2) return;                       // row 1/2 are headers
    const a = row.getCell(c.posting_date).value;
    if (a == null || a === "") return;
    out.push({
      row_number: rn,
      posting_date: parseDate(a),
      control_no: cellText(row.getCell(c.control_no).value).trim(),
      test_no: cellText(row.getCell(c.test_no).value).trim(),
      patient_name: cellText(row.getCell(c.patient_name).value).trim(),
      hmo_flag: cellText(row.getCell(c.hmo_flag).value).trim(),
      hmo_provider: cellText(row.getCell(c.hmo_provider).value).trim(),
      service: cellText(row.getCell(c.service).value).trim(),
      base: fnum(row.getCell(c.base).value),
      final: fnum(row.getCell(c.final).value),
      clinic_fee: c.clinic_fee ? fnum(row.getCell(c.clinic_fee).value) : 0,
      doctor_pf: c.doctor_pf ? fnum(row.getCell(c.doctor_pf).value) : 0,
      mop: cellText(row.getCell(c.mop).value).trim(),
      or_number: cellText(row.getCell(c.or_number).value).trim(),
      date_paid: parseDate(row.getCell(c.date_paid).value),
    });
  });
  return out;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/clinical-backfill/lib/xlsx.ts
git commit -m "feat(backfill): xlsx tab reader (12.B helpers)"
```

---

## Dispatch 3 — System user, report, dry-run engine

### Task 13: System user setup

**Files:**
- Create: `scripts/clinical-backfill/system-user.ts`

- [ ] **Step 1: Write the idempotent ensure-system-user helper**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";

const SYSTEM_EMAIL = "legacy-import@system.drmed.ph";
const SYSTEM_NAME = "Legacy Import (system)";

/**
 * Ensure a dedicated inactive "Legacy Import" staff member exists and return
 * its uuid. staff_profiles.id FKs auth.users(id), so we create the auth user
 * first (reusing the create-local-admin pattern), then the profile row.
 * Idempotent: re-runs return the existing id.
 */
export async function ensureSystemUser(admin: SupabaseClient<Database>): Promise<string> {
  // 1. existing profile?
  const { data: existing } = await admin
    .from("staff_profiles").select("id").eq("full_name", SYSTEM_NAME).maybeSingle();
  if (existing?.id) return existing.id;

  // 2. find or create the auth user
  let userId: string | undefined;
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  userId = list?.users.find((u) => u.email === SYSTEM_EMAIL)?.id;
  if (!userId) {
    const { data: created, error } = await admin.auth.admin.createUser({
      email: SYSTEM_EMAIL, email_confirm: true,
      password: crypto.randomUUID() + "Aa1!",  // never used; system account
    });
    if (error || !created?.user) throw new Error(`createUser failed: ${error?.message}`);
    userId = created.user.id;
  }

  // 3. profile row (role admin, inactive — it never logs in)
  const { error: pErr } = await admin.from("staff_profiles").insert({
    id: userId, full_name: SYSTEM_NAME, role: "admin", is_active: false,
  });
  if (pErr) throw new Error(`staff_profiles insert failed: ${pErr.message}`);
  return userId;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/clinical-backfill/system-user.ts
git commit -m "feat(backfill): ensure Legacy Import system staff user"
```

### Task 14: Report writers

**Files:**
- Create: `scripts/clinical-backfill/report.ts`

- [ ] **Step 1: Write the CSV/summary helpers**

```ts
import { promises as fs } from "node:fs";
import path from "node:path";

function csvEscape(c: string): string { return `"${(c ?? "").replace(/"/g, '""')}"`; }

/** Write a CSV under tmp/ with a timestamped name; returns the path. */
export async function writeCsv(name: string, header: string[], rows: string[][]): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.resolve("tmp");
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${name}-${ts}.csv`);
  const text = [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  await fs.writeFile(out, text);
  return out;
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add scripts/clinical-backfill/report.ts
git commit -m "feat(backfill): CSV report writer"
```

### Task 15: The engine (read → classify → match → group → build → report/commit)

**Files:**
- Create: `scripts/clinical-backfill/engine.ts`

- [ ] **Step 1: Write the engine**

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database";
import { requireLocalOrExplicitProd } from "../lib/env-guard";
import type { RawRow, TabConfig } from "./lib/types";
import { loadTab } from "./lib/xlsx";
import { classifyRow, type Window } from "./lib/classify";
import { isHmoRow, normaliseHmoProvider } from "./lib/hmo";
import { mopToMethod } from "./lib/mop-method";
import { buildVisitNumber } from "./lib/visit-number";
import { buildServiceIndex, mapService, type CatalogService } from "./lib/service-map";
import { buildPatientIndex, matchPatient, type PatientRow } from "./lib/patient-match";
import { parseTransactionName } from "./lib/names";
import { ensureSystemUser } from "./system-user";
import { writeCsv } from "./report";

const round2 = (n: number) => Math.round(n * 100) / 100;
const WINDOW: Window = { start: "2023-12-01", cutoverExclusive: "2026-05-26" };

interface Args { xlsx: string; commit: boolean; confirmed: boolean; }
export function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const xlsx = argv.find((a) => a.startsWith("--xlsx="))?.substring(7)
    ?? `${process.env.HOME ?? ""}/Downloads/DR MED MASTERSHEET.xlsx`;
  return {
    xlsx,
    commit: argv.includes("--commit"),
    confirmed: argv.includes('--confirm="I-mean-it"') || argv.includes("--confirm=I-mean-it"),
  };
}

function adminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required."); process.exit(2); }
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Fetch all rows of a table in pages of 1000 (PostgREST cap).
async function fetchAll<T>(q: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []; let from = 0; const page = 1000;
  for (;;) {
    const batch = await q(from, from + page - 1);
    out.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  return out;
}

interface BuiltLine { row: RawRow; service_id: string; serviceMatched: boolean; }
interface BuiltVisit {
  key: string; patient_id: string; created_patient: boolean;
  visit_date: string; control_no: string; hmo_provider_id: string | null;
  lines: BuiltLine[]; collected: number; method: string; received_at: string; or_number: string;
  total: number;
}

export async function run(cfg: TabConfig): Promise<void> {
  const args = parseArgs();
  console.log(`Reading ${cfg.sheetName} from ${args.xlsx}`);
  const rows = await loadTab(args.xlsx, cfg);
  console.log(`  ${rows.length} rows read`);

  const admin = adminClient();

  // catalogs
  const patientsRaw = await fetchAll<PatientRow>(async (lo, hi) => {
    const { data, error } = await admin.from("patients")
      .select("id,last_name,first_name,sex").is("merged_into_id", null).range(lo, hi);
    if (error) throw new Error(error.message); return (data ?? []) as PatientRow[];
  });
  const patientIndex = buildPatientIndex(patientsRaw);

  const services = await fetchAll<CatalogService>(async (lo, hi) => {
    const { data, error } = await admin.from("services").select("id,code,name,kind,is_active").range(lo, hi);
    if (error) throw new Error(error.message); return (data ?? []) as CatalogService[];
  });
  // resolve generic legacy-lab + consult anchors (commit mode upserts legacy lab)
  const consultId = services.find((s) => s.code === "CONSULT")?.id ?? "";
  let legacyLabId = services.find((s) => s.code === "LEGACY-LAB")?.id ?? "";
  const hmoProviders = await fetchAll<{ id: string; name: string }>(async (lo, hi) => {
    const { data, error } = await admin.from("hmo_providers").select("id,name").range(lo, hi);
    if (error) throw new Error(error.message); return (data ?? []) as { id: string; name: string }[];
  });
  const hmoByName = new Map(hmoProviders.map((p) => [p.name.toLowerCase(), p.id]));

  // classify + match + group
  const visits = new Map<string, BuiltVisit>();
  const ambiguous: string[][] = [];
  const newPatients = new Map<string, { last: string; first: string; sex: string; sample: RawRow }>();
  const unmappedServices = new Map<string, number>();
  const exclusions: string[][] = [];
  const svcIndex = buildServiceIndex(services, consultId, legacyLabId);

  for (const r of rows) {
    const klass = classifyRow(r, WINDOW, cfg.isConsult);
    if (klass !== "postable") {
      exclusions.push([String(r.row_number), r.posting_date ?? "(none)", klass, r.patient_name, r.service,
        r.base.toFixed(2), r.final.toFixed(2), r.mop]);
      continue;
    }
    // patient
    const m = matchPatient(r.patient_name, "", patientIndex);
    let patient_id: string; let created_patient = false;
    if (m.kind === "match") { patient_id = m.patient_id; }
    else if (m.kind === "ambiguous") {
      ambiguous.push([String(r.row_number), r.patient_name, m.candidates.join("|"), r.posting_date ?? ""]);
      continue; // held — not committed in the auto pass
    } else {
      // new patient (dedup within run by matchKey)
      const { last, first } = parseTransactionName(r.patient_name);
      const nk = `${last}|${first}`.toLowerCase();
      if (!nk.trim() || nk === "|") {
        exclusions.push([String(r.row_number), r.posting_date ?? "", "unparseable_name", r.patient_name, r.service, "", "", ""]);
        continue;
      }
      if (!newPatients.has(nk)) newPatients.set(nk, { last, first, sex: "", sample: r });
      patient_id = `NEW:${nk}`; created_patient = true; // placeholder, resolved at commit
    }
    // service
    const sm = mapService(r.service, cfg.isConsult, svcIndex);
    if (!sm.matched) unmappedServices.set(r.service, (unmappedServices.get(r.service) ?? 0) + 1);

    // group key: tab+control_no, fallback patient+date
    const gkey = r.control_no ? `${cfg.tab}|${r.control_no}` : `${cfg.tab}|${patient_id}|${r.posting_date}`;
    let v = visits.get(gkey);
    if (!v) {
      const hmoId = isHmoRow(r) ? (hmoByName.get(normaliseHmoProvider(r.hmo_provider).toLowerCase()) ?? null) : null;
      v = {
        key: gkey, patient_id, created_patient, visit_date: r.posting_date!, control_no: r.control_no,
        hmo_provider_id: hmoId, lines: [], collected: 0, method: mopToMethod(r.mop),
        received_at: r.date_paid ?? r.posting_date!, or_number: r.or_number, total: 0,
      };
      visits.set(gkey, v);
    }
    v.lines.push({ row: r, service_id: sm.service_id, serviceMatched: sm.matched });
    const final = round2(cfg.isConsult ? r.clinic_fee : (r.final > 0 ? r.final : r.base));
    v.total = round2(v.total + final);
    // collected: cash-style only (HMO patient copay unknown -> 0). Non-HMO pays final.
    if (!isHmoRow(r)) v.collected = round2(v.collected + final);
  }

  // summary
  const visitArr = [...visits.values()];
  console.log(`\n=== ${cfg.sheetName} dry-run ===`);
  console.log(`Postable visits:     ${visitArr.length}`);
  console.log(`  test_request lines: ${visitArr.reduce((s, v) => s + v.lines.length, 0)}`);
  console.log(`  new patients:       ${newPatients.size}`);
  console.log(`  ambiguous (held):   ${ambiguous.length}`);
  console.log(`  unmapped services:  ${unmappedServices.size}`);
  console.log(`  excluded rows:      ${exclusions.length}`);

  const csvs = await Promise.all([
    writeCsv(`clinical-${cfg.tab}-ambiguous`, ["row","name","candidates","date"], ambiguous),
    writeCsv(`clinical-${cfg.tab}-new-patients`, ["key","last","first"], [...newPatients.entries()].map(([k, p]) => [k, p.last, p.first])),
    writeCsv(`clinical-${cfg.tab}-unmapped-services`, ["service","count"], [...unmappedServices.entries()].sort((a,b)=>b[1]-a[1]).map(([s,n]) => [s, String(n)])),
    writeCsv(`clinical-${cfg.tab}-exclusions`, ["row","date","class","name","service","base","final","mop"], exclusions),
  ]);
  console.log(`\nCSVs:\n  ${csvs.join("\n  ")}`);

  if (!args.commit) {
    console.log(`\nDry-run. To commit (dev): npm run ${cfg.isConsult ? "backfill:clinical:consult" : "backfill:clinical:lab"} -- --commit --confirm="I-mean-it"\n`);
    return;
  }
  if (!args.confirmed) { console.error('\n--commit requires --confirm="I-mean-it".'); process.exit(3); }
  await commit(cfg, admin, visitArr, newPatients, svcIndex);
}

async function commit(
  cfg: TabConfig, admin: SupabaseClient<Database>, visitArr: BuiltVisit[],
  newPatients: Map<string, { last: string; first: string; sex: string; sample: RawRow }>,
  svcIndex: ReturnType<typeof buildServiceIndex>,
): Promise<void> {
  requireLocalOrExplicitProd(`backfill:clinical:${cfg.isConsult ? "consult" : "lab"}`);
  const systemUserId = await ensureSystemUser(admin);

  // ensure generic legacy-lab service exists (lab tab only)
  if (!cfg.isConsult && !svcIndex.legacyLabId) {
    const { data, error } = await admin.from("services")
      .upsert({ code: "LEGACY-LAB", name: "Legacy lab test", kind: "lab_test", price_php: 0, is_active: false } as never,
        { onConflict: "code" }).select("id").single();
    if (error || !data) throw new Error(`legacy-lab upsert: ${error?.message}`);
    svcIndex.legacyLabId = data.id;
  }

  // open the run
  const { data: runRow, error: runErr } = await admin.from("legacy_import_runs")
    .insert({ source: `clinical_backfill:${cfg.tab}`, dry_run: false, run_by: systemUserId } as never)
    .select("id").single();
  if (runErr || !runRow) throw new Error(`legacy_import_runs: ${runErr?.message}`);
  const runId = runRow.id as string;

  // 1. create new patients, resolve NEW: placeholders -> real ids
  const newIdByKey = new Map<string, string>();
  for (const [nk, p] of newPatients) {
    const drm = await nextDrmId(admin);
    const { data, error } = await admin.from("patients").insert({
      drm_id: drm, first_name: p.first || p.last, last_name: p.last,
      pre_registered: false, birthdate_confirmed: false,
      legacy_import_run_id: runId,
      legacy_intake: { source: `clinical_backfill:${cfg.tab}`, raw: p.sample } as never,
    } as never).select("id").single();
    if (error || !data) throw new Error(`patient insert (${nk}): ${error?.message}`);
    newIdByKey.set(`NEW:${nk}`, data.id as string);
  }

  // 2. visits -> test_requests -> payment, idempotent on legacy_source_ref
  const usedVisitNumbers = new Set<string>();
  let vIns = 0, vSkip = 0, tIns = 0, pIns = 0;
  for (const v of visitArr) {
    const patient_id = v.patient_id.startsWith("NEW:") ? newIdByKey.get(v.patient_id)! : v.patient_id;
    const visitRef = `${cfg.tab} ${v.control_no ? "control=" + v.control_no : "grp=" + v.key}`;
    // idempotency: skip if this visit ref already imported
    const { data: existV } = await admin.from("visits").select("id").eq("legacy_source_ref", visitRef).maybeSingle();
    let visitId: string;
    if (existV?.id) { visitId = existV.id; vSkip++; }
    else {
      const visit_number = buildVisitNumber(cfg.tab, v.control_no, 0, usedVisitNumbers);
      const { data: vr, error: vErr } = await admin.from("visits").insert({
        patient_id, visit_number, visit_date: v.visit_date, payment_status: "unpaid",
        total_php: v.total, paid_php: 0, hmo_provider_id: v.hmo_provider_id,
        created_by: systemUserId, created_at: v.visit_date,
        legacy_import_run_id: runId, legacy_source_ref: visitRef,
      } as never).select("id").single();
      if (vErr || !vr) throw new Error(`visit insert (${visitRef}): ${vErr?.message}`);
      visitId = vr.id as string; vIns++;
    }
    // test_requests
    for (const ln of v.lines) {
      const ref = `${cfg.tab} r${ln.row.row_number}`;
      const { data: existT } = await admin.from("test_requests").select("id").eq("legacy_source_ref", ref).maybeSingle();
      if (existT?.id) continue;
      const base = round2(ln.row.base > 0 ? ln.row.base : ln.row.final);
      const final = round2(cfg.isConsult ? ln.row.clinic_fee : (ln.row.final > 0 ? ln.row.final : ln.row.base));
      const discount = round2(Math.max(base - final, 0));
      // unmatched lab lines carried service_id="" through dry-run; resolve to
      // the now-known generic legacy-lab service at commit time.
      const service_id = ln.service_id || svcIndex.legacyLabId;
      const { error: tErr } = await admin.from("test_requests").insert({
        visit_id: visitId, service_id, status: "released",
        requested_by: systemUserId, requested_at: ln.row.posting_date!,
        released_by: systemUserId, released_at: ln.row.posting_date!, release_medium: "physical",
        base_price_php: base, discount_amount_php: discount,
        discount_kind: discount > 0 ? "custom" : null,
        final_price_php: final,
        clinic_fee_php: cfg.isConsult ? round2(ln.row.clinic_fee) : null,
        doctor_pf_php: cfg.isConsult ? round2(ln.row.doctor_pf) : null,
        is_package_header: false, test_number: null,
        receptionist_remarks: ln.serviceMatched ? null : `legacy service: ${ln.row.service}`,
        legacy_import_run_id: runId, legacy_source_ref: ref,
      } as never);
      if (tErr) throw new Error(`test_request insert (${ref}): ${tErr.message}`);
      tIns++;
    }
    // payment (only if collected > 0)
    if (v.collected > 0) {
      const pref = `${cfg.tab} ${v.control_no ? "control=" + v.control_no : "grp=" + v.key} pay`;
      const { data: existP } = await admin.from("payments").select("id").eq("legacy_source_ref", pref).maybeSingle();
      if (!existP?.id) {
        const { error: pErr } = await admin.from("payments").insert({
          visit_id: visitId, amount_php: v.collected, method: v.method,
          reference_number: v.or_number || null, received_by: systemUserId,
          received_at: `${v.received_at}T02:00:00Z`,
          legacy_import_run_id: runId, legacy_source_ref: pref,
        } as never);
        if (pErr) throw new Error(`payment insert (${pref}): ${pErr.message}`);
        pIns++;
      }
    }
  }

  await admin.from("legacy_import_runs").update({
    ended_at: new Date().toISOString(), rows_inserted: vIns + tIns + pIns,
    notes: `visits +${vIns} (skip ${vSkip}), tests +${tIns}, payments +${pIns}, new patients +${newIdByKey.size}`,
  } as never).eq("id", runId);

  console.log(`\nCommit complete: visits +${vIns} (skip ${vSkip}), tests +${tIns}, payments +${pIns}, new patients +${newIdByKey.size}`);
}

// DRM-ID generator: mirror the app's format DRM-NNNN by taking max+1.
async function nextDrmId(admin: SupabaseClient<Database>): Promise<string> {
  const { data } = await admin.from("patients").select("drm_id")
    .like("drm_id", "DRM-%").order("drm_id", { ascending: false }).limit(1).maybeSingle();
  const last = data?.drm_id?.match(/DRM-(\d+)/)?.[1];
  const next = (last ? parseInt(last, 10) : 0) + 1;
  return `DRM-${String(next).padStart(4, "0")}`;
}
```

> NOTE: `nextDrmId` here is a simple max+1. Before implementing, confirm the app's real DRM-ID format/generator (check `src/lib/patients/*` and how `scripts/import-legacy-customers.ts` assigned ids) and reuse that exact logic instead — DRM-ID collisions with the app sequence must be impossible. If the app uses a Postgres sequence/RPC, call it.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (the `as never` casts absorb the not-yet-regenerated provenance columns until `db:types` runs; after Task 2 they exist in the type).

- [ ] **Step 3: Commit**

```bash
git add scripts/clinical-backfill/engine.ts
git commit -m "feat(backfill): read/classify/match/group/build engine + commit path"
```

### Task 16: Entrypoints + npm scripts

**Files:**
- Create: `scripts/clinical-backfill/lab.ts`
- Create: `scripts/clinical-backfill/consult.ts`
- Modify: `package.json`

- [ ] **Step 1: Write `lab.ts`**

```ts
import { run } from "./engine";
import type { TabConfig } from "./lib/types";

// LAB SERVICE column map (1-based) — verified from scripts/history-import/lab-services.ts.
const cfg: TabConfig = {
  tab: "LAB SERVICE", sheetName: "LAB SERVICE", isConsult: false,
  cols: {
    posting_date: 1, control_no: 2, test_no: 3, patient_name: 4, hmo_flag: 5,
    hmo_provider: 6, service: 8, base: 9, final: 14, mop: 15, or_number: 25, date_paid: 26,
  },
};
run(cfg).catch((e) => { console.error("FATAL:", e); process.exit(1); });
```

- [ ] **Step 2: Write `consult.ts`**

```ts
import { run } from "./engine";
import type { TabConfig } from "./lib/types";

// DOCTOR CONSULTATION column map (1-based) — verified from doctor-consultations.ts.
const cfg: TabConfig = {
  tab: "DOCTOR CONSULTATION", sheetName: "DOCTOR CONSULTATION", isConsult: true,
  cols: {
    posting_date: 1, control_no: 2, test_no: 3, patient_name: 4, hmo_flag: 5,
    hmo_provider: 6, service: 8, base: 9, final: 12, clinic_fee: 13, doctor_pf: 17,
    mop: 14, or_number: 23, date_paid: 21,
  },
};
run(cfg).catch((e) => { console.error("FATAL:", e); process.exit(1); });
```

- [ ] **Step 3: Add npm scripts**

In `package.json` scripts, after the `import:history:*` block, add:

```json
    "backfill:clinical:lab": "tsx --env-file=.env.local scripts/clinical-backfill/lab.ts",
    "backfill:clinical:consult": "tsx --env-file=.env.local scripts/clinical-backfill/consult.ts",
```

- [ ] **Step 4: Dry-run both against LOCAL (seeded) Supabase**

Run: `npm run backfill:clinical:lab` then `npm run backfill:clinical:consult`
Expected: each prints a summary and writes CSVs to `tmp/`; no rows written (dry-run). If `DR MED MASTERSHEET.xlsx` is absent locally, pass `--xlsx=<path>`.

- [ ] **Step 5: Commit**

```bash
git add scripts/clinical-backfill/lab.ts scripts/clinical-backfill/consult.ts package.json
git commit -m "feat(backfill): lab + consult entrypoints + npm scripts"
```

---

## Dispatch 4 — Validation + reconciliation

### Task 17: Validation SQL

**Files:**
- Create: `scripts/clinical-backfill/validate.sql`

- [ ] **Step 1: Write the validation queries**

```sql
-- Clinical backfill validation (read-only).
--   docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/clinical-backfill/validate.sql
\echo '=== 1. counts per year (legacy clinical rows) ==='
select extract(year from v.visit_date)::int as yr,
  count(distinct v.id) as visits,
  count(distinct t.id) as test_requests,
  count(distinct p.id) as payments
from public.visits v
left join public.test_requests t on t.visit_id = v.id and t.legacy_import_run_id is not null
left join public.payments p on p.visit_id = v.id and p.legacy_import_run_id is not null
where v.legacy_import_run_id is not null
group by 1 order by 1;

\echo '=== 2. payment_status distribution ==='
select payment_status, count(*) from public.visits
where legacy_import_run_id is not null group by 1 order by 1;

\echo '=== 3. GL-SILENCE assertion: zero JEs reference clinical legacy rows ==='
select count(*) as must_be_zero
from public.journal_entries je
where je.source_kind in ('payment','test_request')
  and je.source_id in (
    select id from public.payments where legacy_import_run_id is not null
    union all select id from public.test_requests where legacy_import_run_id is not null
  );

\echo '=== 4. books reconciliation: clinical final vs history_import revenue, per year ==='
with clinical as (
  select extract(year from t.released_at)::int as yr, sum(t.final_price_php) as clinical_final
  from public.test_requests t where t.legacy_import_run_id is not null group by 1
),
books as (
  select extract(year from je.posting_date)::int as yr, sum(jl.credit_php) as booked_revenue
  from public.journal_entries je
  join public.journal_lines jl on jl.entry_id = je.id
  join public.chart_of_accounts coa on coa.id = jl.account_id
  where je.source_kind = 'history_import' and coa.code in ('4100','4200','4500')
  group by 1
)
select coalesce(c.yr,b.yr) as yr,
  to_char(c.clinical_final,'FM999,999,999.00') as clinical,
  to_char(b.booked_revenue,'FM999,999,999.00') as books,
  to_char(coalesce(c.clinical_final,0)-coalesce(b.booked_revenue,0),'FM999,999,999.00') as diff
from clinical c full outer join books b on b.yr = c.yr order by 1;

\echo '=== 5. orphans / sanity ==='
select 'visits total<>sum(lines)' as check, count(*) as n from (
  select v.id from public.visits v
  join public.test_requests t on t.visit_id = v.id and t.legacy_import_run_id is not null
  where v.legacy_import_run_id is not null
  group by v.id, v.total_php having v.total_php <> round(sum(t.final_price_php),2)
) x;
```

- [ ] **Step 2: Commit**

```bash
git add scripts/clinical-backfill/validate.sql
git commit -m "feat(backfill): validation + books reconciliation SQL"
```

### Task 18: End-to-end commit on LOCAL + validate

- [ ] **Step 1: Seed a local stack with patients + services + HMO providers**

Run: `supabase start && npm run db:reset && npm run seed:services && npm run seed:hmo-providers`
(Optionally import a slice of real patients so matching exercises real names.)
Expected: local stack ready.

- [ ] **Step 2: Commit-import both tabs locally**

Run:
`npm run backfill:clinical:lab -- --commit --confirm="I-mean-it"`
`npm run backfill:clinical:consult -- --commit --confirm="I-mean-it"`
Expected: "Commit complete" with non-zero inserts; no errors.

- [ ] **Step 3: Run validation**

Run: `docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/clinical-backfill/validate.sql`
Expected: check #3 `must_be_zero = 0`; check #5 `n = 0`; #4 diffs explainable (discounts / zero-fee consults).

- [ ] **Step 4: Idempotency re-run**

Run the same two commit commands again.
Expected: "visits +0 (skip N)" — nothing re-inserted.

- [ ] **Step 5: Commit a short runbook note (no code)**

```bash
git commit --allow-empty -m "test(backfill): local end-to-end commit + validate + idempotency green"
```

---

## Dispatch 5 — Patient-portal degradation + prod rollout

### Task 19: Portal degradation for value-less released tests

**Files:**
- Inspect: `src/app/(portal)/portal/**` result view + download action (find the released-test render + signed-URL download)

- [ ] **Step 1: Reproduce**

Create (locally) a patient with a legacy released `test_requests` row (no `results` row), log into the portal as that patient, open results.
Expected current behavior: confirm whether it errors / shows a broken download.

- [ ] **Step 2: Make it degrade gracefully**

If the portal offers a download or errors when no `results` row exists, render *"Released — pre-system record (no digital copy on file)"* and hide the download control when `legacy_import_run_id is not null` and no linked result. Keep the change minimal and follow existing portal patterns. (Write the exact edit against the real file once located; include the failing-then-passing manual check.)

- [ ] **Step 3: Mobile check + commit**

Verify at 390×844 and desktop.

```bash
git add -A
git commit -m "fix(portal): graceful display for legacy released tests without a digital result"
```

### Task 20: Staging → production rollout

- [ ] **Step 1: Apply migration 0091 to staging, then prod**

Per `feedback_remote_db_ops_ipv6` (direct DB host IPv6-unreachable here): apply via the Supabase MCP `apply_migration` (or `execute_sql` + record the `0091` row in `supabase_migrations.schema_migrations`). Verify with `list_migrations`.

- [ ] **Step 2: Regenerate remote types**

Run: `npm run db:types:remote` (needs `SUPABASE_DB_URL`). Commit if changed.

- [ ] **Step 3: Dry-run against prod (read-only)**

Point `.env.local` at prod; run both entrypoints WITHOUT `--commit` (`--prod` not needed for dry-run since no writes). **Review the CSVs with the partner** — sign off match-rate, new-patients, unmapped-services. **HARD STOP — do not proceed to commit without sign-off.**

- [ ] **Step 4: Commit-import per year to prod**

`SEED_ALLOW_PROD=1 npm run backfill:clinical:lab -- --commit --confirm="I-mean-it" --prod`
then the consult entrypoint. Run `validate.sql` against prod (via MCP `execute_sql`) and confirm GL-silence (#3 = 0) + reconciliation.

- [ ] **Step 5: Update docs + memory**

Add a `RELEASE_NOTES.md` entry; update memory (new session-end snapshot: clinical backfill shipped, counts, run ids). Tag a release.

---

## Self-review notes

- **Spec coverage:** §5 migration → Task 1–2; §6 construction → Task 15; §7 matching → Task 11 + engine; §8 service map → Task 10; §9 CLI → Task 16; §10 idempotency/rollback → engine (`legacy_source_ref` skip) + delete-by-run (documented in spec §10); §11 validation/reconciliation → Task 17; §12 portal → Task 19; §13 sequence → dispatch order; system user → Task 13.
- **Hard stop** after Dispatch 3 dry-run is enforced in Task 20 Step 3.
- **Open items** (spec §15): transaction name format validated by Task 5 tests + Task 16 dry-run match-rate; cutover date encoded as `2026-05-26` exclusive in `engine.ts` (single constant to change); `visit_group_id` linking is NOT implemented in this plan (deferred — see below).

### Deferred (call out, not silently dropped)
- **`visit_group_id` cross-tab linking** (consult+lab same encounter) is **not** in this plan — it needs both tabs grouped together, which the per-tab entrypoints don't do. Add as a follow-up task (a post-pass that links visits sharing `(patient_id, visit_date, control_no)`), or accept standalone visits for v1. Flag to the user.
- **Attending physician** from a sheet "Doctor" column is not wired (the consult tab's doctor column wasn't confirmed). Left NULL; revisit if the partner wants per-physician history.
