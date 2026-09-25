# Waived balance → GL (discount + clear AR) — design

Status: approved design rules (Codex Astra high review 2026-09-25, session 01a0d7b8-76c5-7e21-9948-f1ca0d48d541), built as PR B on `feat/waived-balance-gl` after PR A (#233). Migration **0183**, P-codes **P0069–P0071** (claimed via `npm run claim`).

## Problem

`waiveVisitBalanceAction` flips `visits.payment_status` to `'waived'` and posts nothing. The release bridge (`bridge_test_request_released`, 0159) then books every line at full price: DR 1100 AR Patients / CR revenue. Nothing ever credits 1100 for the waived remainder, so it sits in AR forever and revenue is overstated. Owner decision: book the waived remainder as a discount (4910 lab / 4920 doctor) and clear 1100. Prod had 0 waived visits on 2026-09-25 (re-count before pushing).

The Record payment page (`payments/new`) is reachable by URL for a waived visit and shows a "Balance" it would happily accept a payment against.

## Rules (verified by Codex; each has a task in the plan)

1. **One per-line allocation.** At waive time the remainder (`total_php − Σ non-voided payments`) is split across the visit's priced live lines (`parent_id is null`, `final_price_php > 0`, not cancelled, not deleted — ₱0 package components excluded) by the **largest-remainder** method in centavos, bounded 0..line amount. The allocation is stored (`visit_waiver_allocations`, one row per line). For a line already `released` the discount JE posts at waive time; for a line released later, the allocation is **folded into that line's release JE** (DR 1100 for `final − waived`, DR 4910/4920 for `waived`, CR revenue unchanged). `recognised_at` / `journal_entry_id` on the allocation record what posted, so a replay never double-posts.
2. **Undo-release and cancel reverse the allocation atomically.** A folded allocation is reversed with its release JE (the mirror reversal already covers it); a standalone waiver JE is reversed by the same bridges, and the allocation is marked unrecognised so a re-release folds it again. No path is blocked; the recovery is automatic.
3. **Waiver amount fixed at waive time** (`visits.waived_php/waived_at/waived_by/waive_reason`). Money-changing operations on a waived visit are refused **at the DB** (payment insert, void, move onto/off): P0070. The one exception is an Edit that keeps the amount (method/reference/notes) through `correct_payment`, which inserts the replacement before voiding the original — the RPC sets `app.waived_visit_edit = 'on'` for its own transaction after proving the amount is equal and the visit is the same.
4. **DB guard on entering/leaving `'waived'`** (P0069): entering is allowed only inside `waive_visit_balance()` (it sets `app.waive_visit = 'on'` for its transaction); leaving is never allowed. RLS `visits: staff full` lets every staff role update `payment_status` directly; the trigger closes that.
5. **One lock order.** `waive_visit_balance` locks the `visits` row `FOR UPDATE` first and only *reads* payments; the payment guard trigger locks the `visits` row `FOR UPDATE` before deciding; `recalc_visit_payment` already does. `correct_payment` locks the payment then the visit — a payment lock is never taken by the waiver, so no cycle. A two-session race test (`supabase/tests/0183_waiver_race_smoke.sql`, dblink) proves both orders: payment-then-waive sees the payment; waive-then-payment refuses the payment.
6. **Provenance per row.** `visits`, `test_requests` and `payments` each carry `legacy_import_run_id`. All live → allocate + post. All imported (visit and every live line and every non-voided payment) → set `'waived'` with **no** allocations and no JE (the import never posted). Mixed → refuse (P0071) pending reconciliation.
7. **Reversals follow the ledger rule**: a reversal marks the original `'reversed'` and posts a mirrored `'posted'` entry (0173); totals count both. Posting date = Manila date. A closed month refuses through `je_period_lock_check` (P0002) and the action surfaces it in plain words. New P-codes are translated in `pg-errors.ts` and covered by `pg-error-coverage.test.ts`.

## Not in scope

Un-waive (none exists). Refunds. The 6 legacy owing rows (owner decision; waiving them posts nothing by rule 6). Changing what the statement shows (it already reads "Balance waived" / "Nothing due").

## Accounting check

Lab line, price 500, later waived 200 then released: DR 1100 300 · DR 4910 200 · CR 4100 500 (plus DR 4910 for any catalog discount as before). Doctor line, final 800 = clinic fee 300 + PF 500, waived 100: DR 1100 700 · DR 4920 100 · CR 4200 300 · CR 2110 500. Per visit after everything: 1100 = Σ final − paid − waived = 0. PF is unaffected by a waiver (owner rule: the clinic absorbs; no clawback).

Original relevance analysis (kept for the record): `docs/superpowers/specs/2026-09-25-waived-balance-gl-relevance.md`.
