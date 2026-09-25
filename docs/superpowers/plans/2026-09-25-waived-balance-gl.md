# Waived Balance → GL (discount + clear AR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an admin waives a visit balance, book the waived remainder as a discount (4910 lab / 4920 doctor) per bill line and clear 1100 AR Patients, with every later money path on the visit either folded in or refused at the database.

**Architecture:** One migration (**0183**) adds `visit_waiver_allocations` (one row per priced line, largest-remainder split, fixed at waive time), a service-role RPC `waive_visit_balance()` that computes the split under the visit row lock and posts a standalone discount JE for lines already released, a fold into `bridge_test_request_released()` for lines released later, reversal hooks in the undo-release and cancel bridges, and two guard triggers (P0069 on entering/leaving `'waived'`, P0070 on any payment insert/void/move on a waived visit, with `correct_payment` allowed an equal-amount replacement). App side: the waive action calls the RPC; the Record payment page refuses a waived visit; the payment dialogs stop offering what the DB now refuses.

**Tech Stack:** Postgres (plpgsql, Supabase migrations), Next.js 16 server actions, vitest, `supabase/tests/*.sql` smokes (local stack only, `dblink` for the race test), real-Chrome `smoke:print`.

**Spec:** `docs/superpowers/specs/2026-09-25-waived-balance-gl-design.md` (rules 1–7). Claimed numbers: migration **0183**, P-codes **P0069** (waived transition guard), **P0070** (money on a waived visit), **P0071** (waive_visit_balance refusals, message passed through).

