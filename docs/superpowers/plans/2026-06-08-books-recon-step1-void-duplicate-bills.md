# Books Reconciliation — Step 1: Reverse 75 Duplicate AP Bills — Implementation Plan

> **For agentic workers:** This plan is a **production data-operation runbook**, executed by
> the **main session** (not subagents) because it contains a hard human sign-off gate before
> any committed prod write, and all writes go through the Supabase MCP against the live
> project. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT skip the sign-off gate
> (Task 3). Do NOT run any committed write before it.

**Goal:** Remove the ₱418,319.34 duplicate expense (and its phantom cash outflow) by voiding
the 75 history-imported AP bills + their payments via the app's guarded RPCs, raising GL net
income (Jan–May 2026) from −₱249,335.27 to +₱168,984.07.

**Architecture:** Two idempotent guarded RPCs per bill — `ap_void_bill_payment_cascade`
(payment first, clears the bill-void guard) then `ap_void_bill_with_guard` — both post
reversal JEs and audit rows. Proven on a throwaway `BEGIN…ROLLBACK` transaction first, then
committed atomically in one `DO` block, then verified against the manual Income Statement.

**Tech Stack:** Supabase MCP `execute_sql` against prod project `qhptbmafrosgibooelpp`;
PL/pgSQL RPCs from migration `0049_ap_subledger_behavior.sql`.

**Spec:** `docs/superpowers/specs/2026-06-08-books-recon-step1-void-duplicate-bills.md`

**Constants used throughout:**
- Project ID: `qhptbmafrosgibooelpp`
- Actor (Ian Jamila): `8c25a556-e23b-427b-a6f9-fcd555b52f32`
- Void reason (single-quote-escaped for SQL):
  `2026 books reconciliation — reverse duplicate history-imported AP bill (keep history_import layer; see docs/superpowers/specs/2026-06-08-books-recon-step1-void-duplicate-bills.md)`
- Canonical duplicate set (reused as a CTE in every query):
  ```sql
  with dup_bills as (
    select je.source_id as bill_id, bpa.payment_id
    from public.journal_entries je
    join public.bills b on b.id = je.source_id
    join public.bill_payment_allocations bpa on bpa.bill_id = b.id
    where je.status='posted' and je.source_kind='bill_post'
      and je.description ilike '%[history imported_at%'
      and je.posting_date between date '2026-01-01' and date '2026-05-31'
  )
  ```
  (At execution time this resolves to exactly 75 `(bill_id, payment_id)` rows.)

---

## Task 1: Pre-flight re-confirmation (read-only)

Re-establish, at execution time, that the live data still matches the diagnosis. Nothing is
written. If any assertion fails, STOP and re-investigate — do not proceed.

**Files:** none (MCP queries only).

- [ ] **Step 1: Confirm the duplicate set is still exactly 75 paid, history-tagged bills, total ₱418,319.34**

Run via MCP `execute_sql` (project `qhptbmafrosgibooelpp`):
```sql
with dup_bills as (
  select je.source_id as bill_id, bpa.payment_id
  from public.journal_entries je
  join public.bills b on b.id = je.source_id
  join public.bill_payment_allocations bpa on bpa.bill_id = b.id
  where je.status='posted' and je.source_kind='bill_post'
    and je.description ilike '%[history imported_at%'
    and je.posting_date between date '2026-01-01' and date '2026-05-31'
)
select
  count(*) as pairs,
  count(distinct bill_id) as bills,
  count(distinct payment_id) as payments,
  (select sum(gross_amount) from public.bills where id in (select bill_id from dup_bills)) as bills_total,
  (select count(*) from public.bills where status <> 'paid' and id in (select bill_id from dup_bills)) as non_paid_bills,
  (select count(*) from public.bills) as bills_in_whole_table,
  (select count(*) from public.bill_payments where voided_at is not null and id in (select payment_id from dup_bills)) as already_voided_payments;
```
Expected: `pairs=75, bills=75, payments=75, bills_total=418319.34, non_paid_bills=0,
bills_in_whole_table=75, already_voided_payments=0`.

- [ ] **Step 2: Confirm the baseline P&L (Jan–May 2026, posted)**

