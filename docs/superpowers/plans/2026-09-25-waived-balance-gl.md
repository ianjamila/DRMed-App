# Waived Balance → GL (discount + clear AR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an admin waives a visit balance, book the waived remainder as a discount (4910 lab / 4920 doctor) per bill line and clear 1100 AR Patients, and freeze the visit's money and bill lines at the database so the fixed waiver can never drift from the books.

**Architecture:** One migration (**0183**) adds `visit_waiver_allocations` (one row per priced line, largest-remainder split, fixed at waive time), a service-role RPC `waive_visit_balance()` that computes the split under the visit + line row locks and posts a standalone discount JE for lines already released, a fold into `bridge_test_request_released()` for lines released later, reversal hooks in the undo-release and cancel bridges (latest bodies = **0166**), and three guard triggers: **P0069** on `visits` (entering `'waived'` only inside the RPC — insert or update — never leaving it, and no change to the visit's money/provenance fields once waived), **P0070** on `payments` (insert, void, money-bearing update, hard delete — old and new visit) and on `test_requests` (insert, restore, reprice, reparent, move) for a waived visit. `correct_payment` keeps its equal-amount replacement under a transaction-scoped flag. App side: the waive action calls the RPC; the Record payment page refuses a waived visit; the payment dialogs stop offering what the DB now refuses.

**Tech Stack:** Postgres (plpgsql, Supabase migrations), Next.js 16 server actions, vitest, `supabase/tests/*.sql` smokes (local stack only; the race smoke runs as `supabase_admin` with `dblink`), real-Chrome `smoke:print`.

**Spec:** `docs/superpowers/specs/2026-09-25-waived-balance-gl-design.md` (rules 1–7). Codex plan review 2026-09-25 (session 01a0d7f8-e53e-7742-8bcf-79c2ea654cca) — 11 findings, all folded in and marked `[CR-n]`. Claimed numbers: migration **0183** (0182 = `feat/staff-view-as-role`, another session), P-codes **P0069** (visits guard), **P0070** (money or lines on a waived visit), **P0071** (`waive_visit_balance` refusals, message passed through).

**Worktree:** `~/Claude/DRMed/.worktrees/waived-balance-gl`, branch `feat/waived-balance-gl` off `origin/main` 175f53ee (#233 merged). `.env.local`, `.env.development.local` and `supabase/.temp/{project-ref,linked-project.json,pooler-url}` are copied in.

**Local-stack facts:** other sessions `db reset` the shared local stack from checkouts behind main; `supabase migration up --local` refuses because of a stray ledger row. Apply migration files by hand in one transaction with a hand-written ledger row (Task 8), never `migration repair`. Re-check `select max(version) from supabase_migrations.schema_migrations` before every smoke. `psql` = `/opt/homebrew/opt/libpq/bin/psql`; app-role connection `APP="postgresql://postgres:postgres@127.0.0.1:54322/postgres"`; `postgres` is NOT a superuser on the Supabase image (`dblink_connect` refuses it), so the race smoke runs as `ADMIN="postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres"` — verified 2026-09-25 that `dblink_connect('t1','dbname=postgres user=supabase_admin password=postgres host=localhost port=5432')` works from inside the container.

---

## Serialization protocol (referenced by every task) `[CR-5]`

Every path that can change a waived visit's books takes row locks in this order, so the waiver and the line lifecycle serialize on the same rows:

1. `waive_visit_balance`: the `visits` row `FOR UPDATE`, then **every live `test_requests` row of the visit `FOR UPDATE` in `id` order**, then reads payments (no payment lock). Only after both locks does it read line statuses, so a concurrent undo/cancel/release that already holds a line lock finishes first and the waiver sees the final status.
2. Undo-release, cancel and release are `UPDATE test_requests … WHERE id = …` statements: they hold that line's row lock for the transaction; their AFTER triggers read/write the allocation for that same line, which the waiver only touches while holding the line lock. The package cascade inside `fn_undo_release_bridge` additionally locks the header row.
3. Payments: `guard_payment_on_waived_visit` locks the `visits` row (old and new visit, in uuid order) before deciding; `recalc_visit_payment` locks the visit row; `correct_payment` locks payment → visit. The waiver never locks a payment, so there is no cycle on that side.
4. The one cycle that remains possible is waiver (visit → lines in id order) against an undo cascade (component row → header row) when the header's id sorts below the component's. Postgres detects it and aborts one side with SQLSTATE `40P01`; `translatePgError` renders it "Something else changed this visit at the same moment. Try again." and the aborted side writes nothing. Accepted: rare, detected, safe.

Task 7 proves four orders: payment-then-waive, waive-then-payment, undo-then-waive, waive-then-undo.

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/0183_waived_balance_gl.sql` | Zero-waiver assertion, enum value, `visits` waiver columns, `visit_waiver_allocations`, three guards, `waive_visit_balance`, `waiver_post_allocation`, `waiver_unrecognise_line`, fold in the release bridge (0159 body), hooks in undo/cancel bridges (0166 bodies), `correct_payment` re-created (0174 body), ACLs, comments |
| `supabase/seed.sql` | Mirror the new table's revoke/grant |
| `supabase/tests/0183_waived_balance_gl_smoke.sql` | GL cases A–N, single session |
| `supabase/tests/0183_waiver_race_smoke.sql` | Four two-session orders, dblink, `supabase_admin`, local only |
| `src/lib/accounting/waiver-allocation.ts` (+ `.test.ts`) | Pure largest-remainder mirror for the dialog preview |
| `src/lib/accounting/waived-balance-gl.test.ts` | Pins the migration SQL |
| `src/lib/accounting/pg-errors.ts` | P0069–P0071 + `40P01` |
| `src/lib/accounting/ledger-status-sql.test.ts` | `SQL_LOOKUPS` for the two new posted-only readers |
| `src/lib/visits/payment-edit.ts` (+ `payment-leaves.test.ts`) | `waivedVisitPaymentRules`, `WAIVE_CLOSED_MONTH_MESSAGE` |
| `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts` | `waiveVisitBalanceAction` → RPC |
| `src/app/(staff)/staff/(dashboard)/visits/[id]/waive-balance-dialog.tsx` + `page.tsx` | Preview of the split; hide Delete/Move; lock the Edit amount |
| `src/app/(staff)/staff/(dashboard)/payments/[id]/edit/edit-payment-dialog.tsx` | `amountLocked` |
| `src/app/(staff)/staff/(dashboard)/payments/new/page.tsx` + `actions.ts` | Waived visit: say so, no form; both actions refuse |
| `src/types/database.ts` | Regenerated from the local stack |
| `scripts/smoke-print.ts`, `scripts/smoke-14-d1.sql`, `supabase/tests/0167_patient_soft_delete_smoke.sql` | Stop writing `'waived'` directly |
| `docs/drmed-user-guide.html`, `.claude/skills/drmed-payments/SKILL.md`, `.claude/skills/drmed-migrations/SKILL.md`, `CLAUDE.md` | Docs |

---

### Task 1: Pure allocation mirror (largest remainder)

**Files:**
- Create: `src/lib/accounting/waiver-allocation.ts`
- Test: `src/lib/accounting/waiver-allocation.test.ts`

- [ ] **Step 1: Write the failing test** `[CR-9: fixtures fit the rule]`

```ts
import { describe, expect, it } from "vitest";
import { allocateWaiver, waiverPreview, type WaiverLine } from "./waiver-allocation";

const line = (id: string, pricePhp: number, kind = "lab_test", p: Partial<WaiverLine> = {}): WaiverLine => ({
  id,
  pricePhp,
  kind,
  isComponent: false,
  status: "requested",
  ...p,
});

describe("allocateWaiver (mirror of waive_visit_balance's split, 0183)", () => {
  it("splits proportionally, lab to 4910 and doctor lines to 4920", () => {
    expect(allocateWaiver(600, [line("a", 500), line("b", 500, "doctor_consultation")])).toEqual([
      { id: "a", amountPhp: 300, account: "4910" },
      { id: "b", amountPhp: 300, account: "4920" },
    ]);
  });
  it("largest remainder: the centavos add up exactly, biggest fraction first, id as tie-break", () => {
    // ₱1,000 over three ₱500 lines (₱1,500 billed, ₱500 paid): 333.33 × 3 = 999.99;
    // every fraction ties, so the leftover centavo goes to the lowest id.
    const out = allocateWaiver(1000, [line("c", 500), line("a", 500), line("b", 500)]);
    expect(out.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(out.map((o) => o.amountPhp)).toEqual([333.34, 333.33, 333.33]);
    expect(out.reduce((s, o) => s + o.amountPhp, 0)).toBeCloseTo(1000, 2);
  });
  it("never exceeds a line's own price and never goes negative", () => {
    expect(allocateWaiver(0.03, [line("a", 0.01), line("b", 0.02)])).toEqual([
      { id: "a", amountPhp: 0.01, account: "4910" },
      { id: "b", amountPhp: 0.02, account: "4910" },
    ]);
  });
  it("skips ₱0 package components, cancelled lines, and drops ₱0 shares", () => {
    const out = allocateWaiver(1, [
      line("header", 5888, "lab_package"),
      line("comp", 0, "lab_test", { isComponent: true }),
      line("x", 550, "lab_test", { status: "cancelled" }),
      line("tiny", 0.01),
    ]);
    expect(out.map((o) => o.id)).toEqual(["header"]);
    expect(out[0]!.amountPhp).toBe(1);
  });
  it("refuses a remainder bigger than the lines add up to (visit total out of step)", () => {
    expect(() => allocateWaiver(700, [line("a", 500)])).toThrow(/more than its lines/);
  });
  it("preview groups the split by account", () => {
    expect(waiverPreview(600, [line("a", 500), line("b", 500, "doctor_procedure")])).toEqual({
      labPhp: 300,
      doctorPhp: 300,
      lines: 2,
    });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/accounting/waiver-allocation.test.ts` — expected FAIL: cannot find module `./waiver-allocation`.

- [ ] **Step 3: Implement**

```ts
// src/lib/accounting/waiver-allocation.ts
// Mirror of the split waive_visit_balance() (migration 0183) makes when an
// admin waives a visit balance: the remainder is spread over the visit's
// priced live lines by the LARGEST-REMAINDER method in centavos, so the
// pieces add up exactly and no line carries more than its own price. The SQL
// is the source of truth (0183's smoke case H uses the same fixture); this
// feeds the waive dialog's preview and nothing else.
import { classifyKind } from "@/lib/visits/classification";

export interface WaiverLine {
  id: string;
  /** final_price_php as billed. */
  pricePhp: number;
  /** services.kind — doctor kinds go to 4920, everything else to 4910. */
  kind: string | null | undefined;
  /** parent_id != null: a ₱0 package component, never allocated to. */
  isComponent: boolean;
  status: string;
}

export interface WaiverAllocation {
  id: string;
  amountPhp: number;
  account: "4910" | "4920";
}

const toC = (php: number): number => Math.round(php * 100);

export function discountAccountFor(kind: string | null | undefined): "4910" | "4920" {
  const cls = classifyKind(kind ?? "");
  return cls === "consult" || cls === "procedure" ? "4920" : "4910";
}

/** The lines a waiver is spread over: priced, live, not a component, not cancelled. */
export function allocatableLines(lines: readonly WaiverLine[]): WaiverLine[] {
  return lines.filter((l) => !l.isComponent && l.status !== "cancelled" && toC(l.pricePhp) > 0);
}

export function allocateWaiver(remainderPhp: number, lines: readonly WaiverLine[]): WaiverAllocation[] {
  const rem = toC(remainderPhp);
  if (rem <= 0) return [];
  const pool = allocatableLines(lines);
  const sum = pool.reduce((s, l) => s + toC(l.pricePhp), 0);
  if (sum === 0) throw new Error("No priced lines to allocate the waiver over.");
  if (rem > sum) throw new Error("This visit's total is more than its lines add up to; fix the lines first.");
  const shares = pool.map((l) => {
    const p = toC(l.pricePhp);
    return { id: l.id, account: discountAccountFor(l.kind), share: Math.floor((rem * p) / sum), frac: (rem * p) % sum };
  });
  let left = rem - shares.reduce((s, x) => s + x.share, 0);
  const order = [...shares].sort((a, b) => b.frac - a.frac || a.id.localeCompare(b.id));
  for (const x of order) {
    if (left === 0) break;
    x.share += 1;
    left -= 1;
  }
  return shares
    .filter((x) => x.share > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((x) => ({ id: x.id, amountPhp: x.share / 100, account: x.account }));
}

/** What the waive dialog says: how much lands on each discount account. */
export function waiverPreview(
  remainderPhp: number,
  lines: readonly WaiverLine[],
): { labPhp: number; doctorPhp: number; lines: number } {
  const out = allocateWaiver(remainderPhp, lines);
  const sum = (acct: "4910" | "4920") =>
    out.filter((o) => o.account === acct).reduce((s, o) => s + toC(o.amountPhp), 0) / 100;
  return { labPhp: sum("4910"), doctorPhp: sum("4920"), lines: out.length };
}
```

- [ ] **Step 4: Run** — expected 6 passed.
- [ ] **Step 5: Commit** `git add src/lib/accounting/waiver-allocation.ts src/lib/accounting/waiver-allocation.test.ts && git commit -m "feat(accounting): largest-remainder waiver allocation (mirror of 0183)"`

---

### Task 2: Migration 0183 — schema, guards, RPC, fold, hooks

**Files:**
- Create: `supabase/migrations/0183_waived_balance_gl.sql`
- Modify: `supabase/seed.sql` (tail)

- [ ] **Step 1: Write the migration.** Four function bodies are COPIED from their latest definitions and edited only where marked `-- 0183:`. Latest definitions (grep-confirmed): `bridge_test_request_released` = **0159**; `fn_undo_release_bridge` = **0166** line 140 and `bridge_test_request_cancelled` = **0166** line 29 (the 0140/0141 bodies still update the dropped `cogs_send_out_entries` table — copying them would break every undo and cancel) `[CR-1]`; `correct_payment` = **0174** lines 48–187. Never retype a body from memory.

```sql
-- =============================================================================
-- 0183_waived_balance_gl.sql — a waived balance is booked as a discount and
-- clears 1100 AR Patients; a waived visit's money and lines are frozen.
-- =============================================================================
-- Before this, waiveVisitBalanceAction only flipped visits.payment_status to
-- 'waived'. The release bridge then debited 1100 for every line at full price
-- and credited full revenue, so the waived remainder sat in AR forever.
--
-- Design (docs/superpowers/specs/2026-09-25-waived-balance-gl-design.md):
--   1. waive_visit_balance() splits the remainder over the visit's priced live
--      lines (largest remainder, centavos, bounded by the line price) into
--      visit_waiver_allocations, one row per line, FIXED at waive time.
--      A line already released gets a standalone JE now (DR 4910/4920,
--      CR 1100, source 'visit_waiver' keyed by the allocation); a line released
--      later has its share FOLDED into its release JE (DR 1100 final − waived,
--      DR 4910/4920 waived, CR revenue unchanged). recognised_at /
--      journal_entry_id record what posted, so nothing double-posts on replay.
--   2. Undo-release and cancel reverse the allocation with the line: a folded
--      share goes with the release JE's mirror reversal; a standalone waiver
--      JE is reversed by waiver_unrecognise_line(); either way the allocation
--      is marked unrecognised so a re-release folds it again.
--   3. Money on a waived visit is refused at the DB (P0070): payment insert,
--      void, money-bearing update, hard delete, move on or off; bill lines
--      cannot be added, restored, repriced, reparented or moved. The one
--      exception is correct_payment keeping the amount (method/reference/
--      notes) — it inserts the replacement before voiding the original, under
--      app.waived_visit_edit = 'on' scoped to exactly those two writes.
--   4. payment_status may become 'waived' (insert or update) only inside
--      waive_visit_balance() (app.waive_visit = 'on') and may never leave it;
--      a waived visit's total, HMO, provenance and waiver record are frozen
--      (P0069). RLS "visits: staff full" is FOR ALL for every staff role.
--   5. Lock order: visits row FOR UPDATE, then the visit's live test_requests
--      rows FOR UPDATE in id order, payments only read. The payment guard and
--      recalc_visit_payment lock the visits row; correct_payment locks
--      payment → visit; undo/cancel/release hold their line's row lock. The
--      waiver never locks a payment. The one possible cycle (waiver vs. an
--      undo cascade component → header) is detected by Postgres (40P01).
--   6. Provenance per row: all live → allocate + post; all imported (visit,
--      every live line, every non-voided payment) → 'waived' with NO
--      allocation and no JE; mixed → P0071.
--   7. Reversals: original → 'reversed', mirrored 'posted' entry (0173).
--      Posting date Manila. A closed month raises P0002 from
--      je_period_lock_check for the waiver's own standalone entries and the
--      whole waive rolls back; a package header auto-released by the waive
--      (0109 Leg B) catches its own errors by design and stays
--      ready_for_release with an audit row.
--
-- P-codes: P0069 visits guard · P0070 money or bill lines on a waived visit ·
-- P0071 waive_visit_balance refusals (several messages, passed through).
-- =============================================================================

-- ---- Precondition: no waived visit may exist (nothing is backfilled) ---------
-- Held under a table lock so a waiver committed between the preflight count
-- and this transaction cannot slip through without an allocation.  [CR-11]
do $$
declare v_n int;
begin
  lock table public.visits in share row exclusive mode;
  select count(*) into v_n from public.visits where payment_status = 'waived';
  if v_n > 0 then
    raise exception 'STOP 0183: % waived visit(s) exist and would carry no allocation. Reconcile them before applying.', v_n;
  end if;
end $$;

alter type public.je_source_kind add value if not exists 'visit_waiver';

-- ---- visits: the waiver, fixed at waive time --------------------------------
alter table public.visits
  add column if not exists waived_php   numeric(10,2),
  add column if not exists waived_at    timestamptz,
  add column if not exists waived_by    uuid references public.staff_profiles(id),
  add column if not exists waive_reason text;

comment on column public.visits.waived_php is
  'The remainder waived (total − paid at waive time), fixed by waive_visit_balance (0183). NULL when never waived.';

-- ---- the per-line allocation ------------------------------------------------
create table if not exists public.visit_waiver_allocations (
  id               uuid primary key default gen_random_uuid(),
  visit_id         uuid not null references public.visits(id),
  test_request_id  uuid not null references public.test_requests(id),
  amount_php       numeric(10,2) not null check (amount_php > 0),
  discount_account text not null check (discount_account in ('4910', '4920')),
  -- Set when the share is in the books: by its own 'visit_waiver' JE (line
  -- already released at waive time) or folded into the line's release JE.
  recognised_at    timestamptz,
  journal_entry_id uuid references public.journal_entries(id),
  created_at       timestamptz not null default now(),
  constraint visit_waiver_allocations_line_key unique (test_request_id)
);
create index if not exists idx_visit_waiver_allocations_visit
  on public.visit_waiver_allocations (visit_id);

alter table public.visit_waiver_allocations enable row level security;
revoke all on public.visit_waiver_allocations from anon;
revoke all on public.visit_waiver_allocations from authenticated;
grant select on public.visit_waiver_allocations to authenticated;
create policy "visit_waiver_allocations: reception/admin read"
  on public.visit_waiver_allocations for select to authenticated
  using ((select public.has_role(array['reception', 'admin'])));
-- Writes: waive_visit_balance() and the bridges only (service_role / triggers).

-- ---- P0069: the visits guard --------------------------------------------------
-- INSERT is guarded too: "visits: staff full" (0151) is FOR ALL, so a staff JWT
-- could insert a row already 'waived'.  [CR-2]  Once waived, the fields the
-- waiver was computed from (total, provenance, HMO) and the waiver's own
-- record are frozen; recalc_visit_payment only writes paid_php /
-- payment_status (preserving 'waived'), so it is unaffected.  [CR-4]
create or replace function public.guard_visit_waived_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inside boolean := coalesce(current_setting('app.waive_visit', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.payment_status = 'waived' and not v_inside then
      raise exception 'A balance can only be waived with Waive balance on the visit page.'
        using errcode = 'P0069';
    end if;
    return new;
  end if;

  if new.payment_status = 'waived' and old.payment_status is distinct from 'waived' and not v_inside then
    raise exception 'A balance can only be waived with Waive balance on the visit page.'
      using errcode = 'P0069';
  end if;
  if old.payment_status = 'waived' and new.payment_status is distinct from 'waived' then
    raise exception 'A waived balance cannot be un-waived.' using errcode = 'P0069';
  end if;
  if old.payment_status = 'waived' and not v_inside and (
       new.total_php             is distinct from old.total_php
    or new.hmo_provider_id       is distinct from old.hmo_provider_id
    or new.legacy_import_run_id  is distinct from old.legacy_import_run_id
    or new.waived_php            is distinct from old.waived_php
    or new.waived_at             is distinct from old.waived_at
    or new.waived_by             is distinct from old.waived_by
    or new.waive_reason          is distinct from old.waive_reason
  ) then
    raise exception 'This visit''s balance was waived, so its total, billing and waiver record are fixed.'
      using errcode = 'P0069';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_visits_waived_transition_guard on public.visits;
create trigger trg_visits_waived_transition_guard
  before insert or update of payment_status, total_php, hmo_provider_id, legacy_import_run_id,
                            waived_php, waived_at, waived_by, waive_reason
  on public.visits
  for each row execute function public.guard_visit_waived_transition();

-- ---- P0070: payments on a waived visit ---------------------------------------
-- Insert, void, any money-bearing update (amount / method / visit / received_at
-- — payments_block_post_je_edits only covers rows WITH a posted JE; imported
-- rows have none) and a hard DELETE (bridge_payment_delete reverses the JE)
-- all move money. Both the old and the new visit are checked, locked in uuid
-- order.  [CR-3]
create or replace function public.guard_payment_on_waived_visit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids    uuid[];
  v_id     uuid;
  v_status text;
  v_inside boolean := coalesce(current_setting('app.waived_visit_edit', true), '') = 'on';
begin
  if tg_op = 'UPDATE' then
    if not (
         (old.voided_at is null and new.voided_at is not null)
      or new.amount_php  is distinct from old.amount_php
      or new.method      is distinct from old.method
      or new.visit_id    is distinct from old.visit_id
      or new.received_at is distinct from old.received_at
    ) then
      return new;
    end if;
    v_ids := array(select distinct x from unnest(array[old.visit_id, new.visit_id]) x order by x);
  elsif tg_op = 'DELETE' then
    v_ids := array[old.visit_id];
  else
    v_ids := array[new.visit_id];
  end if;

  foreach v_id in array v_ids loop
    -- Visit row lock first — the one order every money path uses (spec §5).
    select payment_status into v_status from public.visits where id = v_id for update;
    if v_status = 'waived' and not v_inside then
      raise exception 'This visit''s balance was waived, so its payments are fixed: nothing can be recorded, changed, deleted or moved on it.'
        using errcode = 'P0070';
    end if;
  end loop;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_payments_waived_visit_guard on public.payments;
create trigger trg_payments_waived_visit_guard
  before insert or update or delete on public.payments
  for each row execute function public.guard_payment_on_waived_visit();

-- ---- P0070: bill lines on a waived visit --------------------------------------
-- The allocation was computed over the lines as they stood. A new line, a
-- restored line (the 0125 cascade also raises total_php), a reprice, a
-- reparent or a move to another visit would leave a line with no share that
-- still releases at full AR.  [CR-4]  Status changes (release / undo / cancel)
-- stay allowed — the bridges handle the share. Soft-delete is already
-- impossible on a non-unpaid visit (P0042).
create or replace function public.guard_test_request_on_waived_visit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids    uuid[];
  v_id     uuid;
  v_status text;
  v_inside boolean := coalesce(current_setting('app.waive_visit', true), '') = 'on';
begin
  if tg_op = 'UPDATE' then
    if not (
         (old.deleted_at is not null and new.deleted_at is null)   -- restore
      or new.final_price_php     is distinct from old.final_price_php
      or new.base_price_php      is distinct from old.base_price_php
      or new.discount_amount_php is distinct from old.discount_amount_php
      or new.clinic_fee_php      is distinct from old.clinic_fee_php
      or new.doctor_pf_php       is distinct from old.doctor_pf_php
      or new.parent_id           is distinct from old.parent_id
      or new.service_id          is distinct from old.service_id
      or new.visit_id            is distinct from old.visit_id
      or new.is_package_header   is distinct from old.is_package_header
    ) then
      return new;
    end if;
    v_ids := array(select distinct x from unnest(array[old.visit_id, new.visit_id]) x order by x);
  else
    v_ids := array[new.visit_id];
  end if;

  foreach v_id in array v_ids loop
    select payment_status into v_status from public.visits where id = v_id for update;
    if v_status = 'waived' and not v_inside then
      raise exception 'This visit''s balance was waived, so its lines are fixed: nothing can be added, restored, repriced or moved.'
        using errcode = 'P0070';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_test_requests_waived_visit_guard on public.test_requests;
create trigger trg_test_requests_waived_visit_guard
  before insert or update of deleted_at, final_price_php, base_price_php, discount_amount_php,
                            clinic_fee_php, doctor_pf_php, parent_id, service_id, visit_id, is_package_header
  on public.test_requests
  for each row execute function public.guard_test_request_on_waived_visit();

-- ---- Post one allocation's standalone JE (line already released) ------------
create or replace function public.waiver_post_allocation(p_allocation_id uuid, p_actor_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  a      record;
  v_je   uuid;
  v_date date := (now() at time zone 'Asia/Manila')::date;
begin
  select wa.*, s.kind
    into a
    from public.visit_waiver_allocations wa
    join public.test_requests tr on tr.id = wa.test_request_id
    join public.services s on s.id = tr.service_id
   where wa.id = p_allocation_id
   for update of wa;
  if not found then
    raise exception 'Waiver allocation not found.' using errcode = 'P0071';
  end if;
  if a.recognised_at is not null then
    return a.journal_entry_id;
  end if;

  -- Idempotency: a live JE for this allocation already exists (posted-only
  -- lookup on purpose — SQL_LOOKUPS in ledger-status-sql.test.ts).
  select id into v_je
    from public.journal_entries
   where source_kind = 'visit_waiver'
     and source_id = a.id
     and status = 'posted';
  if v_je is null then
    insert into public.journal_entries (
      posting_date, description, status, source_kind, source_id, created_by
    ) values (
      v_date,
      'Balance waived: ' || coalesce(a.kind, 'line') || ' discount',
      'draft', 'visit_waiver', a.id, p_actor_id
    ) returning id into v_je;

    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order, description)
    values
      (v_je, public.coa_uuid_for_code(a.discount_account), a.amount_php, 0, 1, 'Balance waived'),
      (v_je, public.coa_uuid_for_code('1100'),             0, a.amount_php, 2, 'Clear patient receivable');

    update public.journal_entries set status = 'posted' where id = v_je;
  end if;

  update public.visit_waiver_allocations
     set recognised_at = now(), journal_entry_id = v_je
   where id = a.id;
  return v_je;
end;
$$;

comment on function public.waiver_post_allocation(uuid, uuid) is
  'Posts one waiver allocation''s standalone discount JE (0183). Posted-only journal read on purpose: '
  'idempotency — one live JE per allocation. A lookup, not a ledger total; totals count posted + '
  'reversed (LEDGER_TOTAL_STATUSES, ledger-status-sql.test.ts SQL_LOOKUPS).';

-- ---- Undo / cancel: take the share back out of the books --------------------
create or replace function public.waiver_unrecognise_line(p_test_request_id uuid, p_actor_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a        record;
  v_orig   uuid;
  v_number text;
  v_rev    uuid;
begin
  select * into a
    from public.visit_waiver_allocations
   where test_request_id = p_test_request_id
   for update;
  if not found or a.recognised_at is null then
    return;
  end if;

  -- A standalone waiver JE is reversed here. A folded share lives inside the
  -- release JE the caller has just reversed, so there is nothing to post.
  -- Posted-only lookup on purpose (SQL_LOOKUPS): find the live entry to reverse.
  select id, entry_number into v_orig, v_number
    from public.journal_entries
   where source_kind = 'visit_waiver'
     and source_id = a.id
     and status = 'posted'
   for update;
  if v_orig is not null then
    insert into public.journal_entries (
      posting_date, description, status, source_kind, source_id, reverses, created_by
    ) values (
      (now() at time zone 'Asia/Manila')::date,
      'Reversal of ' || v_number || ': ' || p_reason,
      'draft', 'reversal', null, v_orig, p_actor_id
    ) returning id into v_rev;
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    select v_rev, account_id, credit_php, debit_php, line_order
      from public.journal_lines
     where entry_id = v_orig
     order by line_order;
    update public.journal_entries set status = 'posted' where id = v_rev;
    update public.journal_entries set status = 'reversed', reversed_by = v_rev where id = v_orig;
  end if;

  update public.visit_waiver_allocations
     set recognised_at = null, journal_entry_id = null
   where id = a.id;
end;
$$;

comment on function public.waiver_unrecognise_line(uuid, uuid, text) is
  'Undo-release / cancel hook (0183): reverses a standalone waiver JE and marks the allocation '
  'unrecognised. Posted-only journal read on purpose: finds the live entry to reverse; a reversed one '
  'must not be reversed twice (LEDGER_TOTAL_STATUSES, ledger-status-sql.test.ts SQL_LOOKUPS).';

-- ---- The waive itself --------------------------------------------------------
create or replace function public.waive_visit_balance(p_visit_id uuid, p_actor_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit        public.visits%rowtype;
  v_role         text;
  v_total_c      bigint;
  v_paid_c       bigint;
  v_rem_c        bigint;
  v_sum_c        bigint;
  v_left         bigint;
  v_lines_live   int;
  v_lines_legacy int;
  v_pay_live     int;
  v_pay_legacy   int;
  v_all_legacy   boolean;
  v_all_live     boolean;
  v_n            int := 0;
  v_posted       int := 0;
  r              record;
begin
  if p_actor_id is null then
    raise exception 'Waiving needs the admin making the change.' using errcode = 'P0071';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Reason is required.' using errcode = 'P0071';
  end if;
  select role into v_role from public.staff_profiles where id = p_actor_id and is_active;
  if v_role is distinct from 'admin' then
    raise exception 'Only an admin can waive a balance.' using errcode = 'P0071';
  end if;

  -- Lock order (spec §5): the visit row, then every live line in id order.
  -- A concurrent release / undo / cancel holds its line's row lock, so the
  -- statuses read below are final for this transaction.  [CR-5]
  select * into v_visit from public.visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visit not found.' using errcode = 'P0071';
  end if;
  perform 1 from public.test_requests where visit_id = p_visit_id and deleted_at is null order by id for update;

  if v_visit.deleted_at is not null then
    raise exception 'This visit was deleted from the queue. Restore it before waiving.' using errcode = 'P0071';
  end if;
  if v_visit.hmo_provider_id is not null then
    raise exception 'This visit is billed to an HMO and already releases without payment — there is no balance to waive.'
      using errcode = 'P0071';
  end if;
  if v_visit.payment_status = 'waived' then
    raise exception 'This visit''s balance is already waived.' using errcode = 'P0071';
  end if;
  if v_visit.payment_status = 'paid' then
    raise exception 'This visit is already fully paid — nothing to waive.' using errcode = 'P0071';
  end if;

  -- A gift-code redemption in flight: the payment row exists but the voucher
  -- has not been marked redeemed yet; if that update fails the app voids the
  -- payment, which a waive in between would refuse (P0070).  [CR-7]
  if exists (
    select 1 from public.payments p
     where p.visit_id = p_visit_id and p.voided_at is null and p.method = 'gift_code'
       and not exists (select 1 from public.gift_codes g where g.redeemed_payment_id = p.id)
  ) then
    raise exception 'A gift code is being redeemed on this visit right now. Try again in a moment.'
      using errcode = 'P0071';
  end if;

  -- Provenance, per row (spec §6).
  select coalesce(sum(round(amount_php * 100)), 0)::bigint,
         count(*) filter (where legacy_import_run_id is null),
         count(*) filter (where legacy_import_run_id is not null)
    into v_paid_c, v_pay_live, v_pay_legacy
    from public.payments
   where visit_id = p_visit_id and voided_at is null;
  select count(*) filter (where legacy_import_run_id is null),
         count(*) filter (where legacy_import_run_id is not null)
    into v_lines_live, v_lines_legacy
    from public.test_requests
   where visit_id = p_visit_id and deleted_at is null and status <> 'cancelled';
  v_all_legacy := v_visit.legacy_import_run_id is not null and v_lines_live = 0 and v_pay_live = 0;
  v_all_live   := v_visit.legacy_import_run_id is null and v_lines_legacy = 0 and v_pay_legacy = 0;
  if not v_all_legacy and not v_all_live then
    raise exception 'This visit mixes imported and live rows; reconcile it before waiving.' using errcode = 'P0071';
  end if;

  v_total_c := round(v_visit.total_php * 100)::bigint;
  v_rem_c   := v_total_c - v_paid_c;
  if v_rem_c <= 0 then
    raise exception 'Nothing left to waive on this visit.' using errcode = 'P0071';
  end if;

  if v_all_live then
    -- Priced live lines: headers and standalone lines; ₱0 package components
    -- (parent_id set) never carry money.
    select coalesce(sum(round(final_price_php * 100)), 0)::bigint into v_sum_c
      from public.test_requests
     where visit_id = p_visit_id and deleted_at is null and status <> 'cancelled'
       and parent_id is null and coalesce(final_price_php, 0) > 0;
    if v_sum_c = 0 then
      raise exception 'No priced lines to allocate the waiver over.' using errcode = 'P0071';
    end if;
    -- The release bridge books LINE prices, so the waiver only clears AR if
    -- the visit total is exactly the priced lines. Either direction is refused.  [CR-6]
    if v_total_c <> v_sum_c then
      raise exception 'This visit''s total (₱%) does not match its lines (₱%); fix the lines before waiving.',
        to_char(v_total_c / 100.0, 'FM999,999,990.00'), to_char(v_sum_c / 100.0, 'FM999,999,990.00')
        using errcode = 'P0071';
    end if;
    -- A released live line must have its release JE in the books, or the
    -- standalone credit to 1100 would clear AR that was never booked.  [CR-6]
    if exists (
      select 1 from public.test_requests tr
       where tr.visit_id = p_visit_id and tr.deleted_at is null and tr.parent_id is null
         and tr.status = 'released' and coalesce(tr.final_price_php, 0) > 0
         and not exists (select 1 from public.journal_entries je
                          where je.source_kind = 'test_request' and je.source_id = tr.id and je.status = 'posted')
    ) then
      raise exception 'A released line on this visit has no journal entry; reconcile the books before waiving.'
        using errcode = 'P0071';
    end if;

    -- Largest remainder in centavos.
    drop table if exists tmp_waiver_alloc;
    create temp table tmp_waiver_alloc on commit drop as
      select tr.id as test_request_id,
             (v_rem_c * round(tr.final_price_php * 100)::bigint) / v_sum_c as share_c,
             (v_rem_c * round(tr.final_price_php * 100)::bigint) % v_sum_c as frac,
             case when s.kind in ('doctor_consultation', 'doctor_procedure') then '4920' else '4910' end as acct,
             tr.status
        from public.test_requests tr
        join public.services s on s.id = tr.service_id
       where tr.visit_id = p_visit_id and tr.deleted_at is null and tr.status <> 'cancelled'
         and tr.parent_id is null and coalesce(tr.final_price_php, 0) > 0;

    select v_rem_c - coalesce(sum(share_c), 0) into v_left from tmp_waiver_alloc;
    update tmp_waiver_alloc t
       set share_c = t.share_c + 1
      from (select test_request_id from tmp_waiver_alloc order by frac desc, test_request_id limit v_left) x
     where x.test_request_id = t.test_request_id;

    insert into public.visit_waiver_allocations (visit_id, test_request_id, amount_php, discount_account)
    select p_visit_id, test_request_id, share_c / 100.0, acct
      from tmp_waiver_alloc
     where share_c > 0;
    get diagnostics v_n = row_count;

    -- Lines already released: their AR is booked, clear it now. This is
    -- OUTSIDE any exception handler: a closed month (P0002) rolls the whole
    -- waive back.  [CR-8]
    for r in
      select wa.id
        from public.visit_waiver_allocations wa
        join tmp_waiver_alloc t on t.test_request_id = wa.test_request_id
       where t.status = 'released'
    loop
      perform public.waiver_post_allocation(r.id, p_actor_id);
      v_posted := v_posted + 1;
    end loop;
  end if;

  perform set_config('app.waive_visit', 'on', true);
  update public.visits
     set payment_status = 'waived',
         waived_php     = v_rem_c / 100.0,
         waived_at      = now(),
         waived_by      = p_actor_id,
         waive_reason   = btrim(p_reason)
   where id = p_visit_id;
  -- Package headers whose components are all done auto-release inside that
  -- UPDATE (0109 Leg B, tg_release_headers_on_visit_paid) and fold their
  -- share. That path catches every error by design — including P0002 in a
  -- closed month — and leaves the header ready_for_release with a
  -- test_request.header_auto_release_failed audit row; the share folds when
  -- the header is released by hand later.  [CR-8]
  perform set_config('app.waive_visit', 'off', true);

  return jsonb_build_object(
    'waived_php',      v_rem_c / 100.0,
    'allocations',     v_n,
    'posted_now',      v_posted,
    'legacy',          v_all_legacy,
    'previous_status', v_visit.payment_status,
    'headers_pending', (select count(*) from public.test_requests
                         where visit_id = p_visit_id and is_package_header
                           and status = 'ready_for_release' and deleted_at is null)
  );
end;
$$;

comment on function public.waive_visit_balance(uuid, uuid, text) is
  'Admin waives a visit balance (0183): fixes the remainder, allocates it per line (largest remainder), posts the discount JE for lines already released, folds the rest into later release JEs. Refusals raise P0071.';

-- ---- Fold the share into a later release JE ---------------------------------
-- COPY the whole body of bridge_test_request_released() from 0159 (the latest
-- definition; 0180 only added a comment) and apply exactly these edits:
--
--   (a) declare block — add:
--         v_waived           numeric(10,2) := 0;
--         v_waived_account   text;
--   (b) right after the idempotency check (`if exists (... status = 'posted') then return new; end if;`) — add:
--         -- 0183: a waived visit's share for this line, not yet in the books.
--         select amount_php, discount_account into v_waived, v_waived_account
--           from public.visit_waiver_allocations
--          where test_request_id = new.id and recognised_at is null
--          for update;
--         v_waived := coalesce(v_waived, 0);
--   (c) BOTH "DR: receivable for final_price_php" inserts — change the guard
--       and the amount from `new.final_price_php` to `new.final_price_php - v_waived`:
--         if coalesce(new.final_price_php, 0) - v_waived > 0 then
--           ... values (v_je_id, public.coa_uuid_for_code(v_cash_account), new.final_price_php - v_waived, 0, v_line_order, 'Release receivable');
--   (d) right after the "Discount line (DR contra-revenue)" block — add:
--         -- 0183: the waived share as a discount, folded into this JE.
--         if v_waived > 0 then
--           insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order, description)
--           values (v_je_id, public.coa_uuid_for_code(v_waived_account), v_waived, 0, v_line_order, 'Balance waived');
--           v_line_order := v_line_order + 1;
--           update public.visit_waiver_allocations
--              set recognised_at = now(), journal_entry_id = v_je_id
--            where test_request_id = new.id;
--         end if;
--   Keep the legacy early return, the parent_id return, P0034, the PF lines,
--   the suspense audit and the ACL restatement exactly as in 0159.
create or replace function public.bridge_test_request_released()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
-- <<< paste the 0159 body here with edits (a)–(d) >>>
$function$;

revoke execute on function public.bridge_test_request_released() from public, anon, authenticated;
grant  execute on function public.bridge_test_request_released() to service_role;

-- ---- Undo-release: reverse the share with the line ---------------------------
-- COPY fn_undo_release_bridge() from 0166 (line 140 — the cogs-free body) and
-- add ONE line immediately after the `end if;` that closes
-- `if v_original_je is not null then`, before the doctor_pf_entries void:  [CR-1]
--         -- 0183: a standalone waiver JE for this line is reversed too; a folded share went with the JE above.
--         perform public.waiver_unrecognise_line(new.id, v_actor, 'release undone');
create or replace function public.fn_undo_release_bridge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- <<< paste the 0166 body here with the one added line >>>
$$;

revoke execute on function public.fn_undo_release_bridge() from public, anon, authenticated;
grant  execute on function public.fn_undo_release_bridge() to service_role;

-- ---- Cancel: same hook --------------------------------------------------------
-- COPY bridge_test_request_cancelled() from 0166 (line 29) and add ONE line
-- immediately after `v_actor := auth.uid();`:  [CR-1]
--         perform public.waiver_unrecognise_line(new.id, v_actor, 'test request cancelled');
create or replace function public.bridge_test_request_cancelled()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
-- <<< paste the 0166 body here with the one added line >>>
$function$;

revoke execute on function public.bridge_test_request_cancelled() from public, anon, authenticated;
grant  execute on function public.bridge_test_request_cancelled() to service_role;

-- ---- correct_payment: the equal-amount exception ------------------------------
-- COPY correct_payment from 0174 (lines 48–187, same signature). Add to the
-- declare block:
--         v_src_status text;
--         v_tgt_status text;
-- Add this block immediately BEFORE the comment
-- `-- Reference / notes only: not a money change, edit in place.`:
--         -- 0183: a waived visit's money is fixed. Lock order payment → visit,
--         -- the same as the insert path (guard_payment_on_waived_visit).
--         select payment_status into v_src_status from public.visits where id = v_old.visit_id for update;
--         if v_moving then
--           select payment_status into v_tgt_status from public.visits where id = v_target for update;
--           if v_tgt_status = 'waived' then
--             raise exception 'That visit''s balance was waived, so no payment can be moved onto it.' using errcode = 'P0070';
--           end if;
--         end if;
--         if v_src_status = 'waived' then
--           if v_moving then
--             raise exception 'This visit''s balance was waived, so its payments cannot be moved.' using errcode = 'P0070';
--           end if;
--           if p_amount_php <> v_old.amount_php then
--             raise exception 'This visit''s balance was waived, so the amount is fixed. Change only the method, reference or notes.'
--               using errcode = 'P0070';
--           end if;
--         end if;
-- Then wrap ONLY the proven replacement — the flag is set right before the
-- insert and cleared right after the void; the in-place (reference/notes)
-- branch returns before it is ever set:  [CR-3]
--         if v_src_status = 'waived' then
--           perform set_config('app.waived_visit_edit', 'on', true);
--         end if;
--         insert into public.payments ( ... ) values ( ... ) returning id into v_new_id;
--         update public.payments set voided_at = now(), voided_by = p_actor_id, void_reason = ... where id = p_payment_id;
--         perform set_config('app.waived_visit_edit', 'off', true);
--         return v_new_id;
create or replace function public.correct_payment(
  p_payment_id       uuid,
  p_amount_php       numeric,
  p_method           text,
  p_reference_number text,
  p_notes            text,
  p_reason           text,
  p_actor_id         uuid,
  p_visit_id         uuid default null,
  p_expected         jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
-- <<< paste the 0174 body here with the added declarations, block and flag scoping >>>
$$;

comment on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb) is
  'Edit / Move a payment (0161, stale guard 0174, waived-visit rule 0183): re-create then void in one transaction; reference/notes-only edits in place. On a waived visit only an equal-amount replacement is allowed (P0070). p_expected = the payment as the caller saw it; any difference is refused (P0054).';

-- ---- ACLs (0119: new functions are service_role-only; restated by name —
-- hosted Supabase also grants anon/authenticated by default)
revoke execute on function public.guard_visit_waived_transition()             from public, anon, authenticated;
revoke execute on function public.guard_payment_on_waived_visit()             from public, anon, authenticated;
revoke execute on function public.guard_test_request_on_waived_visit()        from public, anon, authenticated;
revoke execute on function public.waiver_post_allocation(uuid, uuid)          from public, anon, authenticated;
revoke execute on function public.waiver_unrecognise_line(uuid, uuid, text)   from public, anon, authenticated;
revoke execute on function public.waive_visit_balance(uuid, uuid, text)       from public, anon, authenticated;
grant  execute on function public.guard_visit_waived_transition()             to service_role;
grant  execute on function public.guard_payment_on_waived_visit()             to service_role;
grant  execute on function public.guard_test_request_on_waived_visit()        to service_role;
grant  execute on function public.waiver_post_allocation(uuid, uuid)          to service_role;
grant  execute on function public.waiver_unrecognise_line(uuid, uuid, text)   to service_role;
grant  execute on function public.waive_visit_balance(uuid, uuid, text)       to service_role;
revoke execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)
  to service_role;
```

- [ ] **Step 2: Paste the four bodies.** For each `<<< paste … >>>` marker open the source migration, copy the body between `as $function$`/`as $$` and the closing `$function$;`/`$$;`, paste, then make ONLY the listed edits. Diff-check each: `diff <(awk '/create or replace function public.fn_undo_release_bridge/,/^\$\$;/' supabase/migrations/0166_drop_send_out_accrual_tables.sql) <(awk '/create or replace function public.fn_undo_release_bridge/,/^\$\$;/' supabase/migrations/0183_waived_balance_gl.sql)` shows only the added `perform` line; same for `bridge_test_request_cancelled` (0166), `bridge_test_request_released` (0159, edits a–d) and `correct_payment` (0174, the block + declarations + flag scoping).

- [ ] **Step 3: Mirror the table grants in `supabase/seed.sql`** (append at the tail; `seed-grant-parity.test.ts` fails otherwise):

```sql

-- 0183: visit_waiver_allocations is read-only for reception/admin; writes come
-- from waive_visit_balance() and the bridges (service_role / triggers).
revoke all on public.visit_waiver_allocations from anon;
revoke all on public.visit_waiver_allocations from authenticated;
grant select on public.visit_waiver_allocations to authenticated;
```

- [ ] **Step 4: Commit** only after Task 3's pin test passes: `git add supabase/migrations/0183_waived_balance_gl.sql supabase/seed.sql && git commit -m "feat(accounting): 0183 waived balance → discount JE, per-line allocation, waived-visit guards"`

---

### Task 3: Pin the migration SQL in a unit test

**Files:**
- Test: `src/lib/accounting/waived-balance-gl.test.ts`

- [ ] **Step 1: Write the test** (money-settled.test.ts pattern: read the file, assert the load-bearing text)

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0183_waived_balance_gl.sql"), "utf8");
const fn = (name: string) => {
  const m = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$(?:function)?\\$;`));
  if (!m) throw new Error(`${name} not defined in 0183`);
  return m[0];
};

describe("migration 0183 — waived balance GL bridge", () => {
  it("asserts zero waived visits under a table lock before changing anything", () => {
    expect(sql).toMatch(/lock table public\.visits in share row exclusive mode;[\s\S]*?payment_status = 'waived'[\s\S]*?raise exception 'STOP 0183/);
    expect(sql.indexOf("STOP 0183")).toBeLessThan(sql.indexOf("add value if not exists 'visit_waiver'"));
  });

  it("adds the source kind, the visit columns and the allocation table", () => {
    expect(sql).toMatch(/alter type public\.je_source_kind add value if not exists 'visit_waiver'/);
    expect(sql).toMatch(/add column if not exists waived_php\s+numeric\(10,2\)/);
    expect(sql).toMatch(/create table if not exists public\.visit_waiver_allocations/);
    expect(sql).toMatch(/discount_account text not null check \(discount_account in \('4910', '4920'\)\)/);
    expect(sql).toMatch(/unique \(test_request_id\)/);
  });

  it("guards INSERT and UPDATE into 'waived', never out of it, and freezes the visit's money fields (P0069)", () => {
    const g = fn("guard_visit_waived_transition");
    expect(g).toMatch(/if tg_op = 'INSERT' then[\s\S]*?errcode = 'P0069'/);
    expect(g).toMatch(/current_setting\('app\.waive_visit', true\)/);
    expect(g).toMatch(/cannot be un-waived/);
    expect(g).toMatch(/new\.total_php\s+is distinct from old\.total_php/);
    expect(sql).toMatch(/before insert or update of payment_status, total_php, hmo_provider_id, legacy_import_run_id,\s*waived_php, waived_at, waived_by, waive_reason\s*on public\.visits/);
  });

  it("the payment guard covers insert, void, money-bearing update and hard delete, both visits, visit lock first", () => {
    const g = fn("guard_payment_on_waived_visit");
    expect(g).toMatch(/new\.amount_php\s+is distinct from old\.amount_php/);
    expect(g).toMatch(/unnest\(array\[old\.visit_id, new\.visit_id\]\)/);
    expect(g).toMatch(/tg_op = 'DELETE'/);
    expect(g).toMatch(/from public\.visits where id = v_id for update/);
    expect(g).toMatch(/current_setting\('app\.waived_visit_edit', true\)/);
    expect(g).toMatch(/errcode = 'P0070'/);
    expect(sql).toMatch(/before insert or update or delete on public\.payments/);
  });

  it("the line guard freezes inserts, restores, reprices, reparents and moves on a waived visit", () => {
    const g = fn("guard_test_request_on_waived_visit");
    expect(g).toMatch(/old\.deleted_at is not null and new\.deleted_at is null/);
    expect(g).toMatch(/new\.final_price_php\s+is distinct from old\.final_price_php/);
    expect(g).toMatch(/errcode = 'P0070'/);
    expect(sql).toMatch(/before insert or update of deleted_at, final_price_php, base_price_php, discount_amount_php,\s*clinic_fee_php, doctor_pf_php, parent_id, service_id, visit_id, is_package_header\s*on public\.test_requests/);
  });

  it("waive_visit_balance: visit lock then line locks, admin only, provenance, exact reconciliation, gift codes in flight", () => {
    const w = fn("waive_visit_balance");
    expect(w).toMatch(/select \* into v_visit from public\.visits where id = p_visit_id for update;/);
    expect(w).toMatch(/for update;[\s\S]*?perform 1 from public\.test_requests where visit_id = p_visit_id and deleted_at is null order by id for update;/);
    expect(w).not.toMatch(/from public\.payments[\s\S]*?for update/);
    expect(w).toMatch(/v_role is distinct from 'admin'/);
    expect(w).toMatch(/mixes imported and live rows/);
    expect(w).toMatch(/if v_total_c <> v_sum_c then/);
    expect(w).toMatch(/has no journal entry; reconcile/);
    expect(w).toMatch(/redeemed_payment_id = p\.id/);
    expect(w).toMatch(/order by frac desc, test_request_id limit v_left/);
    expect(w).toMatch(/parent_id is null and coalesce\(tr\.final_price_php, 0\) > 0/);
    expect(w).toMatch(/when s\.kind in \('doctor_consultation', 'doctor_procedure'\) then '4920' else '4910'/);
    expect(w).toMatch(/where t\.status = 'released'[\s\S]*?perform public\.waiver_post_allocation\(r\.id, p_actor_id\)/);
    expect(w).toMatch(/set_config\('app\.waive_visit', 'on', true\)/);
    expect(w).toMatch(/'headers_pending'/);
    expect(w).toMatch(/errcode = 'P0071'/);
  });

  it("standalone JE: DR discount account / CR 1100, Manila date, idempotent", () => {
    const p = fn("waiver_post_allocation");
    expect(p).toMatch(/coa_uuid_for_code\(a\.discount_account\), a\.amount_php, 0/);
    expect(p).toMatch(/coa_uuid_for_code\('1100'\),\s+0, a\.amount_php/);
    expect(p).toMatch(/\(now\(\) at time zone 'Asia\/Manila'\)::date/);
    expect(p).toMatch(/source_kind = 'visit_waiver'[\s\S]*?status = 'posted'/);
  });

  it("the release bridge folds an unrecognised share and records it", () => {
    const b = fn("bridge_test_request_released");
    expect(b).toMatch(/where test_request_id = new\.id and recognised_at is null/);
    expect(b).toMatch(/new\.final_price_php - v_waived, 0, v_line_order, 'Release receivable'/);
    expect(b).toMatch(/coa_uuid_for_code\(v_waived_account\), v_waived, 0, v_line_order, 'Balance waived'/);
    expect(b).toMatch(/set recognised_at = now\(\), journal_entry_id = v_je_id/);
    expect(b).toMatch(/if NEW\.legacy_import_run_id is not null then\s+return NEW;/);
  });

  it("undo-release and cancel use the 0166 (cogs-free) bodies and take the share back out", () => {
    const u = fn("fn_undo_release_bridge");
    const c = fn("bridge_test_request_cancelled");
    expect(u).toMatch(/waiver_unrecognise_line\(new\.id, v_actor, 'release undone'\)/);
    expect(c).toMatch(/waiver_unrecognise_line\(new\.id, v_actor, 'test request cancelled'\)/);
    expect(u).not.toMatch(/cogs_send_out_entries/);
    expect(c).not.toMatch(/cogs_send_out_entries/);
    const r = fn("waiver_unrecognise_line");
    expect(r).toMatch(/set status = 'reversed', reversed_by = v_rev/);
    expect(r).toMatch(/set recognised_at = null, journal_entry_id = null/);
  });

  it("correct_payment: equal-amount edit only on a waived visit, no move on or off, flag scoped to the replacement", () => {
    const c = fn("correct_payment");
    expect(c).toMatch(/where id = v_old\.visit_id for update/);
    expect(c).toMatch(/cannot be moved\.' using errcode = 'P0070'/);
    expect(c).toMatch(/moved onto it\.' using errcode = 'P0070'/);
    expect(c).toMatch(/amount is fixed[\s\S]*?errcode = 'P0070'/);
    expect(c).toMatch(/set_config\('app\.waived_visit_edit', 'on', true\);\s*end if;\s*insert into public\.payments/);
    expect(c).toMatch(/where id = p_payment_id;\s*perform set_config\('app\.waived_visit_edit', 'off', true\);/);
  });

  it("restates every ACL by name (0118/0119)", () => {
    for (const f of [
      "guard_visit_waived_transition\\(\\)",
      "guard_payment_on_waived_visit\\(\\)",
      "guard_test_request_on_waived_visit\\(\\)",
      "waiver_post_allocation\\(uuid, uuid\\)",
      "waiver_unrecognise_line\\(uuid, uuid, text\\)",
      "waive_visit_balance\\(uuid, uuid, text\\)",
      "bridge_test_request_released\\(\\)",
      "fn_undo_release_bridge\\(\\)",
      "bridge_test_request_cancelled\\(\\)",
    ]) {
      expect(sql).toMatch(new RegExp(`revoke execute on function public\\.${f}\\s+from public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`grant\\s+execute on function public\\.${f}\\s+to service_role;`));
    }
    expect(sql).toMatch(/revoke all on public\.visit_waiver_allocations from authenticated;/);
    expect(sql).toMatch(/grant select on public\.visit_waiver_allocations to authenticated;/);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/accounting/waived-balance-gl.test.ts` — expected 11 passed (fix the SQL, never the assertions, when one fails).
- [ ] **Step 3: Commit** `git add src/lib/accounting/waived-balance-gl.test.ts && git commit -m "test(accounting): pin 0183's waiver bridge SQL"`

---

### Task 4: P-code translations + deadlock + coverage

**Files:**
- Modify: `src/lib/accounting/pg-errors.ts` (after the `P0067` case; `40P01` next to the other standard SQLSTATEs)

- [ ] **Step 1: Add the cases**

```ts
    // 0183 — waived balances
    case "P0069":
      // Entering 'waived' outside waive_visit_balance(), leaving it, or
      // changing a waived visit's total / billing / waiver record.
      return err.message ?? "A balance can only be waived with Waive balance on the visit page.";
    case "P0070":
      // Money or bill lines on a waived visit. Several messages, all written
      // for staff — pass them through.
      return err.message ?? "This visit's balance was waived, so its payments and lines are fixed.";
    case "P0071":
      // waive_visit_balance refusals (not admin, HMO, already waived/paid,
      // mixed provenance, total out of step, gift code in flight …).
      return err.message ?? "This visit's balance cannot be waived.";
    case "40P01":
      // deadlock_detected — the 0183 serialization protocol accepts one rare
      // cycle (waiver vs. an undo cascade) and lets Postgres abort one side.
      return "Something else changed this visit at the same moment. Try again.";
```

- [ ] **Step 2: Run** `npx vitest run src/lib/accounting/pg-error-coverage.test.ts src/lib/accounting/pg-errors.test.ts` — expected pass.
- [ ] **Step 3: Commit** `git add src/lib/accounting/pg-errors.ts && git commit -m "feat(accounting): translate P0069–P0071 and 40P01 (waived balance)"`

---

### Task 5: Register the posted-only readers

**Files:**
- Modify: `src/lib/accounting/ledger-status-sql.test.ts` — `SQL_LOOKUPS` (after `"function:bridge_test_request_released"`)

- [ ] **Step 1: Add**

```ts
  "function:waiver_post_allocation":
    "Idempotency: one live standalone waiver JE per allocation (0183).",
  "function:waiver_unrecognise_line":
    "Finds the live standalone waiver JE to reverse on undo-release / cancel; a reversed one must not be reversed twice (0183).",
```
(`waive_visit_balance` reads `journal_entries` once for the released-line check — posted-only on purpose: "does this line's live release JE exist"; register it too:)
```ts
  "function:waive_visit_balance":
    "Refuses to waive when a released live line has no live release JE (0183) — an existence lookup, not a total.",
```
and add the matching `comment on function public.waive_visit_balance(uuid, uuid, text) is …` text in the migration: append " Posted-only journal read on purpose: existence of a released line's live release JE (LEDGER_TOTAL_STATUSES, ledger-status-sql.test.ts SQL_LOOKUPS)." to the comment written in Task 2.

- [ ] **Step 2: Run** `npx vitest run src/lib/accounting/ledger-status-sql.test.ts src/lib/accounting/ledger-status.test.ts` — expected pass. If it reports the guards as journal readers they are not (they read `visits`/`payments` only) — fix the SQL, not the allowlist.
- [ ] **Step 3: Commit** `git add src/lib/accounting/ledger-status-sql.test.ts supabase/migrations/0183_waived_balance_gl.sql && git commit -m "test(accounting): register 0183's posted-only lookups"`

---

### Task 6: GL smoke (single session)

**Files:**
- Create: `supabase/tests/0183_waived_balance_gl_smoke.sql`

- [ ] **Step 1: Write it** in the 0174 shape: header comment, `begin;`, one `do $$ … $$;` per case group, every case ending in explicit `if … then raise exception 'FAIL: <case> …'; end if;` checks and `raise notice 'PASS <case>';`, refusals caught with nested `begin … exception when others then if sqlstate <> '<code>' then raise; end if; end;`. Seed inside the do-block: an admin `auth.users` + `staff_profiles` row (`role = 'admin'`), a medtech pair, a patient, a lab service (₱500, `lab_test`), a consult service (₱800, `doctor_consultation`) with a physician, a package service (₱5,888, `lab_package`) with 8 `lab_test` components and `package_components` rows. Journal amounts are checked by CoA code via `join chart_of_accounts c on c.id = l.account_id where c.code = '…'`. The runner is `psql "$APP" -v ON_ERROR_STOP=1 -f …` (the file ends without `commit`, so it rolls back).

```
A  Guards vs a NON-ADMIN staff JWT [CR-2]:
     set local role authenticated;
     select set_config('request.jwt.claims', '{"sub":"<medtech uuid>","role":"authenticated"}', true);
   — insert a visit with payment_status='waived' → P0069; update an unpaid visit to 'waived' → P0069;
   update a waived visit to 'unpaid' → P0069; update total_php on a waived visit → P0069.  `reset role;`
B  Live visit, lab 500 + consult 800 (total 1300), paid 300, nothing released: waive → 'waived',
   waived_php 1000, allocations 384.62 (4910) + 615.38 (4920) summing to 1000, recognised_at null,
   no visit_waiver JE. Release lab → JE: DR 1100 115.38, DR 4910 384.62, CR 4100 500; allocation
   recognised, journal_entry_id = JE. Release consult → DR 1100 184.62, DR 4920 615.38, CR 4200 300,
   CR 2110 500. 1100 net over the visit's entries (status in ('posted','reversed')) = 0.
C  Undo-release of the lab line → release JE 'reversed' + mirrored 'posted' reversal, allocation
   recognised_at null; re-release folds again; 1100 net unchanged.
C2 Cancel the consult (released → cancelled) → its JE reversed, allocation unrecognised, no
   visit_waiver JE; 1100 net still 0 for that line.
D  Already-released line at waive time: lab 500 released while paid 500, payment voided (allowed —
   not yet waived), waive → visit_waiver JE DR 4910 500 / CR 1100 500 posted, allocation recognised.
   Undo-release → that JE reversed (pair), allocation unrecognised. A second such visit: cancel instead
   of undo → same outcome.
E  P0070 on visit B: insert a payment; void the 300 payment; `delete from payments` (hard delete);
   `update payments set amount_php = 250`; `update payments set visit_id = <other>`; correct_payment
   with a different amount; correct_payment moving B's payment off; moving an unpaid visit's payment
   onto B — all P0070. correct_payment same amount, method gcash → OK: replacement row exists,
   original 'Edited: …', visit still 'waived', paid_php 300.
F  Provenance: all-imported visit (visit, line and payment carry legacy_import_run_id) waives with
   waived_php set, 0 allocations, 0 JEs; a mixed visit (imported visit, live line) → P0071.
G  Refusals: HMO visit → P0071; paid visit → P0071; non-admin actor → P0071; blank reason → P0071;
   already waived → P0071.
H  Largest remainder [CR-9]: three ₱500 lab lines (total 1500), paid 500 → remainder 1000 →
   333.34 / 333.33 / 333.33, the extra centavo on the lowest test_request id; a package visit
   (header 5888 + 8 ₱0 components, total 5888, unpaid) → one allocation of 5888 on the header only.
I  Closed month: close the current period the way 0028's smoke does; waive a visit with a released
   line → P0002 and NOTHING written (payment_status unchanged, no allocation rows); reopen.
J  Package header auto-release on waive (Leg B): components released, header ready_for_release →
   the header releases inside the waive statement with the share folded (recognised,
   journal_entry_id = header JE); RPC result headers_pending = 0.
J2 Same with the period closed [CR-8]: waive succeeds (nothing standalone to post); header stays
   ready_for_release; a test_request.header_auto_release_failed audit row exists with sqlstate
   'P0002'; allocation unrecognised; RPC result headers_pending = 1. Reopen the period, release the
   header by hand → folded.
K  Ordinary never-waived visit [CR-1]: release, undo, re-release, cancel all still post/reverse as
   before (no allocation rows are touched, no error).
L  Line freeze on a waived visit [CR-4]: insert a new line → P0070; restore a line deleted BEFORE the
   waive → P0070; `update test_requests set final_price_php = …` → P0070; `set parent_id` and
   `set visit_id` → P0070; release / undo of an existing line still allowed.
M  Reconciliation [CR-6]: total_php 500 with a ₱1,000 line → P0071 (message names ₱500.00 and
   ₱1,000.00); total 1500 with ₱1,000 of lines → P0071; a released live line with no posted JE
   (delete its JE rows under session_replication_role = replica) → P0071.
N  Gift code in flight [CR-7]: a non-voided gift_code payment with no gift_codes.redeemed_payment_id
   pointing at it → waive refused P0071; link the voucher → waive proceeds.
```

- [ ] **Step 2: Run** (after Task 8 applies 0183): `/opt/homebrew/opt/libpq/bin/psql "$APP" -v ON_ERROR_STOP=1 -f supabase/tests/0183_waived_balance_gl_smoke.sql 2>&1 | grep -E "PASS|FAIL|ERROR"` — expected `PASS A` … `PASS N`, then `ROLLBACK`.
- [ ] **Step 3: Commit** `git add supabase/tests/0183_waived_balance_gl_smoke.sql && git commit -m "test(sql): 0183 waived balance GL smoke A–N"`

---

### Task 7: Two-session race smoke (dblink, `supabase_admin`, local only) `[CR-5, CR-10]`

**Files:**
- Create: `supabase/tests/0183_waiver_race_smoke.sql`

- [ ] **Step 1: Write it.** Header: LOCAL ONLY — opens extra connections through `dblink` as `supabase_admin`; run with `psql "$ADMIN" -v ON_ERROR_STOP=1 -f supabase/tests/0183_waiver_race_smoke.sql`. First statement refuses anything that is not the local container: `do $$ begin if host(inet_server_addr()) not like '172.%' and host(inet_server_addr()) not like '127.%' then raise exception 'local only'; end if; end $$;`

Mechanics:
- `create extension if not exists dblink;` then `dblink_connect('s0', c)`, `('s1', c)`, `('s2', c)` with `c := 'dbname=postgres user=supabase_admin password=postgres host=localhost port=5432'`.
- Seed through `dblink_exec('s0', …)` in FK order (auth.users → staff_profiles → patients → services → visits → test_requests) so the rows are COMMITTED and visible to the workers; capture ids as literals built with `format(%L)`.
- Row-returning statements go through `dblink(conn, sql) as t(x text)`; `dblink_exec` is only for `begin`/`commit`/`rollback`/DML without RETURNING.
- Async: `dblink_send_query(w, sql)`; then a bounded lock-wait check — read the worker's pid once at connect time (`select x from dblink(w, 'select pg_backend_pid()') as t(x int)`) and loop up to 20 × 0.25 s until `exists (select 1 from pg_stat_activity where pid = <pid> and wait_event_type = 'Lock')`, else `raise exception 'FAIL n: worker never waited on the lock'`. After releasing the blocker, drain with `perform * from dblink_get_result(w) as t(x text)` (twice: result then end-of-results), catching the remote error's SQLSTATE where a refusal is expected (`exception when others then if sqlstate <> 'P0070' then raise; end if;`).
- Teardown (at the end AND inside `exception when others then … raise;`): for each worker `perform dblink_cancel_query(w)`, `perform dblink_exec(w, 'rollback')` inside its own `begin … exception when others then null; end`, `perform dblink_disconnect(w)`; then via `s0`: `set session_replication_role = replica` and delete journal_lines → journal_entries (by allocation ids and payment ids of the seeded visits) → visit_waiver_allocations → payments → test_requests → visits → patients → staff_profiles → auth.users; `dblink_disconnect('s0')`.

Scenarios (fresh ₱1,000 `lab_test` visit each, `total_php = 1000`, unpaid; actor = the seeded admin):
```
1 payment-then-waive: s1 `begin` + insert payment 400 (holds the visit lock via recalc) → s2 send
  waive → lock wait seen → s1 `commit` → s2 result: visits.waived_php 600, payment_status 'waived',
  sum(allocations) 600.
2 waive-then-payment: s1 `begin` + waive (uncommitted) → s2 send insert payment 400 → lock wait
  seen → s1 `commit` → s2 raises P0070; no new payment row.
3 undo-then-waive: prepare — pay 1000 (paid), release the line (JE posted), void the payment
  (allowed: not waived; visit unpaid). s1 `begin` + `update test_requests set status =
  'ready_for_release', released_at = null, released_by = null, release_medium = null where id = …`
  (holds the line lock; fn_undo_release_bridge reversed the release JE) → s2 send waive → lock wait
  seen → s1 `commit` → s2 result: allocation for the line has recognised_at null and NO
  visit_waiver JE exists (the waiver read the final status ready_for_release).
4 waive-then-undo: same preparation on a fresh visit; s1 `begin` + waive (standalone JE posted,
  uncommitted) → s2 send the same undo UPDATE → lock wait seen → s1 `commit` → s2 succeeds: the
  visit_waiver JE is 'reversed' with a mirrored 'posted' reversal, allocation unrecognised.
```

- [ ] **Step 2: Run** `psql "$ADMIN" -v ON_ERROR_STOP=1 -f supabase/tests/0183_waiver_race_smoke.sql 2>&1 | grep -E "PASS|FAIL|ERROR"` — expected `PASS 1` … `PASS 4`; afterwards `select count(*) from visit_waiver_allocations` equals the count before the run.
- [ ] **Step 3: Commit** `git add supabase/tests/0183_waiver_race_smoke.sql && git commit -m "test(sql): 0183 two-session waiver races (dblink, local only)"`

---

### Task 8: Apply 0183 locally by hand, replay gate, regenerate types

- [ ] **Step 1: Check the local ledger** `psql "$APP" -Atc "select max(version) from supabase_migrations.schema_migrations; select version from supabase_migrations.schema_migrations where version in ('0178','0180','0181','0183')"`. Apply whichever of 0178, 0180, 0181 are missing first (all on main), each as a file `begin; <migration>; insert into supabase_migrations.schema_migrations (version, name, statements) values ('NNNN','<name>', array['applied by hand (local)']); commit;` via `psql "$APP" -v ON_ERROR_STOP=1 -f`. Never `migration repair`.
- [ ] **Step 2: Apply 0183 the same way.** Expected `COMMIT`. If the zero-waiver assertion fires, the shared stack holds leftover waived test rows — find them (`select id, visit_number from visits where payment_status = 'waived'`), delete them with `session_replication_role = replica` in FK order, and re-run. Verify: `select proname from pg_proc where proname in ('waive_visit_balance','waiver_post_allocation','waiver_unrecognise_line','guard_visit_waived_transition','guard_payment_on_waived_visit','guard_test_request_on_waived_visit')` → 6 rows; `select tgname from pg_trigger where tgname in ('trg_visits_waived_transition_guard','trg_payments_waived_visit_guard','trg_test_requests_waived_visit_guard')` → 3.
- [ ] **Step 3: Fresh-replay gate without resetting the shared stack** (Codex validation gap). Create a scratch database from the stack's template and replay the whole migration set plus `seed.sql` into it:
  ```bash
  psql "$ADMIN" -c "create database replay_0183 template template0"
  R="postgresql://supabase_admin:postgres@127.0.0.1:54322/replay_0183"
  # the Supabase image's auth/extensions/storage schemas are not in template0; take them from the live db:
  /opt/homebrew/opt/libpq/bin/pg_dump "$ADMIN" --schema-only --schema=auth --schema=extensions --schema=storage --schema=supabase_migrations --no-owner | psql "$R" -q
  for f in supabase/migrations/*.sql; do psql "$R" -v ON_ERROR_STOP=1 -q -f "$f" > /dev/null || { echo "REPLAY FAILED at $f"; break; }; done
  psql "$R" -v ON_ERROR_STOP=1 -q -f supabase/seed.sql && echo "REPLAY OK"
  psql "$ADMIN" -c "drop database replay_0183"
  ```
  Expected `REPLAY OK`. If the auth-schema dump is not enough for the earliest migrations, fall back to asking the owner for one `supabase db reset` from this worktree (wait until `pgrep -f "supabase db reset"` is quiet; it wipes the shared local data) and record in the PR body which path proved the replay.
- [ ] **Step 4: Run Tasks 6 and 7's smokes.** Both must pass before continuing.
- [ ] **Step 5: Regenerate types** `npm run db:types`; `git diff --stat src/types/database.ts`. Keep the hunks for `visit_waiver_allocations`, the four `visits` columns and `waive_visit_balance`; revert hunks that belong to other sessions' local-only migrations (`git add -p`).
- [ ] **Step 6:** `npm run typecheck` — clean. **Commit** `git add src/types/database.ts && git commit -m "chore(types): 0183 waiver objects"`.

---

### Task 9: Stop the direct `'waived'` writes in existing smokes

**Files:**
- Modify: `scripts/smoke-14-d1.sql:59`, `supabase/tests/0167_patient_soft_delete_smoke.sql:475,537,564`, `scripts/smoke-print.ts:263` + its `cleanup()`

- [ ] **Step 1:** In the two SQL files, immediately before each `update public.visits set payment_status = 'waived' …` add:
```sql
  perform set_config('app.waive_visit', 'on', true);  -- 0183 guard: these fixtures set the status directly
```
- [ ] **Step 2:** In `scripts/smoke-print.ts` replace line 263 with the RPC (the seeded staff is an admin):
```ts
  await q("update visits set total_php = 550 where id = $1", [s.waivedVisitId]);
  await q("select public.waive_visit_balance($1, $2, 'smoke: charity')", [s.waivedVisitId, staffId]);
```
and in `cleanup()` — BEFORE the payments/visits deletes — add the allocation entries and rows:
```ts
  await q(
    `delete from journal_lines where entry_id in (
       select id from journal_entries where source_kind = 'visit_waiver'
          and source_id in (select id from visit_waiver_allocations where visit_id = any($1::uuid[])))`,
    [visitIds],
  );
  await q(
    `delete from journal_entries where source_kind = 'visit_waiver'
        and source_id in (select id from visit_waiver_allocations where visit_id = any($1::uuid[]))`,
    [visitIds],
  );
  await q("delete from visit_waiver_allocations where visit_id = any($1::uuid[])", [visitIds]);
```
- [ ] **Step 3:** `psql "$APP" -v ON_ERROR_STOP=1 -f supabase/tests/0167_patient_soft_delete_smoke.sql 2>&1 | grep -E "PASS|FAIL|ERROR"` — all PASS.
- [ ] **Step 4: Commit** `git add scripts/smoke-14-d1.sql supabase/tests/0167_patient_soft_delete_smoke.sql scripts/smoke-print.ts && git commit -m "test: waive through the RPC / GUC now that 0183 guards the status"`

---

### Task 10: `waiveVisitBalanceAction` → RPC

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts` (`waiveVisitBalanceAction`)
- Modify: `src/lib/visits/payment-edit.ts` (add `WAIVE_CLOSED_MONTH_MESSAGE`)
- Test: `src/lib/visits/payment-leaves.test.ts`

- [ ] **Step 1: Add the message** to `payment-edit.ts` next to `CLOSED_MONTH_MESSAGE`, and one assertion in `payment-leaves.test.ts`: `expect(WAIVE_CLOSED_MONTH_MESSAGE).toMatch(/closed for this month/);`

```ts
/**
 * je_period_lock_check (0029) refuses the waiver's discount entry when a line
 * already released would post into a closed month (0183). Nothing is written
 * in that case — the whole waive rolls back.
 */
export const WAIVE_CLOSED_MONTH_MESSAGE =
  "The books are closed for this month, so the waived amount cannot be booked yet. Ask an admin to reopen the month, then waive the balance.";
```

- [ ] **Step 2: Replace the action body** from `const supabase = await createClient();` to the end with:

```ts
  const admin = createAdminClient();

  // 0167: waiving is a financial change — refuse it on an inactive record.
  const active = await assertVisitPatientActive(admin, visitId);
  if (!active.ok) return { ok: false, error: active.error };

  // 0183: the RPC owns every rule (admin actor, non-HMO, unpaid/partial,
  // provenance, the per-line split, the discount JE) under the visit + line
  // row locks, and raises P0071 with a staff-readable message per refusal.
  const { data, error } = await admin.rpc("waive_visit_balance", {
    p_visit_id: visitId,
    p_actor_id: session.user_id,
    p_reason: parsed.data.reason,
  });
  if (error) {
    revalidatePath(`/staff/visits/${visitId}`);
    return {
      ok: false,
      error: error.code === "P0002" ? WAIVE_CLOSED_MONTH_MESSAGE : translatePgError(error),
    };
  }
  const result = (data ?? {}) as {
    waived_php?: number;
    allocations?: number;
    posted_now?: number;
    legacy?: boolean;
    previous_status?: string;
    headers_pending?: number;
  };

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payment.waived",
    resource_type: "visit",
    resource_id: visitId,
    metadata: {
      reason: parsed.data.reason,
      previous_status: result.previous_status ?? null,
      balance_waived_php: result.waived_php ?? null,
      // 0183: how the remainder reached the books.
      allocations: result.allocations ?? 0,
      posted_now: result.posted_now ?? 0,
      legacy: result.legacy ?? false,
      // A package header the waive could not auto-release (closed month):
      // it stays ready_for_release and folds when released by hand.
      headers_pending: result.headers_pending ?? 0,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
```
Delete the now-unused pre-checks (the `supabase.from("visits").select(...)` read and the four `if` refusals) — the RPC repeats them with the same wording. Keep `WaiveBalanceSchema` parsing and `requireAdminStaff()`. Import `WAIVE_CLOSED_MONTH_MESSAGE` from `@/lib/visits/payment-edit`. Rewrite the doc-comment above the function: "Setting payment_status = 'waived' happens inside waive_visit_balance() (0183), which also fixes the waiver, allocates it per line, books the discount and clears 1100; the P0069/P0070 guards then freeze the visit's money and lines."

- [ ] **Step 3:** `npm run typecheck` — clean. `npx vitest run src/lib/visits/query-surfaces.test.ts src/lib/visits/payment-leaves.test.ts` — pass (if `query-surfaces` reports a stale `LIFECYCLES` entry for this file because the visits read went away, remove that entry).
- [ ] **Step 4: Commit** `git add -A && git commit -m "feat(visits): waive balance through waive_visit_balance (0183)"`

---

### Task 11: Waive dialog preview

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/waive-balance-dialog.tsx`, `page.tsx` (the `<WaiveBalanceDialog` call at ~line 862)

- [ ] **Step 1:** Add props `preview: { labPhp: number; doctorPhp: number; lines: number } | null` and `legacy: boolean`. Under the existing "Waiving {balanceLabel}…" description render (copy does not overclaim — imported visits post nothing; unreleased shares post at release) `[P3]`:

```tsx
{legacy ? (
  <p className="text-xs text-[color:var(--color-brand-text-soft)]" data-testid="waive-preview">
    Imported visit: the books never held this balance, so nothing is posted.
  </p>
) : preview ? (
  <p className="text-xs text-[color:var(--color-brand-text-soft)]" data-testid="waive-preview">
    {formatPhp(preview.labPhp + preview.doctorPhp)} is recorded as a discount as each line is released
    (lines already released: now)
    {preview.doctorPhp > 0 && preview.labPhp > 0
      ? ` — ${formatPhp(preview.labPhp)} on lab tests and ${formatPhp(preview.doctorPhp)} on doctor fees`
      : preview.doctorPhp > 0
        ? " on doctor fees"
        : " on lab tests"}
    , across {preview.lines} line{preview.lines === 1 ? "" : "s"}, and the patient receivable is cleared.
    Nothing is collected. After this, payments and lines on the visit are fixed.
  </p>
) : (
  <p className="text-xs text-amber-800" data-testid="waive-preview">
    This visit&apos;s lines do not add up to its total; fix the lines before waiving.
  </p>
)}
```
Import `formatPhp` from `@/lib/marketing/format`.

- [ ] **Step 2:** In `page.tsx`, build the preview from the lines the page already loads (`test_requests` with `final_price_php, parent_id, status, services ( kind )`; add `legacy_import_run_id` to the visit select if it is not there):

```tsx
import { waiverPreview } from "@/lib/accounting/waiver-allocation";
// …
const waivePreview = (() => {
  if (visit.legacy_import_run_id) return null;
  try {
    return waiverPreview(
      balance,
      liveLines.map((t) => ({
        id: t.id,
        pricePhp: Number(t.final_price_php ?? 0),
        kind: (Array.isArray(t.services) ? t.services[0] : t.services)?.kind,
        isComponent: t.parent_id != null,
        status: t.status,
      })),
    );
  } catch {
    return null;
  }
})();
// …
<WaiveBalanceDialog
  visitId={visit.id}
  balanceLabel={formatPhp(balance > 0 ? balance : 0)}
  preview={waivePreview}
  legacy={visit.legacy_import_run_id != null}
/>
```
(`liveLines` = the page's non-deleted `test_requests`.)

- [ ] **Step 3:** `npm run typecheck && npm run lint`. **Commit** `git commit -am "feat(visits): waive dialog previews the discount split"`.

---

### Task 12: Record payment page + actions refuse a waived visit `[CR-7, P3]`

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/payments/new/page.tsx`, `actions.ts`
- Modify: `src/lib/visits/query-surfaces.test.ts` (`LIFECYCLES` entry for `payments/new/actions.ts`)

- [ ] **Step 1: Page.** Add `legacy_import_run_id` to the visit select. After `const balance = …`, add:

```tsx
import { visitMoneySummary } from "@/lib/visits/statement";
// …
const money = visitMoneySummary(visit);
if (visit.payment_status === "waived") {
  return (
    <div className="mx-auto max-w-xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/staff/visits/${visit.id}`}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Visit #{visit.visit_number}
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Record payment
      </h1>
      <p className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" data-testid="waived-notice">
        {visit.legacy_import_run_id
          ? `The balance on this visit was waived (imported history — nothing was posted to the books).`
          : `The balance on this visit was waived — ${formatPhp(money.waived)} is recorded as a discount as its lines are released, and there is nothing to collect.`}{" "}
        Payments on a waived visit are not accepted.
      </p>
    </div>
  );
}
```
(`visitMoneySummary` takes `total_php, paid_php, payment_status, hmo_provider_id` — all in the select; import `formatPhp` from `@/lib/marketing/format`.)

- [ ] **Step 2: Actions.** In `recordPaymentAction`, after the active-patient check and before the insert:

```ts
  // 0183: a waived visit's money is fixed (the DB refuses too — P0070).
  const { data: v } = await createAdminClient()
    .from("visits")
    .select("payment_status")
    .eq("id", parsed.data.visit_id)
    .maybeSingle();
  if (v?.payment_status === "waived") {
    return { ok: false, error: "This visit's balance was waived, so no payment can be recorded on it." };
  }
```
In `redeemGiftCode`, add `payment_status` to its visit select and the same early return right after that read. At the compensation site (the `voidRedemptionPayment` call after a failed voucher update) add the comment: `// 0183: waive_visit_balance refuses while a gift-code payment has no linked voucher (P0071), so this void can never be blocked by a waive that landed in between.`

- [ ] **Step 3:** Register in `query-surfaces.test.ts` `LIFECYCLES`:
```ts
  "app/(staff)/staff/(dashboard)/payments/new/actions.ts": {
    lifecycle: "any",
    why: "Reads one visit's payment_status by id to refuse a payment on a waived visit (0183). A deleted visit is refused by P0045 either way.",
  },
```
- [ ] **Step 4:** `npx vitest run src/lib/visits/query-surfaces.test.ts` + typecheck. **Commit** `git commit -am "feat(payments): Record payment refuses a waived visit and says the balance was waived"`.

---

### Task 13: Payment dialogs on a waived visit

**Files:**
- Modify: `src/lib/visits/payment-edit.ts`, `src/lib/visits/payment-leaves.test.ts`
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/page.tsx` (~lines 1580–1625), `payments/[id]/edit/edit-payment-dialog.tsx`

- [ ] **Step 1: Failing test** (append to `payment-leaves.test.ts`):

```ts
describe("waivedVisitPaymentRules (0183: money on a waived visit is fixed)", () => {
  it("offers nothing that moves money on a waived visit", () => {
    expect(waivedVisitPaymentRules(visit({ paymentStatus: "waived" }))).toEqual({
      canDelete: false,
      canMove: false,
      amountLocked: true,
      reason: "The balance on this visit was waived, so its payments are fixed. You can still change the method, reference or notes.",
    });
  });
  it("leaves every other visit alone", () => {
    expect(waivedVisitPaymentRules(visit())).toEqual({ canDelete: true, canMove: true, amountLocked: false, reason: null });
  });
});
```
- [ ] **Step 2: Implement** in `payment-edit.ts`:

```ts
/** What the payment dialogs may offer on a waived visit — mirrors 0183's P0070 guard. */
export function waivedVisitPaymentRules(v: Pick<VisitMoney, "paymentStatus">): {
  canDelete: boolean;
  canMove: boolean;
  amountLocked: boolean;
  reason: string | null;
} {
  if (v.paymentStatus !== "waived") return { canDelete: true, canMove: true, amountLocked: false, reason: null };
  return {
    canDelete: false,
    canMove: false,
    amountLocked: true,
    reason: "The balance on this visit was waived, so its payments are fixed. You can still change the method, reference or notes.",
  };
}
```
- [ ] **Step 3: Visit page.** Compute `const waivedRules = waivedVisitPaymentRules(visitMoney);` once. Render `<MovePaymentDialog …>` only when `waivedRules.canMove`, `<VoidPaymentDialog …>` only when `waivedRules.canDelete`; pass `amountLocked={waivedRules.amountLocked}` to `<EditPaymentDialog>`; when `waivedRules.reason` is set, render it once under the payments table: `<p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]" data-testid="waived-payments-note">{waivedRules.reason}</p>`.
- [ ] **Step 4: Edit dialog.** Add prop `amountLocked: boolean`; set `disabled={amountLocked}` on the amount `<Input>`; when locked, a helper line under it: `Fixed — the balance on this visit was waived.`; skip the "This leaves ₱X unpaid" line and the `PaymentLeavesNotice` when `amountLocked` (the amount cannot change).
- [ ] **Step 5:** `npx vitest run src/lib/visits/payment-leaves.test.ts`, typecheck, lint. **Commit** `git commit -am "feat(visits): payment dialogs follow the waived-visit rule"`.

---

### Task 14: Docs

**Files:** `docs/drmed-user-guide.html`, `.claude/skills/drmed-payments/SKILL.md`, `.claude/skills/drmed-migrations/SKILL.md`, `CLAUDE.md`

- [ ] **Step 1: Guide.** Find the waive-balance paragraph (grep `Waive balance`) and the "Deleting a payment" / "Fixing a payment" sections. State: what waiving does in the books ("the waived amount is recorded as a discount — lab tests or doctor fees — as each line is released, and the patient receivable is cleared; nothing is collected"); that after waiving the visit's payments and lines are fixed (no Record payment, Delete or Move; Edit may change only the method, reference or notes; no new test can be added or restored — register a new visit) with the exact refusal texts; that an imported visit waives with no books entry; the closed-month message; that a package on a waived visit releases later when the month is reopened; the "Something else changed this visit at the same moment. Try again." message. Bump the version (v2.28 → v2.29) in both places and CLAUDE.md line 21.
- [ ] **Step 2: drmed-payments skill.** Schema block: `visits.waived_php/waived_at/waived_by/waive_reason`, `visit_waiver_allocations`. Trigger table: the three guards (P0069/P0070), `waive_visit_balance`, the fold and the undo/cancel hooks, the serialization protocol in one sentence. "Waive balance (admin)" row: rewrite to the RPC + accounting. GL bridge section: the waiver lines. Hard rules: "Never manually SET visits.payment_status" now reads "… — 'waived' only through waive_visit_balance() (P0069); a waived visit's payments and lines are frozen (P0070)".
- [ ] **Step 3: drmed-migrations skill.** Landmark list: `0183_waived_balance_gl.sql` one-liner; P-code registry: P0069–P0071 (+ the `40P01` translation).
- [ ] **Step 4: CLAUDE.md.** "in use" P-code list adds P0069–P0071; the ledger line is updated after the prod push (Task 16).
- [ ] **Step 5: Commit** `git commit -am "docs: waived balance in the books (guide v2.29, skills)"`.

---

### Task 15: Full checks, browser smoke, Codex, PR

- [ ] **Step 1:** `npm test && npm run typecheck && npm run lint` — all green (note the count).
- [ ] **Step 2: smoke:print** (dev server from this worktree with `SUPABASE_JWT_SECRET` from `supabase status -o env`, port 3009): `APP_BASE=http://localhost:3009 npm run smoke:print` — green; the waived visit now goes through the RPC.
- [ ] **Step 3: Targeted browser check** (throwaway script inside the worktree, deleted after): waive a live visit with a released lab line + an unreleased consult → visit page shows Waived and the dialog preview text; `journal_entries` holds one `visit_waiver` entry; release the consult → its JE carries `Balance waived`; `/staff/payments/new?visit_id=…` shows the waived notice; the visit page shows no Delete/Move and the Edit amount is disabled; restoring a line deleted before the waive (via the queue's Restore) is refused with the P0070 text.
- [ ] **Step 4:** `/codex-review astra high` (context: spec + this plan + the check results), fix, one recheck.
- [ ] **Step 5:** Push, open the PR (body: the seven rules, the serialization protocol, the accounting check, verification incl. which replay path Task 8 used). Do NOT merge yet.

---

### Task 16: Prod `[CR-11]`

- [ ] **Step 1: Preflight count** (read-only; MCP `execute_sql` or ask the owner): `select count(*) from visits where payment_status = 'waived'` — if > 0 STOP and reconcile; the migration's own assertion is the atomic gate and refuses anyway.
- [ ] **Step 2:** `git fetch origin && git merge origin/main`; rerun `npm test`. If `0182_staff_view_as_role.sql` has landed on main it replays before 0183 (no object overlap). If prod holds 0182 or a higher number when pushing, `--dry-run --include-all` must list only 0183 (copy a missing sibling in untracked only if the CLI demands it; never `migration repair`).
- [ ] **Step 3:** From the worktree: `/opt/homebrew/bin/supabase db push --dry-run` → only 0183.
- [ ] **Step 4:** `supabase db push` right before the merge. Verify by object on prod: the 6 functions, the 3 triggers, the table + policy, `je_source_kind` contains `visit_waiver`, `correct_payment`'s comment mentions 0183.
- [ ] **Step 5: Deploy window and recovery.** Between the push and the Vercel deploy, the OLD app's Waive button issues the direct UPDATE, which P0069 now refuses — the old app shows the raw P0069 message and writes nothing (safe). If the Vercel deploy fails, fix forward with a hotfix commit; never revert the migration — the guards are what keep the books and the waiver consistent, and any waiver committed through the new RPC keeps its allocations.
- [ ] **Step 6:** Merge, confirm the production deploy, update CLAUDE.md's ledger line (prod head = 0183) and memory.
