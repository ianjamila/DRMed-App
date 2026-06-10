# Books Reconciliation — Step 1: Reverse the 75 Duplicate History-Imported AP Bills

**Date:** 2026-06-08
**Status:** Execution spec — approved design, plan + prod write pending sign-off
**Depends on:** `2026-06-07-books-reconciliation-2026-findings.md` (diagnosis)
**Scope:** Step 1 only (the dominant duplicate-expense fix). Steps 2–4 (book Rent
Received 4300, re-run late-May import, fix March 6110 payroll double) are deferred to a
later session and will be investigated/decided after Step 1 lands and verifies.

## Goal

Remove the duplicate expense (and the phantom cash outflow that came with it) that the
historical books setup booked **twice** — once as 306 direct `history_import` JEs (which
tie to the clinic's manual Income Statement) and again as 75 `bill_post` AP bills tagged
`[history imported_at=…]`. We keep `history_import` (decided) and reverse the 75 AP bills.

**Target:** GL net income (Jan–May 2026, posted) rises from **−₱249,335.27** to
**+₱168,984.07** (expense −₱418,319.34); cash-on-hand phantom outflow of ₱418,319.34 is
removed; the AP subledger fully unwinds to ₱0.

## Grounding facts (verified on prod `qhptbmafrosgibooelpp`, 2026-06-08, read-only)

- **75 duplicate `bill_post` expense entries**, one per bill, all posting_date Jan–May 2026,
  all tagged `[history imported_at=…]`. Total expense debit **₱418,319.34**.
- **All 75 bills are `status='paid'`**, each paid in full by exactly one cash bill_payment
  (BP-2026-0001 … BP-2026-0075), method `cash`, all crediting **1010 Cash on Hand**.
  So each duplicate is a full lifecycle: `Dr expense / Cr 2010 AP` (bill) **+**
  `Dr 2010 AP / Cr 1010 Cash` (payment).
- **The entire AP subledger is nothing but these 75 duplicates** — `bills` = 75 rows (all
  `BL-2026-…`), `bill_payments` = 75 rows, `bill_post` JEs = 75 (all history-tagged). There
  are **zero genuine live AP bills**, so the fix cannot affect any real bill.
- **Baseline P&L (Jan–May 2026, posted):** revenue ₱3,019,513.40, contra_revenue
  ₱127,734.55, expense ₱3,141,114.12, **net income −₱249,335.27** (matches diagnosis).
- **Admin actor for attribution:** Ian Jamila, `staff_profiles.id =
  8c25a556-e23b-427b-a6f9-fcd555b52f32`.

## Mechanism — the app's own guarded void path, batched

Per bill, two **idempotent** RPC calls in this order (the payment must be voided first to
clear the bill-void guard P0029). Both post **reversal JEs** (the originals remain, giving a
clean audit trail) and write `audit_log` rows. Run via the Supabase MCP `execute_sql`.

1. `ap_void_bill_payment_cascade(p_payment_id, p_reason, p_actor_id)`
   → reversal JE `Dr 1010 Cash / Cr 2010 AP`; cascades to allocations; recompute trigger
   flips the bill back to unpaid (`posted`).
2. `ap_void_bill_with_guard(p_bill_id, p_reason, p_actor_id)`
   → reversal JE `Dr 2010 AP / Cr <expense acct>`; sets bill `status='voided'`.

**Actor:** `8c25a556-e23b-427b-a6f9-fcd555b52f32` (Ian Jamila).
**Void reason (both calls):**
`2026 books reconciliation — reverse duplicate history-imported AP bill (keep history_import layer; see docs/superpowers/specs/2026-06-08-books-recon-step1-void-duplicate-bills.md)`

### Net accounting effect (all 75)

| Account | Δ | Result |
|---|--:|---|
| Expense (various 6xxx) | −₱418,319.34 | net income −249,335.27 → **+168,984.07** |
| 1010 Cash on Hand | +₱418,319.34 | phantom cash outflow removed |
| 2010 Accounts Payable | ₱0 net | subledger fully unwound |

The bill_post layer nets to ₱0 across all accounts after both voids; `history_import`
remains as the sole booking, tying to the manual Income Statement.

## De-risking: transactional dry-run BEFORE any committed write

On a SINGLE representative bill, in one MCP statement:

```sql
BEGIN;
  select public.ap_void_bill_payment_cascade('<payment_id>', '<reason>', '<actor>');
  select public.ap_void_bill_with_guard('<bill_id>', '<reason>', '<actor>');
  -- assert: this bill's expense + AP + cash now net to 0 across original+reversal JEs;
  -- assert: bill.status='voided', payment.voided_at set
ROLLBACK;
```

This proves the mechanism produces exactly the expected GL deltas with **zero** persisted
change. Only after the dry-run output is confirmed and the user signs off do we run the real
committed calls.

## Execution (committed, only after sign-off)

- Run all 150 calls (75 × payment-void then bill-void). RPCs are idempotent, so a re-run or
  partial-failure retry is safe (`already_voided=true` is returned, no double reversal).
- Order matters per bill (payment before bill); across bills order is irrelevant.
- Each call is its own committed transaction (MCP autocommit) — acceptable because every step
  is independently idempotent and audit-logged.

## Verification (after the committed write)

1. **GL net income** (Jan–May 2026, posted) = **+₱168,984.07**; expense = ₱2,722,794.78.
2. **AP subledger** fully voided: 0 active bills, 0 active payments, AP account balance ₱0.
3. **Books-tie invariant** still holds — re-run `scripts/ops-daily/validate-expenses.sql`
   (per-account == `v_ops_daily_expenses` == P&L expense, by construction).
4. **Re-run `scripts/books-recon/reconcile-2026.sql`** — `bill_post` layer now nets ₱0;
   `history_import` ≈ the sheet.
5. **B1.3 tab + Financial Statements page** self-correct (live GL views — no code change).
   Operational headline net rises by ₱418,319.34 accordingly.
6. **Audit:** 150 new `audit_log` rows (`bill_payment.voided` + `bill.voided`) + 150 reversal
   JEs attributable to the actor.

## Out of scope (this step)

- Steps 2–4 of the findings doc (rent income 4300; late-May import; March 6110 payroll).
- Any change to the `history_import` JEs (kept as the books of record).
- 2024–2025 re-check for the same pattern (none found for AP — all 75 `bill_post` are 2026;
  revisit only if other history layers are re-imported).

## Rollback

Voids post reversal JEs rather than deleting data, so the originals are intact. If a void
must itself be undone, the bill/payment can be re-created via the normal AP path; but given
the subledger is 100% confirmed-duplicate, this is not expected. The transactional dry-run is
the real safety net — we confirm correctness on a throwaway transaction before committing.