```sql
with rng as (select date '2026-01-01' f, date '2026-05-31' t),
pl as (
  select coa.type, jl.debit_php, jl.credit_php
  from public.journal_lines jl
  join public.journal_entries je on je.id=jl.entry_id
  join public.chart_of_accounts coa on coa.id=jl.account_id
  cross join rng
  where je.status='posted' and je.posting_date between rng.f and rng.t
    and coa.type in ('revenue','contra_revenue','expense')
)
select
  sum(credit_php-debit_php) filter (where type='revenue') as revenue,
  sum(debit_php-credit_php) filter (where type='contra_revenue') as contra_revenue,
  sum(debit_php-credit_php) filter (where type='expense') as expense,
  sum(credit_php-debit_php) as net_income
from pl;
```
Expected: `revenue=3019513.40, contra_revenue=127734.55, expense=3141114.12,
net_income=-249335.27`.

(If `expense`/`net_income` already moved, the data changed since diagnosis — STOP, re-derive
the target before proceeding.)

---

## Task 2: Transactional dry-run on ONE bill (zero persisted change)

Prove the two-RPC mechanism produces exactly the expected GL deltas, using a `BEGIN…ROLLBACK`
transaction so nothing is committed. (Verified that MCP `execute_sql` runs multi-statement
`begin; …; rollback;` and returns the mid-transaction SELECT.)

**Files:** none.

- [ ] **Step 1: Pick the representative bill (largest, Send Out) and run the dry-run**

```sql
begin;

-- resolve the largest single dup bill + its payment
create temporary table _t on commit drop as
select je.source_id as bill_id, bpa.payment_id,
       sum(jl.debit_php - jl.credit_php) as exp_amt
from public.journal_entries je
join public.bills b on b.id = je.source_id
join public.bill_payment_allocations bpa on bpa.bill_id = b.id
join public.journal_lines jl on jl.entry_id = je.id
join public.chart_of_accounts coa on coa.id = jl.account_id and coa.type='expense'
where je.status='posted' and je.source_kind='bill_post'
  and je.description ilike '%[history imported_at%'
  and je.posting_date between date '2026-01-01' and date '2026-05-31'
group by je.source_id, bpa.payment_id
order by exp_amt desc
limit 1;

-- void payment then bill (the app's guarded path)
select public.ap_void_bill_payment_cascade(
  (select payment_id from _t),
  '2026 books reconciliation — reverse duplicate history-imported AP bill (keep history_import layer; see docs/superpowers/specs/2026-06-08-books-recon-step1-void-duplicate-bills.md)',
  '8c25a556-e23b-427b-a6f9-fcd555b52f32') as payment_void;

select public.ap_void_bill_with_guard(
  (select bill_id from _t),
  '2026 books reconciliation — reverse duplicate history-imported AP bill (keep history_import layer; see docs/superpowers/specs/2026-06-08-books-recon-step1-void-duplicate-bills.md)',
  '8c25a556-e23b-427b-a6f9-fcd555b52f32') as bill_void;

-- ASSERTION: this bill's net contribution across expense+AP+cash is now 0,
-- and the duplicate expense for this bill is fully reversed.
select
  t.exp_amt as expected_reversed_expense,
  (select b.status from public.bills b where b.id = t.bill_id) as bill_status,
  (select bp.voided_at is not null from public.bill_payments bp where bp.id = t.payment_id) as payment_voided,
  -- net expense for THIS bill's source after originals+reversals (should be 0):
  (select coalesce(sum(jl.debit_php - jl.credit_php),0)
     from public.journal_entries je
     join public.journal_lines jl on jl.entry_id = je.id
     join public.chart_of_accounts coa on coa.id = jl.account_id and coa.type='expense'
    where je.status='posted'
      and (je.source_id = t.bill_id or je.source_id = t.payment_id)) as net_expense_after,
  -- net AP for this bill's source after originals+reversals (should be 0):
  (select coalesce(sum(jl.credit_php - jl.debit_php),0)
     from public.journal_entries je
     join public.journal_lines jl on jl.entry_id = je.id
     join public.chart_of_accounts coa on coa.id = jl.account_id and coa.code='2010'
    where je.status='posted'
      and (je.source_id = t.bill_id or je.source_id = t.payment_id)) as net_ap_after,
  -- net cash for this bill's source after originals+reversals (should be 0):
  (select coalesce(sum(jl.debit_php - jl.credit_php),0)
     from public.journal_entries je
     join public.journal_lines jl on jl.entry_id = je.id
     join public.chart_of_accounts coa on coa.id = jl.account_id and coa.code='1010'
    where je.status='posted'
      and (je.source_id = t.bill_id or je.source_id = t.payment_id)) as net_cash_after
from _t t;

rollback;
```
Expected in the final result row: `bill_status='voided'`, `payment_voided=true`,
`net_expense_after=0`, `net_ap_after=0`, `net_cash_after=0`, with
`expected_reversed_expense=320506.50` (the Send Out bill).