**Worktree:** `~/Claude/DRMed/.worktrees/waived-balance-gl`, branch `feat/waived-balance-gl` off `origin/main` 175f53ee (#233 merged). `.env.local`, `.env.development.local` and `supabase/.temp/{project-ref,linked-project.json,pooler-url}` are already copied in.

**Local-stack trap (memory):** other sessions `db reset` the shared local stack from checkouts behind main; `supabase migration up --local` refuses because of a stray ledger row. Apply migration files by hand in one transaction with a hand-written ledger row (Task 8), never run `migration repair`. Re-check `select max(version) from supabase_migrations.schema_migrations` before every smoke.

---

## File map

| File | Responsibility |
|---|---|
| `supabase/migrations/0183_waived_balance_gl.sql` | Enum value, `visits` waiver columns, `visit_waiver_allocations`, guards, `waive_visit_balance`, `waiver_post_allocation`, `waiver_unrecognise_line`, fold in the release bridge, hooks in undo/cancel bridges, `correct_payment` re-created, ACLs, comments |
| `supabase/seed.sql` | Mirror the new table's revoke/grant (seed-grant-parity) |
| `supabase/tests/0183_waived_balance_gl_smoke.sql` | GL cases A–J, single session |
| `supabase/tests/0183_waiver_race_smoke.sql` | Two-session race, dblink, local only |
| `src/lib/accounting/waiver-allocation.ts` (+ `.test.ts`) | Pure largest-remainder mirror for the waive dialog preview |
| `src/lib/accounting/waived-balance-gl.test.ts` | Pins the migration SQL (signatures, accounts, GUCs, lock order, ACLs) |
| `src/lib/accounting/pg-errors.ts` | P0069–P0071 translations |
| `src/lib/accounting/ledger-status-sql.test.ts` | `SQL_LOOKUPS` entries for the two new posted-only readers |
| `src/lib/visits/payment-edit.ts` (+ `payment-leaves.test.ts`) | `waivedVisitPaymentRules` — what the dialogs may offer on a waived visit; `WAIVE_CLOSED_MONTH_MESSAGE` |
| `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts` | `waiveVisitBalanceAction` → RPC |
| `src/app/(staff)/staff/(dashboard)/visits/[id]/waive-balance-dialog.tsx` + `page.tsx` | Preview of the split; hide Delete/Move and lock the Edit amount on waived visits |
| `src/app/(staff)/staff/(dashboard)/payments/[id]/edit/edit-payment-dialog.tsx` | `amountLocked` prop |
| `src/app/(staff)/staff/(dashboard)/payments/new/page.tsx` + `actions.ts` | Waived visit: say so, no form; action refuses |
| `src/types/database.ts` | Regenerated from the local stack after Task 8 |
| `scripts/smoke-print.ts`, `scripts/smoke-14-d1.sql`, `supabase/tests/0167_patient_soft_delete_smoke.sql` | Stop writing `'waived'` directly (the guard now refuses it) |
| `docs/drmed-user-guide.html`, `.claude/skills/drmed-payments/SKILL.md`, `.claude/skills/drmed-migrations/SKILL.md`, `CLAUDE.md` | Docs |

---

### Task 1: Pure allocation mirror (largest remainder)

**Files:**
- Create: `src/lib/accounting/waiver-allocation.ts`
- Test: `src/lib/accounting/waiver-allocation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/accounting/waiver-allocation.test.ts
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
    // 1000 over 3 equal lines: 333.33 ×3 = 999.99; the leftover centavo goes to the lowest id.
    const out = allocateWaiver(1000, [line("c", 100), line("a", 100), line("b", 100)]);
    expect(out.map((o) => o.amountPhp)).toEqual([333.34, 333.33, 333.33]);
    expect(out.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(out.reduce((s, o) => s + o.amountPhp, 0)).toBeCloseTo(1000, 2);
  });
  it("never exceeds a line's own price and never goes negative", () => {
    const out = allocateWaiver(0.03, [line("a", 0.01), line("b", 0.02)]);
    expect(out).toEqual([
      { id: "a", amountPhp: 0.01, account: "4910" },
      { id: "b", amountPhp: 0.02, account: "4910" },
    ]);
  });
  it("skips ₱0 package components, cancelled and deleted lines, and drops ₱0 shares", () => {
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

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/accounting/waiver-allocation.test.ts`
Expected: FAIL — cannot find module `./waiver-allocation`.

- [ ] **Step 3: Implement**

```ts
// src/lib/accounting/waiver-allocation.ts
// Mirror of the split waive_visit_balance() (migration 0183) makes when an
// admin waives a visit balance: the remainder is spread over the visit's
// priced live lines by the LARGEST-REMAINDER method in centavos, so the
// pieces add up to the remainder exactly and no line carries more than its
// own price. The SQL is the source of truth (0183's smoke proves the same
// fixtures); this feeds the waive dialog's preview and nothing else.
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
  const sum = (acct: "4910" | "4920") => out.filter((o) => o.account === acct).reduce((s, o) => s + toC(o.amountPhp), 0) / 100;
  return { labPhp: sum("4910"), doctorPhp: sum("4920"), lines: out.length };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/accounting/waiver-allocation.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/accounting/waiver-allocation.ts src/lib/accounting/waiver-allocation.test.ts
git commit -m "feat(accounting): largest-remainder waiver allocation (mirror of 0183)"
```

---

### Task 2: Migration 0183 — schema, guards, RPC, fold, hooks

**Files:**
- Create: `supabase/migrations/0183_waived_balance_gl.sql`
- Modify: `supabase/seed.sql` (tail)

- [ ] **Step 1: Write the migration.** The three re-created bridge bodies are COPIED from their latest definitions (grep confirms: `bridge_test_request_released` = 0159, `fn_undo_release_bridge` = 0140 lines 591–668, `bridge_test_request_cancelled` = 0141, `correct_payment` = 0174 lines 48–187) and edited only where marked `-- 0183:`. Never retype a body from memory.

```sql
-- =============================================================================
-- 0183_waived_balance_gl.sql — a waived balance is booked as a discount and
-- clears 1100 AR Patients.
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
--   3. Money on a waived visit is refused at the DB (P0070): insert, void,
--      move on or off. The one exception is correct_payment keeping the
--      amount (method/reference/notes) — it inserts the replacement before
--      voiding the original, under app.waived_visit_edit = 'on'.
--   4. payment_status may enter 'waived' only inside waive_visit_balance()
--      (app.waive_visit = 'on') and may never leave it (P0069). RLS "visits:
--      staff full" lets every staff role update the column directly.
--   5. Lock order: visits row FOR UPDATE first, payments only read. The
--      payment guard locks the visits row before deciding; recalc_visit_payment
--      already does. correct_payment locks payment → visit; the waiver never
--      locks a payment, so there is no cycle.
--   6. Provenance per row: all live → allocate + post; all imported (visit,
--      every live line, every non-voided payment) → 'waived' with NO
--      allocation and no JE; mixed → P0071.
--   7. Reversals: original → 'reversed', mirrored 'posted' entry (0173).
--      Posting date Manila. A closed month raises P0002 from
--      je_period_lock_check and the whole waive rolls back.
--
-- P-codes: P0069 waived transition guard · P0070 money on a waived visit ·
-- P0071 waive_visit_balance refusals (several messages, passed through).
-- =============================================================================

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

-- ---- P0069: entering / leaving 'waived' -------------------------------------
create or replace function public.guard_visit_waived_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_status = 'waived' and old.payment_status is distinct from 'waived' then
    if coalesce(current_setting('app.waive_visit', true), '') <> 'on' then
      raise exception 'A balance can only be waived with Waive balance on the visit page.'
        using errcode = 'P0069';
    end if;
  elsif old.payment_status = 'waived' and new.payment_status is distinct from 'waived' then
    raise exception 'A waived balance cannot be un-waived.' using errcode = 'P0069';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_visits_waived_transition_guard on public.visits;
create trigger trg_visits_waived_transition_guard
  before update of payment_status on public.visits
  for each row execute function public.guard_visit_waived_transition();

-- ---- P0070: money on a waived visit ------------------------------------------
create or replace function public.guard_payment_on_waived_visit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  -- Only an insert, or a void (voided_at NULL → set), can move money.
  if tg_op = 'UPDATE' and not (old.voided_at is null and new.voided_at is not null) then
    return new;
  end if;
  -- Lock the visit row first — the one order every money path uses (0183 §5).
  select payment_status into v_status
    from public.visits
   where id = new.visit_id
   for update;
  if v_status = 'waived'
     and coalesce(current_setting('app.waived_visit_edit', true), '') <> 'on' then
    raise exception 'This visit''s balance was waived, so its payments are fixed: nothing can be recorded, deleted or moved on it.'
      using errcode = 'P0070';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payments_waived_visit_guard on public.payments;
create trigger trg_payments_waived_visit_guard
  before insert or update of voided_at on public.payments
  for each row execute function public.guard_payment_on_waived_visit();

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

  -- The visit row lock is the ONE lock; payments are only read (0183 §5).
  select * into v_visit from public.visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visit not found.' using errcode = 'P0071';
  end if;
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

  -- Provenance, per row (§6).
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
    -- (parent_id set) never carry money. Largest remainder in centavos.
    select coalesce(sum(round(final_price_php * 100)), 0)::bigint into v_sum_c
      from public.test_requests
     where visit_id = p_visit_id and deleted_at is null and status <> 'cancelled'
       and parent_id is null and coalesce(final_price_php, 0) > 0;
    if v_sum_c = 0 then
      raise exception 'No priced lines to allocate the waiver over.' using errcode = 'P0071';
    end if;
    if v_rem_c > v_sum_c then
      raise exception 'This visit''s total is more than its lines add up to; fix the lines first.' using errcode = 'P0071';
    end if;

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

    -- Lines already released: their AR is booked, clear it now.
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
  perform set_config('app.waive_visit', 'off', true);

  return jsonb_build_object(
    'waived_php',      v_rem_c / 100.0,
    'allocations',     v_n,
    'posted_now',      v_posted,
    'legacy',          v_all_legacy,
    'previous_status', v_visit.payment_status
  );
end;
$$;

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
--   (c) BOTH "DR: receivable for final_price_php" inserts — change the amount
--       and the guard from `new.final_price_php` to `new.final_price_php - v_waived`:
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
--   Keep the legacy early return, the parent_id return, P0034, PF lines, the
--   suspense audit and the ACL restatement exactly as in 0159.
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
-- COPY fn_undo_release_bridge() from 0140 (lines 591–668) and add ONE line
-- immediately after the accounting-reversal block (after `end if;` that closes
-- `if v_original_je is not null then`), before the doctor_pf_entries void:
--         -- 0183: a standalone waiver JE for this line is reversed too; a folded share went with the JE above.
--         perform public.waiver_unrecognise_line(new.id, v_actor, 'release undone');
create or replace function public.fn_undo_release_bridge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- <<< paste the 0140 body here with the one added line >>>
$$;

revoke execute on function public.fn_undo_release_bridge() from public, anon, authenticated;
grant  execute on function public.fn_undo_release_bridge() to service_role;

-- ---- Cancel: same hook --------------------------------------------------------
-- COPY bridge_test_request_cancelled() from 0141 and add ONE line immediately
-- after `v_actor := auth.uid();`:
--         perform public.waiver_unrecognise_line(new.id, v_actor, 'test request cancelled');
create or replace function public.bridge_test_request_cancelled()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
-- <<< paste the 0141 body here with the one added line >>>
$function$;

revoke execute on function public.bridge_test_request_cancelled() from public, anon, authenticated;
grant  execute on function public.bridge_test_request_cancelled() to service_role;

-- ---- correct_payment: the equal-amount exception ------------------------------
-- COPY correct_payment from 0174 (lines 48–187: same signature, `create or
-- replace`) and add, in the declare block:
--         v_src_status text;
--         v_tgt_status text;
-- and this block immediately BEFORE the comment
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
--           -- Same amount: let the replacement insert and the void through the guard.
--           perform set_config('app.waived_visit_edit', 'on', true);
--         end if;
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
-- <<< paste the 0174 body here with the added declarations and block >>>
$$;

comment on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb) is
  'Edit / Move a payment (0161, stale guard 0174, waived-visit rule 0183): re-create then void in one transaction; reference/notes-only edits in place. On a waived visit only an equal-amount replacement is allowed (P0070). p_expected = the payment as the caller saw it; any difference is refused (P0054).';

-- ---- ACLs for the new functions (0119: new functions are service_role-only;
-- restate by name — hosted Supabase also grants anon/authenticated by default)
revoke execute on function public.guard_visit_waived_transition()            from public, anon, authenticated;
revoke execute on function public.guard_payment_on_waived_visit()            from public, anon, authenticated;
revoke execute on function public.waiver_post_allocation(uuid, uuid)         from public, anon, authenticated;
revoke execute on function public.waiver_unrecognise_line(uuid, uuid, text)  from public, anon, authenticated;
revoke execute on function public.waive_visit_balance(uuid, uuid, text)      from public, anon, authenticated;
grant  execute on function public.guard_visit_waived_transition()            to service_role;
grant  execute on function public.guard_payment_on_waived_visit()            to service_role;
grant  execute on function public.waiver_post_allocation(uuid, uuid)         to service_role;
grant  execute on function public.waiver_unrecognise_line(uuid, uuid, text)  to service_role;
grant  execute on function public.waive_visit_balance(uuid, uuid, text)      to service_role;
revoke execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)
  to service_role;

comment on function public.waive_visit_balance(uuid, uuid, text) is
  'Admin waives a visit balance (0183): fixes the remainder, allocates it per line (largest remainder), posts the discount JE for lines already released, folds the rest into later release JEs. Refusals raise P0071.';
```

- [ ] **Step 2: Paste the three bodies.** For each `<<< paste … >>>` marker: open the source migration (`0159_retire_send_out_accrual.sql`, `0140_manila_posting_dates.sql` lines 591–668, `0141_manila_posting_dates_remainder.sql`, `0174_correct_payment_stale_guard.sql` lines 63–187), copy the body between `as $function$`/`as $$` and the closing `$function$;`/`$$;`, paste, then make ONLY the listed edits. Diff-check: `diff <(awk '/create or replace function public.fn_undo_release_bridge/,/^\$\$;/' supabase/migrations/0140_manila_posting_dates.sql) <(awk '/create or replace function public.fn_undo_release_bridge/,/^\$\$;/' supabase/migrations/0183_waived_balance_gl.sql)` must show only the added line (same for the other three).

- [ ] **Step 3: Mirror the table grants in `supabase/seed.sql`** (append at the tail; `seed-grant-parity.test.ts` fails otherwise):

```sql

-- 0183: visit_waiver_allocations is read-only for reception/admin; writes come
-- from waive_visit_balance() and the bridges (service_role / triggers).
revoke all on public.visit_waiver_allocations from anon;
revoke all on public.visit_waiver_allocations from authenticated;
grant select on public.visit_waiver_allocations to authenticated;
```

- [ ] **Step 4: Lint the SQL by replay on the local stack** — see Task 8 (apply by hand). Do not commit until Task 3's pin test passes.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0183_waived_balance_gl.sql supabase/seed.sql
git commit -m "feat(accounting): 0183 waived balance → discount JE, per-line allocation, waived-visit guards"
```

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
  it("adds the source kind, the visit columns and the allocation table", () => {
    expect(sql).toMatch(/alter type public\.je_source_kind add value if not exists 'visit_waiver'/);
    expect(sql).toMatch(/add column if not exists waived_php\s+numeric\(10,2\)/);
    expect(sql).toMatch(/create table if not exists public\.visit_waiver_allocations/);
    expect(sql).toMatch(/discount_account text not null check \(discount_account in \('4910', '4920'\)\)/);
    expect(sql).toMatch(/unique \(test_request_id\)/);
  });

  it("guards entering and leaving 'waived' behind the RPC's GUC (P0069)", () => {
    const g = fn("guard_visit_waived_transition");
    expect(g).toMatch(/current_setting\('app\.waive_visit', true\)/);
    expect(g).toMatch(/errcode = 'P0069'/);
    expect(g).toMatch(/cannot be un-waived/);
    expect(sql).toMatch(/before update of payment_status on public\.visits/);
  });

  it("locks the visit row FIRST in the payment guard and in the waiver (one lock order)", () => {
    const g = fn("guard_payment_on_waived_visit");
    expect(g).toMatch(/from public\.visits\s+where id = new\.visit_id\s+for update/);
    expect(g).toMatch(/current_setting\('app\.waived_visit_edit', true\)/);
    expect(g).toMatch(/errcode = 'P0070'/);
    expect(sql).toMatch(/before insert or update of voided_at on public\.payments/);
    const w = fn("waive_visit_balance");
    expect(w).toMatch(/select \* into v_visit from public\.visits where id = p_visit_id for update;/);
    expect(w).not.toMatch(/from public\.payments[\s\S]*?for update/);
  });

  it("waive_visit_balance: admin only, provenance per row, largest remainder, standalone post for released lines", () => {
    const w = fn("waive_visit_balance");
    expect(w).toMatch(/v_role is distinct from 'admin'/);
    expect(w).toMatch(/mixes imported and live rows/);
    expect(w).toMatch(/order by frac desc, test_request_id limit v_left/);
    expect(w).toMatch(/parent_id is null and coalesce\(tr\.final_price_php, 0\) > 0/);
    expect(w).toMatch(/when s\.kind in \('doctor_consultation', 'doctor_procedure'\) then '4920' else '4910'/);
    expect(w).toMatch(/where t\.status = 'released'[\s\S]*?perform public\.waiver_post_allocation\(r\.id, p_actor_id\)/);
    expect(w).toMatch(/set_config\('app\.waive_visit', 'on', true\)/);
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

  it("undo-release and cancel take the share back out; reversal follows the 0173 pair rule", () => {
    expect(fn("fn_undo_release_bridge")).toMatch(/waiver_unrecognise_line\(new\.id, v_actor, 'release undone'\)/);
    expect(fn("bridge_test_request_cancelled")).toMatch(/waiver_unrecognise_line\(new\.id, v_actor, 'test request cancelled'\)/);
    const u = fn("waiver_unrecognise_line");
    expect(u).toMatch(/set status = 'reversed', reversed_by = v_rev/);
    expect(u).toMatch(/set recognised_at = null, journal_entry_id = null/);
  });

  it("correct_payment: equal-amount edit only on a waived visit, no move on or off (P0070)", () => {
    const c = fn("correct_payment");
    expect(c).toMatch(/where id = v_old\.visit_id for update/);
    expect(c).toMatch(/cannot be moved\.' using errcode = 'P0070'/);
    expect(c).toMatch(/moved onto it\.' using errcode = 'P0070'/);
    expect(c).toMatch(/amount is fixed[\s\S]*?errcode = 'P0070'/);
    expect(c).toMatch(/set_config\('app\.waived_visit_edit', 'on', true\)/);
  });

  it("restates every ACL by name (0118/0119)", () => {
    for (const f of [
      "guard_visit_waived_transition\\(\\)",
      "guard_payment_on_waived_visit\\(\\)",
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

- [ ] **Step 2: Run** `npx vitest run src/lib/accounting/waived-balance-gl.test.ts` — expected: 9 passed (fix the SQL, never the assertions, when one fails).

- [ ] **Step 3: Commit** `git add src/lib/accounting/waived-balance-gl.test.ts && git commit -m "test(accounting): pin 0183's waiver bridge SQL"`

---

### Task 4: P-code translations + coverage

**Files:**
- Modify: `src/lib/accounting/pg-errors.ts` (after the `P0067` case)

- [ ] **Step 1: Add the cases**

```ts
    // 0183 — waived balances
    case "P0069":
      // Entering 'waived' outside waive_visit_balance(), or leaving it at all.
      return err.message ?? "A balance can only be waived with Waive balance on the visit page.";
    case "P0070":
      // Money on a waived visit: record, delete, move. Several messages, all
      // staff-readable — pass them through.
      return err.message ?? "This visit's balance was waived, so its payments are fixed.";
    case "P0071":
      // waive_visit_balance refusals (not admin, HMO, already waived/paid,
      // mixed provenance, nothing to waive …) — each message is written for staff.
      return err.message ?? "This visit's balance cannot be waived.";
```

- [ ] **Step 2: Run** `npx vitest run src/lib/accounting/pg-error-coverage.test.ts src/lib/accounting/pg-errors.test.ts` — expected: pass (the coverage test finds P0069–P0071 raised in 0183 and translated).

- [ ] **Step 3: Commit** `git add src/lib/accounting/pg-errors.ts && git commit -m "feat(accounting): translate P0069–P0071 (waived balance)"`

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

- [ ] **Step 2: Run** `npx vitest run src/lib/accounting/ledger-status-sql.test.ts src/lib/accounting/ledger-status.test.ts` — expected: pass. If it reports `waive_visit_balance` or the guards as journal readers, they are not (they read `visits`/`payments` only) — fix the SQL, not the allowlist.

- [ ] **Step 3: Commit** `git add src/lib/accounting/ledger-status-sql.test.ts && git commit -m "test(accounting): register 0183's posted-only lookups"`

---

### Task 6: GL smoke (single session)

**Files:**
- Create: `supabase/tests/0183_waived_balance_gl_smoke.sql`

- [ ] **Step 1: Write it** in the 0174 shape (`begin; do $$ … raise exception 'FAIL: …' … $$;` — the runner rolls back). Seed: an admin `auth.users` + `staff_profiles` row, a patient, a lab service (₱500, `lab_test`) and a consult service (₱800, `doctor_consultation`, a physician), CoA rows exist from 0028. Cases:

```sql
-- A  RLS hole closed: a plain `update visits set payment_status='waived'` raises P0069;
--    `update … set payment_status='unpaid'` on a waived visit raises P0069.
-- B  Live visit, lab 500 + consult 800, paid 300, nothing released: waive →
--    payment_status='waived', waived_php=1000, two allocations 384.62 (4910) and
--    615.38 (4920) that sum to 1000, recognised_at null, no 'visit_waiver' JE.
--    Release the lab line → its JE has DR 1100 115.38, DR 4910 384.62, CR 4100 500;
--    allocation recognised, journal_entry_id = that JE. Release the consult →
--    DR 1100 184.62, DR 4920 615.38, CR 4200 300, CR 2110 500. After both:
--    sum over the visit's 1100 lines (posted+reversed) = 300 − 300 = 0.
-- C  Undo-release of the lab line → the release JE is reversed (status
--    'reversed', a mirrored 'posted' entry), allocation recognised_at null;
--    re-release folds again and the 1100 net is unchanged.
-- D  Already-released line at waive time: new visit, lab 500 released while
--    paid 500, then the payment voided (now unpaid; done under
--    app.waived_visit_edit is NOT set — the visit is not yet waived, so allowed),
--    waive → a 'visit_waiver' JE DR 4910 500 / CR 1100 500 posted, allocation
--    recognised. Undo-release → that JE reversed, allocation unrecognised.
-- E  P0070: on visit B insert a payment → P0070; void the existing 300 payment →
--    P0070; correct_payment with a different amount → P0070; correct_payment
--    with the same amount, method gcash → succeeds, replacement row exists,
--    original voided 'Edited: …', visit still 'waived', paid_php 300;
--    correct_payment moving a payment from an unpaid visit onto B → P0070.
-- F  Provenance: an all-imported visit (visits.legacy_import_run_id set, its
--    line and payment too) waives with waived_php set, 0 allocations, 0 JEs;
--    a mixed visit (imported visit, live line) → P0071.
-- G  Refusals: HMO visit → P0071; paid visit → P0071; non-admin actor → P0071;
--    blank reason → P0071; already waived → P0071.
-- H  Largest remainder: three ₱100 lines, remainder ₱1,000 → 333.34/333.33/333.33
--    with the extra centavo on the lowest test_request id; ₱0 package
--    components get no allocation (header 5888 gets it all).
-- I  Closed month: close the current period (period_status_for → 'closed' via
--    the accounting_periods row the 0028 smoke uses), then waive a visit with a
--    released line → P0002 and NOTHING written (payment_status still unpaid,
--    no allocation rows). Reopen.
-- J  Package header auto-release on waive (Leg B): a package visit whose
--    components are all released and whose header is ready_for_release; waive →
--    the header releases inside the same statement and its release JE carries
--    the folded share (recognised_at set, journal_entry_id = header JE).
```

Every case ends in explicit `if … then raise exception 'FAIL: <case> …'; end if;` checks on `visits.payment_status`, `visit_waiver_allocations`, `journal_entries.status`, `journal_lines` amounts by CoA code (join `chart_of_accounts` by `code`), and P-code catches via `exception when others then if sqlstate <> 'P0070' then raise; end if;` inside nested `begin … end` blocks. Print `raise notice 'PASS <case>'` after each.

- [ ] **Step 2: Run against the LOCAL stack only** (after Task 8 applies 0183):

```bash
/opt/homebrew/opt/libpq/bin/psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f supabase/tests/0183_waived_balance_gl_smoke.sql 2>&1 | grep -E "PASS|FAIL|ERROR"
```
Expected: `PASS A` … `PASS J`, then `ROLLBACK`.

- [ ] **Step 3: Commit** `git add supabase/tests/0183_waived_balance_gl_smoke.sql && git commit -m "test(sql): 0183 waived balance GL smoke A–J"`

---

### Task 7: Two-session race smoke (dblink, local only)

**Files:**
- Create: `supabase/tests/0183_waiver_race_smoke.sql`

- [ ] **Step 1: Write it.** Header comment: LOCAL ONLY (opens two extra connections to the same database through `dblink`; never run on prod). Body:

```sql
begin;
create extension if not exists dblink;
do $$
declare
  c   text := 'dbname=postgres user=postgres password=postgres host=localhost port=5432';
  v_actor uuid := gen_random_uuid(); v_patient uuid; v_visit uuid; v_svc uuid; v_res text;
  v_waived numeric; v_alloc numeric; v_status text;
begin
  -- seed admin + patient + a ₱1,000 lab line, visit unpaid (total_php = 1000)
  -- … (same seeding as 0183_waived_balance_gl_smoke.sql; commit it on the
  -- MAIN connection with a savepoint? No: the seed must be visible to the
  -- other connections, so run the seed through dblink_exec on connection 's0'
  -- and delete it again at the end of the do-block, whatever happens.)
  perform dblink_connect('s0', c);
  perform dblink_exec('s0', format($q$insert into auth.users (...) values (%L, ...); insert into public.staff_profiles ...; insert into public.patients ...; insert into public.visits (id, patient_id, total_php) values (%L, %L, 1000); insert into public.test_requests (...) values (...);$q$, v_actor, v_visit, v_patient));

  -- Case 1: payment first, waiver waits, then sees the payment.
  perform dblink_connect('s1', c);
  perform dblink_connect('s2', c);
  perform dblink_exec('s1', 'begin');
  perform dblink_exec('s1', format('insert into public.payments (visit_id, amount_php, method, received_by) values (%L, 400, ''cash'', %L)', v_visit, v_actor));
  -- s1 now holds the visit row lock (recalc_visit_payment FOR UPDATE).
  perform dblink_send_query('s2', format('select public.waive_visit_balance(%L, %L, ''race'')', v_visit, v_actor));
  perform pg_sleep(0.5);
  if dblink_is_busy('s2') <> 1 then raise exception 'FAIL 1: the waiver did not wait for the visit lock'; end if;
  perform dblink_exec('s1', 'commit');
  select val into v_res from dblink_get_result('s2') as t(val text);
  perform dblink_get_result('s2'); -- drain
  select waived_php, payment_status into v_waived, v_status from public.visits where id = v_visit;
  select sum(amount_php) into v_alloc from public.visit_waiver_allocations where visit_id = v_visit;
  if v_status <> 'waived' or v_waived <> 600 or v_alloc <> 600 then
    raise exception 'FAIL 1: waiver did not see the committed payment (status %, waived %, alloc %)', v_status, v_waived, v_alloc;
  end if;
  raise notice 'PASS 1 payment-then-waive: waived % over %', v_waived, v_alloc;

  -- Case 2: waiver first (uncommitted), payment waits, then is refused.
  -- Fresh visit V2 (seed via s0 as above, total 1000, unpaid).
  perform dblink_exec('s1', 'begin');
  perform dblink_exec('s1', format('select public.waive_visit_balance(%L, %L, ''race'')', v_visit2, v_actor));
  perform dblink_send_query('s2', format('insert into public.payments (visit_id, amount_php, method, received_by) values (%L, 400, ''cash'', %L)', v_visit2, v_actor));
  perform pg_sleep(0.5);
  if dblink_is_busy('s2') <> 1 then raise exception 'FAIL 2: the payment did not wait for the visit lock'; end if;
  perform dblink_exec('s1', 'commit');
  begin
    perform dblink_get_result('s2');
    raise exception 'FAIL 2: a payment was recorded on a waived visit';
  exception when others then
    if sqlerrm not like '%P0070%' and sqlerrm not like '%balance was waived%' then raise; end if;
  end;
  raise notice 'PASS 2 waive-then-payment: refused';

  -- teardown via s0 (delete in FK order, session_replication_role = replica)
  perform dblink_exec('s0', 'set session_replication_role = replica; delete from public.journal_lines where entry_id in (select id from public.journal_entries where source_id in (select id from public.visit_waiver_allocations where visit_id in (' || quote_literal(v_visit) || ',' || quote_literal(v_visit2) || ')) or source_id in (select id from public.payments where visit_id in (...)));' /* … journal_entries, allocations, payments, test_requests, visits, patients, staff_profiles, auth.users … */);
  perform dblink_disconnect('s0'); perform dblink_disconnect('s1'); perform dblink_disconnect('s2');
exception when others then
  -- best-effort teardown, then re-raise
  begin perform dblink_exec('s0', '… same deletes …'); exception when others then null; end;
  raise;
end $$;
rollback;
```

Write the seeding and teardown SQL out in full (the `…` above are the same statements as Task 6's seed, run through `dblink_exec('s0', …)` so the rows are committed and visible to `s1`/`s2`; the teardown deletes them in FK order with `session_replication_role = replica` because the GL balance-check triggers refuse to delete posted lines).

- [ ] **Step 2: Run locally** `psql … -f supabase/tests/0183_waiver_race_smoke.sql 2>&1 | grep -E "PASS|FAIL|ERROR"` — expected `PASS 1`, `PASS 2`. Confirm teardown: `select count(*) from visit_waiver_allocations` returns what it did before.

- [ ] **Step 3: Commit** `git add supabase/tests/0183_waiver_race_smoke.sql && git commit -m "test(sql): 0183 two-session waiver race (dblink, local only)"`

---

### Task 8: Apply 0183 locally by hand, regenerate types

- [ ] **Step 1: Check the local ledger** — `psql … -Atc "select max(version) from supabase_migrations.schema_migrations; select version from supabase_migrations.schema_migrations where version in ('0178','0180','0181','0183')"`. Apply whichever of 0178, 0180, 0181 are missing first (they are on main), each as `begin; <file>; insert into supabase_migrations.schema_migrations (version, name, statements) values ('NNNN','<name>', array['applied by hand (local)']); commit;` via `psql -v ON_ERROR_STOP=1 -f`. Never `migration repair`.

- [ ] **Step 2: Apply 0183 the same way.** Expected: `COMMIT`. Verify: `select proname from pg_proc where proname in ('waive_visit_balance','waiver_post_allocation','waiver_unrecognise_line','guard_visit_waived_transition','guard_payment_on_waived_visit')` returns 5 rows; `select tgname from pg_trigger where tgname in ('trg_visits_waived_transition_guard','trg_payments_waived_visit_guard')` returns 2.

- [ ] **Step 3: Run Tasks 6 and 7's smokes.** Both must pass before continuing.

- [ ] **Step 4: Regenerate types** `npm run db:types` then `git diff --stat src/types/database.ts`. Keep the hunks for `visit_waiver_allocations`, the four `visits` columns and `waive_visit_balance`; if the diff also contains objects from other sessions' local-only migrations, revert those hunks by hand (`git add -p`).

- [ ] **Step 5: Typecheck** `npm run typecheck` — expected clean.

- [ ] **Step 6: Commit** `git add src/types/database.ts && git commit -m "chore(types): 0183 waiver objects"`

---

### Task 9: Stop the direct `'waived'` writes in existing smokes

**Files:**
- Modify: `scripts/smoke-14-d1.sql:59`, `supabase/tests/0167_patient_soft_delete_smoke.sql:475,537,564`, `scripts/smoke-print.ts:263`

- [ ] **Step 1:** In the two SQL files, immediately before each `update public.visits set payment_status = 'waived' …` add:
```sql
  perform set_config('app.waive_visit', 'on', true);  -- 0183 guard: these fixtures set the status directly
```
- [ ] **Step 2:** In `scripts/smoke-print.ts` replace line 263 with the RPC (the seeded staff is an admin):
```ts
  await q("update visits set total_php = 550 where id = $1", [s.waivedVisitId]);
  await q("select public.waive_visit_balance($1, $2, 'smoke: charity')", [s.waivedVisitId, staffId]);
```
and in `cleanup()` add, before the `visits` delete, `await q("delete from visit_waiver_allocations where visit_id = any($1::uuid[])", [visitIds]);` and extend the journal deletes to include `source_id in (select id from visit_waiver_allocations where visit_id = any(...))` (do this BEFORE the allocations delete).
- [ ] **Step 3:** Run `psql … -f supabase/tests/0167_patient_soft_delete_smoke.sql | grep -E "PASS|FAIL|ERROR"` — expected all PASS.
- [ ] **Step 4: Commit** `git add scripts/smoke-14-d1.sql supabase/tests/0167_patient_soft_delete_smoke.sql scripts/smoke-print.ts && git commit -m "test: waive through the RPC / GUC now that 0183 guards the status"`

---

### Task 10: `waiveVisitBalanceAction` → RPC

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/actions.ts` (`waiveVisitBalanceAction`)
- Modify: `src/lib/visits/payment-edit.ts` (add `WAIVE_CLOSED_MONTH_MESSAGE`)
- Test: `src/lib/visits/payment-leaves.test.ts` (one assertion on the message constant)

- [ ] **Step 1: Add the message** to `payment-edit.ts` next to `CLOSED_MONTH_MESSAGE`:

```ts
/**
 * je_period_lock_check (0029) refuses the waiver's discount entry when a line
 * already released would post into a closed month (0183). Nothing is written
 * in that case — the whole waive rolls back.
 */
export const WAIVE_CLOSED_MONTH_MESSAGE =
  "The books are closed for this month, so the waived amount cannot be booked yet. Ask an admin to reopen the month, then waive the balance.";
```
Test: `expect(WAIVE_CLOSED_MONTH_MESSAGE).toMatch(/closed for this month/);` in `payment-leaves.test.ts`.

- [ ] **Step 2: Replace the action body** from `const supabase = await createClient();` to the end with:

```ts
  const admin = createAdminClient();

  // 0167: waiving is a financial change — refuse it on an inactive record.
  const active = await assertVisitPatientActive(admin, visitId);
  if (!active.ok) return { ok: false, error: active.error };

  // 0183: the RPC owns every rule (admin actor, non-HMO, unpaid/partial,
  // provenance, the per-line split, the discount JE) under the visit row
  // lock, and raises P0071 with a staff-readable message for each refusal.
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
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
```
Delete the now-unused pre-checks (the `supabase.from("visits").select(...)` read and the four `if` refusals) — the RPC repeats them with the same wording. Keep `WaiveBalanceSchema` parsing and `requireAdminStaff()`. Import `WAIVE_CLOSED_MONTH_MESSAGE` from `@/lib/visits/payment-edit`. Update the doc-comment above the function: "Setting payment_status = 'waived' now happens inside waive_visit_balance() (0183), which also books the waived remainder as a discount and clears 1100."

- [ ] **Step 3:** `npm run typecheck` — clean. `npx vitest run src/lib/visits/query-surfaces.test.ts` — if it complains the file no longer reads `visits` there, nothing to do; if it complains about a new read, register it (`LIFECYCLES`, live).

- [ ] **Step 4: Commit** `git add -A && git commit -m "feat(visits): waive balance through waive_visit_balance (0183)"`

---

### Task 11: Waive dialog preview

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/waive-balance-dialog.tsx`, `page.tsx` (the `<WaiveBalanceDialog` call at ~line 862)

- [ ] **Step 1:** Add props to the dialog: `preview: { labPhp: number; doctorPhp: number; lines: number } | null` and `legacy: boolean`. Under the existing "Waiving {balanceLabel}…" description render:

```tsx
{legacy ? (
  <p className="text-xs text-[color:var(--color-brand-text-soft)]">
    Imported visit: the books never held this balance, so nothing is posted.
  </p>
) : preview ? (
  <p className="text-xs text-[color:var(--color-brand-text-soft)]" data-testid="waive-preview">
    {formatPhp(preview.labPhp + preview.doctorPhp)} is recorded as a discount
    {preview.doctorPhp > 0 && preview.labPhp > 0
      ? ` — ${formatPhp(preview.labPhp)} on lab tests and ${formatPhp(preview.doctorPhp)} on doctor fees`
      : preview.doctorPhp > 0
        ? " on doctor fees"
        : " on lab tests"}
    {" "}across {preview.lines} line{preview.lines === 1 ? "" : "s"}, and the patient receivable is cleared. Nothing is collected.
  </p>
) : (
  <p className="text-xs text-amber-800">This visit's lines do not add up to its total; fix the lines before waiving.</p>
)}
```

- [ ] **Step 2:** In `page.tsx`, build the preview from the lines the page already loads (`test_requests` with `final_price_php, parent_id, status, services ( kind )`):

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
<WaiveBalanceDialog visitId={visit.id} balanceLabel={formatPhp(balance > 0 ? balance : 0)} preview={waivePreview} legacy={visit.legacy_import_run_id != null} />
```
(`liveLines` = the page's non-deleted `test_requests`; add `legacy_import_run_id` to the visit select if it is not already there.)

- [ ] **Step 3:** `npm run typecheck` + `npm run lint`. Commit `git commit -am "feat(visits): waive dialog previews the discount split"`.

---

### Task 12: Record payment page + action refuse a waived visit

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/payments/new/page.tsx`, `actions.ts`
- Modify: `src/lib/visits/query-surfaces.test.ts` (`LIFECYCLES` entry for `actions.ts`)

- [ ] **Step 1: Page.** After `const balance = …`, add:

```tsx
import { visitMoneySummary } from "@/lib/visits/statement";
// …
const money = visitMoneySummary(visit);
if (visit.payment_status === "waived") {
  return (
    <div className="mx-auto max-w-xl px-4 py-8 sm:px-6 lg:px-8">
      <Link href={`/staff/visits/${visit.id}`} className="…same class…">← Visit #{visit.visit_number}</Link>
      <h1 className="…same class…">Record payment</h1>
      <p className="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" data-testid="waived-notice">
        The balance on this visit was waived — {formatPhp(money.waived)} was recorded as a discount and there is nothing to collect.
        Payments on a waived visit are not accepted.
      </p>
    </div>
  );
}
```
(`visitMoneySummary` takes `total_php, paid_php, payment_status, hmo_provider_id` — all in the page's select.)

- [ ] **Step 2: Action.** In `recordPaymentAction`, after the active-patient check and before the insert:

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
Do the same in `redeemGiftCode` right after its visit read (it already reads the visit — add `payment_status` to that select and the same early return).

- [ ] **Step 3:** Register in `query-surfaces.test.ts` `LIFECYCLES`:
```ts
  "app/(staff)/staff/(dashboard)/payments/new/actions.ts": {
    lifecycle: "any",
    why: "Reads one visit's payment_status by id to refuse a payment on a waived visit (0183). A deleted visit is refused by P0045 either way.",
  },
```
- [ ] **Step 4:** `npx vitest run src/lib/visits/query-surfaces.test.ts` + typecheck. Commit `git commit -am "feat(payments): Record payment refuses a waived visit and says the balance was waived"`.

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
- [ ] **Step 3: Visit page.** Compute `const waivedRules = waivedVisitPaymentRules(visitMoney);` once. Render `<MovePaymentDialog …>` only when `waivedRules.canMove`, `<VoidPaymentDialog …>` only when `waivedRules.canDelete`; pass `amountLocked={waivedRules.amountLocked}` to `<EditPaymentDialog>`; when `waivedRules.reason` is set, render it once under the payments table as `<p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]" data-testid="waived-payments-note">{waivedRules.reason}</p>`.
- [ ] **Step 4: Edit dialog.** Add prop `amountLocked: boolean`; set `disabled={amountLocked}` on the amount `<Input>` and, when locked, a helper line under it: `Fixed — the balance on this visit was waived.` Also skip the "This leaves ₱X unpaid" and `PaymentLeavesNotice` lines when `amountLocked` (the amount cannot change).
- [ ] **Step 5:** `npx vitest run src/lib/visits/payment-leaves.test.ts`, typecheck, lint. Commit `git commit -am "feat(visits): payment dialogs follow the waived-visit rule"`.

---

### Task 14: Docs

**Files:** `docs/drmed-user-guide.html`, `.claude/skills/drmed-payments/SKILL.md`, `.claude/skills/drmed-migrations/SKILL.md`, `CLAUDE.md`

- [ ] **Step 1: Guide.** Find the waive-balance paragraph (grep `Waive balance`) and the "Deleting a payment" / "Fixing a payment" sections. Add: what waiving does in the books ("the waived amount is recorded as a discount — lab tests or doctor fees — and the patient receivable is cleared; nothing is collected"); that after waiving, payments on the visit are fixed (no Record payment, Delete or Move; Edit may change only the method, reference or notes) with the exact refusal texts; that an imported visit waives with no books entry; the closed-month message. Bump the version (v2.28 → v2.29) in both places and CLAUDE.md line 21.
- [ ] **Step 2: drmed-payments skill.** Schema block: `visits.waived_php/waived_at/waived_by/waive_reason`, `visit_waiver_allocations`. Trigger table: the two guards + `waive_visit_balance` + fold/hooks. "Waive balance (admin)" row: rewrite to the RPC + accounting. GL bridge section: the waiver lines. Hard rules: "Never manually SET visits.payment_status" now reads "…never — 'waived' only through waive_visit_balance() (P0069)".
- [ ] **Step 3: drmed-migrations skill.** Landmark list: `0183_waived_balance_gl.sql` one-liner; P-code registry: P0069–P0071.
- [ ] **Step 4: CLAUDE.md.** Ledger line: prod head after push (Task 16); "in use" P-code list adds P0069–P0071.
- [ ] **Step 5: Commit** `git commit -am "docs: waived balance in the books (guide v2.29, skills, ledger)"`.

---

### Task 15: Full checks, browser smoke, Codex, PR

- [ ] **Step 1:** `npm test && npm run typecheck && npm run lint` — all green (note the count).
- [ ] **Step 2: smoke:print** (dev server from this worktree with `SUPABASE_JWT_SECRET`, port 3009): `APP_BASE=http://localhost:3009 npm run smoke:print` — green; the waived visit now goes through the RPC.
- [ ] **Step 3: Targeted browser check** (throwaway script in the worktree, deleted after): waive a live visit with a released lab line + an unreleased consult → visit page shows Waived + the dialog preview text; `journal_entries` has one `visit_waiver` entry; release the consult → its JE carries `Balance waived`; `/staff/payments/new?visit_id=…` shows the waived notice; the visit page shows no Delete/Move and the Edit amount is disabled.
- [ ] **Step 4:** `/codex-review astra high` (context: spec + this plan + check results), fix, one recheck.
- [ ] **Step 5:** Push, open the PR (body: the seven rules, the accounting check, verification). Do NOT merge yet.

---

### Task 16: Prod

- [ ] **Step 1: Re-count waived visits on prod** (read-only, MCP `execute_sql` or ask the owner): `select count(*) from visits where payment_status = 'waived'`. If **> 0**, STOP and reconcile before pushing (those visits have no allocation and their AR is still booked; the migration does not backfill).
- [ ] **Step 2:** `git fetch origin && git merge origin/main` (rebase the docs if needed), rerun `npm test`.
- [ ] **Step 3:** From the worktree: `/opt/homebrew/bin/supabase db push --dry-run` — must list ONLY `0183`. If prod already holds a higher number from another branch, use `--include-all` and confirm the list is still only 0183 (copy a missing sibling in untracked if the CLI demands it; never `migration repair`).
- [ ] **Step 4:** `supabase db push` (no dry-run flag). Verify by object on prod: the 5 functions, the 2 triggers, the table + policy, `je_source_kind` contains `visit_waiver`, `correct_payment` comment mentions 0183.
- [ ] **Step 5:** Merge the PR, confirm the Vercel production deploy, update CLAUDE.md's ledger line (prod head = 0183) in a follow-up commit if it was not already right, and update memory.
