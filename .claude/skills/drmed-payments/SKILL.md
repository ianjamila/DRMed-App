---
name: drmed-payments
description: Use when working on DRMed payments, the payment-gating trigger, visits.payment_status recalculation, result release flow, refunds/voids, cash shifts, end-of-day reconciliation, HMO billing, gift code redemption, or the accounting GL bridge from payments. Trigger whenever the user mentions payment, payments table, payment method, cash, gcash, maya, card, bank transfer, HMO, hmo_providers, visit payment status, paid_php, payment_status, enforce_payment_before_release, trg_test_requests_payment_gate, recalc_visit_payment, trg_payments_recalc, advance_test_on_result_upload, trg_results_advance_test, void payment, refund, refunds, refund payment, discount, discount lines, voided_at, gift code, redeem, cash shift, cash drawer, EOD reconciliation, eod_cash_adjustments, cash_shifts, float, petty cash, payment routing, op_gl_bridge, AP subledger, translatePgError, or any /staff/payments/ route. Also trigger on "record a payment", "release a test", "why can't this test be released", "close the cash drawer", or anything where money flows through the system.
---

# DRMed payments, gating, and cash flow

## What this is

The money flow in DRMed: recording payments, gating result release on payment status, recalculating visit totals, voiding payments, end-of-day cash reconciliation, HMO billing, and the bridge to the accounting GL. The DB trigger (`enforce_payment_before_release`) is the source of truth for "can this result be released?" — UI checks are for UX only.

## Schema

```
visits (0001_init.sql:103–116)
  payment_status enum: 'unpaid', 'partial', 'paid', 'waived'
  paid_php, total_php
  payment_status indexed
  hmo_provider_id (added in 0011)

payments (0001_init.sql:167–177)
  amount_php, method enum: 'cash', 'gcash', 'maya', 'card', 'bank_transfer' (+ soft 'gift_code')
  reference_number, received_by, received_at
  voided_at, voided_by, void_reason (soft-void, added in 0030)

test_requests (0001_init.sql:131–150)
  status enum: 'requested', 'in_progress', 'result_uploaded', 'ready_for_release', 'released', 'cancelled'
  hmo_provider_id, hmo_approval_date (added in 0011)

services (0001_init.sql:88–100)
  price_php, requires_signoff
```

## Three trigger functions to know cold (all in `0001_init.sql`)

### 1. `enforce_payment_before_release()` — line ~317
- BEFORE UPDATE on `test_requests`
- Raises `check_violation` if `NEW.status='released'` AND `visit.payment_status NOT IN ('paid','waived')`
- Trigger: `trg_test_requests_payment_gate` (line ~340)
- **This is the source of truth.** UI/Server-Action checks are for UX only.

### 2. `recalc_visit_payment()` — line ~348
- AFTER INSERT on `payments`
- Sums `payments.amount_php WHERE visit_id=... AND voided_at IS NULL`
- Sets `visits.paid_php = sum`
- Sets `visits.payment_status`:
  - `'paid'` if `paid_php ≥ total_php`
  - `'partial'` if `paid_php > 0`
  - `'unpaid'` otherwise
- **Preserves `'waived'`** — doesn't overwrite (line ~374)
- Trigger: `trg_payments_recalc` (line ~384)

### 3. `advance_test_on_result_upload()` — line ~393
- AFTER INSERT on `results`
- Flips `test_requests.status` from `'in_progress'` to:
  - `'result_uploaded'` if `services.requires_signoff=true` (awaiting pathologist sign-off)
  - `'ready_for_release'` otherwise
- Trigger: `trg_results_advance_test` (line ~423)

## Server actions

| Action | Path | What it does |
|---|---|---|
| `recordPaymentAction()` | `src/app/(staff)/staff/(dashboard)/payments/new/actions.ts` | Validates via `PaymentRecordSchema`, inserts `payments` row, fires `audit({ action: 'payment.recorded' })` with `ipAndAgent()`, redirects to visit detail |
| `voidPaymentAction()` | `src/app/(staff)/staff/(dashboard)/payments/[id]/void/actions.ts` | Validates reason, reads payment, resets linked `gift_codes.status` back to `'purchased'`, sets `voided_at/by/void_reason`, fires audit. P0007 guard prevents un-voiding. |
| `recordCashAdjustmentAction()` | `src/app/(staff)/staff/(dashboard)/payments/cash-drawer/actions.ts` | Inserts `eod_cash_adjustments`. Role-gated to reception/admin. |
| `getCashDrawerStateAction()` | same | Calls RPC `cash_drawer_state` |

Validation schemas live in `src/lib/validations/payment.ts` (`PaymentRecordSchema`) and `accounting.ts`.

## Cash shift / EOD reconciliation (migration `0043_eod_cash_reconciliation.sql`)