- [ ] **Step 2: Confirm nothing persisted (the rollback worked)**

```sql
select count(*) as still_active_payments
from public.bill_payments where voided_at is null;  -- expected 75 (unchanged)
```
Expected: `still_active_payments=75`. If not 75, the rollback failed — STOP and investigate.

---

## Task 3: HUMAN SIGN-OFF GATE (hard stop)

- [ ] **Step 1: Present the dry-run result + the exact committed query to the user and WAIT for explicit "go"**

Show the user: the Task 1 baseline (net −249,335.27), the Task 2 dry-run result (all three
net-after values = 0, bill voided, nothing persisted), and the Task 4 committed `DO` block
verbatim. State plainly: "This is the only committed prod write; after it the GL net for
Jan–May 2026 becomes +₱168,984.07. Proceed?" **Do not run Task 4 until the user explicitly
approves.** If they decline or want changes, stop here.

---

## Task 4: Committed atomic execution (only after sign-off)

Run all 75 bills in **one transaction** (atomic — all-or-nothing). The per-bill order
(payment → bill) holds because the payment-void's recompute trigger flips the bill to unpaid
within the same transaction before the bill-void reads its status. All RPCs are idempotent, so
a retry after any failure is safe.

**Files:** none (single MCP `execute_sql`).

- [ ] **Step 1: Run the atomic void DO block**

```sql
do $$
declare
  r record;
  v_reason text := '2026 books reconciliation — reverse duplicate history-imported AP bill (keep history_import layer; see docs/superpowers/specs/2026-06-08-books-recon-step1-void-duplicate-bills.md)';
  v_actor uuid := '8c25a556-e23b-427b-a6f9-fcd555b52f32';
  v_count int := 0;
begin
  for r in
    select distinct je.source_id as bill_id, bpa.payment_id
    from public.journal_entries je
    join public.bills b on b.id = je.source_id
    join public.bill_payment_allocations bpa on bpa.bill_id = b.id
    where je.status='posted' and je.source_kind='bill_post'
      and je.description ilike '%[history imported_at%'
      and je.posting_date between date '2026-01-01' and date '2026-05-31'
  loop
    perform public.ap_void_bill_payment_cascade(r.payment_id, v_reason, v_actor);
    perform public.ap_void_bill_with_guard(r.bill_id, v_reason, v_actor);
    v_count := v_count + 1;
  end loop;
  raise notice 'voided % bill+payment pairs', v_count;
end $$;
```
Expected: completes without error (notice: `voided 75 bill+payment pairs`).

---

## Task 5: Verification (read-only)

- [ ] **Step 1: GL net income is now +₱168,984.07; expense is ₱2,722,794.78**

```sql
with rng as (select date '2026-01-01' f, date '2026-05-31' t),
pl as (
  select coa.type, jl.debit_php, jl.credit_php
  from public.journal_lines jl
  join public.journal_entries je on je.id=jl.entry_id
  join public.chart_of_accounts coa on coa.id=jl.account_id
  cross join rng
  where je.status='posted' and je.posting_date between rng.f and rng.t
    and coa.type in ('revenue','contra_revenue','expense')
)
select
  sum(debit_php-credit_php) filter (where type='expense') as expense,
  sum(credit_php-debit_php) as net_income
from pl;
```
Expected: `expense=2722794.78, net_income=168984.07`.

- [ ] **Step 2: AP subledger fully unwound; cash phantom outflow removed**

```sql
select
  (select count(*) from public.bills where status <> 'voided') as active_bills,            -- expect 0
  (select count(*) from public.bill_payments where voided_at is null) as active_payments,  -- expect 0
  (select coalesce(sum(jl.credit_php-jl.debit_php),0)
     from public.journal_lines jl
     join public.journal_entries je on je.id=jl.entry_id
     join public.chart_of_accounts coa on coa.id=jl.account_id and coa.code='2010'
    where je.status='posted'
      and je.source_kind in ('bill_post','bill_payment')) as ap_net_from_ap_sources;       -- expect 0
```
Expected: `active_bills=0, active_payments=0, ap_net_from_ap_sources=0`.

- [ ] **Step 3: bill_post layer now nets to ₱0; history_import unchanged**

```sql
with rng as (select date '2026-01-01' f, date '2026-05-31' t)
select je.source_kind,
       sum(jl.debit_php - jl.credit_php) as expense_debit_net
from public.journal_lines jl
join public.journal_entries je on je.id = jl.entry_id
join public.chart_of_accounts coa on coa.id = jl.account_id and coa.type='expense'
cross join rng
where je.status='posted' and je.posting_date between rng.f and rng.t
group by je.source_kind order by expense_debit_net desc;
```
Expected: `history_import ≈ 2,722,794.78`; `bill_post = 0.00` (originals cancelled by
reversals). (`bill_payment` reversals carry no expense lines.)

- [ ] **Step 4: Books-tie invariant still holds (run the existing validator)**

Run `scripts/ops-daily/validate-expenses.sql` via MCP (the per-account Σ == `v_ops_daily_expenses`
== P&L expense by construction). Expected: ties to the peso, now at the lower (correct) total.

- [ ] **Step 5: Audit trail present**

```sql
select action, count(*) from public.audit_log
where action in ('bill.voided','bill_payment.voided')
  and actor_id = '8c25a556-e23b-427b-a6f9-fcd555b52f32'
group by action;
```
Expected: `bill.voided=75`, `bill_payment.voided=75`.

- [ ] **Step 6: Confirm the B1.3 tab + Financial Statements self-corrected (no code change)**

These are live GL views, so they reflect the new totals automatically. Spot-check via the
existing report query or a later authenticated UI smoke (optional, user-driven): the
Operations → Expenses & P&L tab YTD net and the Financial Statements page should now show the
corrected, higher net income for 2026. No deploy/code change required.

---

## Task 6: Document the outcome

- [ ] **Step 1: Append the result to the findings doc + spec, update memory**

Add a "Step 1 APPLIED 2026-06-08" section to
`docs/superpowers/specs/2026-06-07-books-reconciliation-2026-findings.md` (before/after net,
75 pairs voided, verification numbers). Update the two memory files
(`project_books_reconciliation_2026.md`, `project_ops_analytics_dashboard.md`) to mark Step 1
done and steps 2–4 as the remaining work. Commit the doc changes.

```bash
git add docs/superpowers/specs scripts/books-recon
git commit -m "docs(books): Step 1 applied — voided 75 duplicate AP bills, GL net Jan–May 2026 now +168,984.07"
```

- [ ] **Step 2: Report to the user + recommend next step**

Plain-English summary (what changed, the new net), and the decision point for steps 2–4
(rent income 4300, late-May import, March 6110 payroll) — recommend whether to continue now
or in a fresh context.

---

## Self-review notes

- **Spec coverage:** every spec section maps to a task — grounding facts → Task 1; mechanism →
  Tasks 2 & 4; dry-run → Task 2; sign-off gate → Task 3; verification list → Task 5; docs/scope
  → Task 6. ✔
- **No placeholders:** all SQL is concrete and runnable; the only `<…>`-style tokens were
  removed in favour of subselects/temp tables. ✔
- **Idempotency/retry:** Task 4 is atomic; RPCs return `already_voided=true` on re-run, so a
  retry never double-reverses. ✔
- **Numbers tie:** 3,141,114.12 − 418,319.34 = 2,722,794.78; −249,335.27 + 418,319.34 =
  +168,984.07; per-account dup (320,506.50 + 84,172.84 + 8,200 + 3,956 + 1,377 + 107) =
  418,319.34. ✔