- **`cash_shifts`** — `(code, label, sort_order)` enum. E.g., `morning`, `afternoon`. Open/close tracked per `business_date`.
- **`eod_cash_adjustments`** — records petty cash, salary advances, courier fees, float top-ups/pull-outs. `kind` enum: `float_initial, float_topup, float_pullout, petty_cash_in, petty_cash_out, salary_advance, courier_fee` (+ `salary_payout` added in `0044`).

UI: `/staff/payments/cash-drawer/` + `/staff/payments/eod/` (declare cash, close shift, variance).

## HMO billing (migration `0011_accounting_capture.sql`)

- **`hmo_providers`** — 11 providers seeded via `scripts/seed-hmo-providers.ts` (Maxicare, Intellicare, Etiqa, Avega, Valucare, iCare, Cocolife, Med Asia, Generali, Amaphil, Pacific Cross).
- Each has `due_days_for_invoice` (default 30).
- `visits.hmo_provider_id` and `test_requests.hmo_provider_id` link the visit/test to a provider.
- HMO payments are just normal `payments` rows with `method='hmo'` (effectively, the patient's HMO portion).
- No distinct approval-gating trigger — `hmo_approval_date` is informational.

## Refunds / voids

**Soft-void only.** Once `voided_at` is set, `voidPaymentAction()` refuses to un-void (P0007 guard). Staff must create a new payment row instead.

Void flow:
1. Read payment by id
2. Check `voided_at IS NULL` (P0007 if not)
3. If linked `gift_code` exists, reset its `status` from `'redeemed'` back to `'purchased'`
4. UPDATE payment: `voided_at = now(), voided_by = session.user_id, void_reason = reason`
5. Fire reversal JE via the GL bridge (migration `0030`)
6. `audit({ action: 'payment.voided' })`

**Known gap:** void of payment + gift-code reset are two separate writes, not in one transaction. Accepted trade-off in Phase 12.2.

## Accounting GL bridge (Phases 12.2–12.4, migrations `0030_op_gl_bridge.sql` + `0049_ap_subledger_behavior.sql`)

- **Payment insert** → fires JE: DR cash / CR AR-Patient or AR-HMO
- `payment_method_account_map` table routes each method (cash, gcash, etc.) to a cash CoA account
- **Test release** → fires revenue JE (supports HMO partial-approval splits + discount lines)
- **Void/cancel** → fires reversal JE
- Admin UI to edit method→CoA map: `/staff/admin/accounting/payment-routing/`

## PG error translation

`src/lib/accounting/pg-errors.ts` has `translatePgError(err)` (called from 117+ places per the codebase graph). Custom error codes P0004–P0014 are caught and translated to user-facing strings (e.g., "Cannot release: visit not fully paid", "Cannot un-void a voided payment").

When you add a new custom PG error in a trigger or function, add the translation here.

## Routes

| Route | Purpose |
|---|---|
| `/staff/payments/new?visit_id=...` | Record payment |
| `/staff/payments/[id]/void` | Void modal (in visit detail) |
| `/staff/payments/cash-drawer/` | EOD adjustments UI |
| `/staff/payments/eod/` | Close shift, declare cash, variance |
| `/staff/admin/accounting/payment-routing/` | Edit method → CoA map (admin) |

## Hard rules

- **The trigger is the source of truth.** Never bypass `trg_test_requests_payment_gate` by reaching for the admin client to force `test_requests.status='released'`. The trigger fires regardless of role.
- **Never manually SET `visits.payment_status`.** It's computed by `recalc_visit_payment()` on every payment insert. The only legitimate manual override is `'waived'` (which the trigger preserves).
- **Soft-void only.** Don't DELETE a payment row — it leaves audit gaps. Mark `voided_at` instead.
- **Always audit-log both record and void** via `audit({ action: 'payment.recorded' | 'payment.voided' })` with `ipAndAgent()` for IP/UA. RA 10173 obligation.
- **HMO payments are just `payments` rows** with `method='hmo'`. Don't invent a separate table.
- **Gift code redemption is two writes, not one** (payment insert + gift_codes.status update). Both must succeed; if the gift code update fails after the payment insert, you have an orphaned redemption — manual cleanup needed.
- **`paid_php` is denormalized** — never read it without trusting the trigger keeps it in sync. If you suspect drift, sum `payments` directly.
- **Cash-drawer / EOD adjustments are role-gated to reception/admin** in the action. Don't bypass.
- **When adding a new payment method**: add it to the `payments.method` enum (new migration), to `PaymentRecordSchema`, to `payment_method_account_map` (with the right cash CoA account), and to the UI dropdown. Missing any of these breaks the GL bridge silently.

## When this skill should NOT trigger

- Auth / RLS / general audit-log obligations — use `drmed-rls-and-auth` (which covers the `audit()` call pattern, ipAndAgent, set_patient_context).
- New tables / schema changes not touching payments — use `drmed-migrations`.
- Result template rendering (PDFs) — use `drmed-result-templates`.
- Patient portal payment views (not a flow that exists; patients don't pay through the portal).
- Marketing-site or appointments work that doesn't involve the cash flow.
