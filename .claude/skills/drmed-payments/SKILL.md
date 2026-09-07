---
name: drmed-payments
description: Use when working on DRMed money flow — payments, the payment-gating trigger, visits.payment_status recalculation, result release, refunds/voids, discounts, doctor fees (consult / procedure, clinic cut, PF), the lab-queue payment gate, receipts and print slips, queue deletion of unpaid entries, cash drawer / EOD close / denomination count, HMO billing, PF payouts, or the accounting GL bridge. Trigger whenever the user mentions payment, payments table, payment method, cash, gcash, maya, card, bank transfer, bpi, maybank, HMO, hmo_providers, visit payment status, paid_php, payment_status, waived, enforce_payment_before_release, trg_test_requests_payment_gate, recalc_visit_payment, advance_test_on_result_upload, void payment, refund, discount, discount_types, senior/PWD, statutory, discount_kind, lineDiscount, gift code, redeem, cash shift, cash drawer, EOD, end of day, close the till, denomination, count sheet, cash count, eod_close_records, eod_cash_adjustments, cash_drawer_state, petty cash, float, consultation fee, procedure fee, clinic cut, clinic_cut_php, doctor PF, doctor_pf_php, doctorLineBase, P0034, attending physician, mark consultation done, PF payout, pf_disbursement, acknowledgment slip, amount in words, receipt, consult-only receipt, portal PIN slip, lab queue gate, labQueueGate, awaiting payment, delete queue entry, soft delete, deleted_at, restore, P0042–P0048, payment routing, op_gl_bridge, bridge_test_request_released, AP subledger, translatePgError, or any /staff/payments/ route. Also trigger on "record a payment", "release a test", "why can't this test be released", "why isn't this test in the lab queue", "close the cash drawer", or anything where money flows through the system.
---

# DRMed payments, gating, and cash flow

## What this is

The money flow in DRMed: pricing a visit (discounts, doctor fees), recording payments, gating result release AND lab work on whether the money is settled (paid, waived, or HMO-billed), voiding, deleting unpaid queue entries, end-of-day cash close, HMO billing, doctor PF payouts, and the bridge to the accounting GL. **DB triggers are the source of truth** — `enforce_payment_before_release` for release (0133: HMO visits pass unpaid), the 0125 guards for deletion, `guard_statutory_discount` for the senior rate, `eod_close_denominations_check` for the till count. UI checks are UX only.

## Schema (current shape)

```
visits
  payment_status: 'unpaid' | 'partial' | 'paid' | 'waived'   (computed by trigger; 'waived' is the only manual write)
  paid_php, total_php (denormalised), hmo_provider_id (0011), visit_group_id (0090 — split encounters fold in the UI)
  visit_date default (now() at time zone 'Asia/Manila')::date (0127)
  deleted_at / deleted_by / delete_reason (0125)

payments
  amount_php, method: 'cash' | 'gcash' | 'maya' | 'card' | 'bank_transfer' | 'hmo' | 'bpi' | 'maybank'  (0011 CHECK) + soft 'gift_code'
  reference_number, received_by, received_at
  voided_at / voided_by / void_reason (soft-void; recalc on void since 0111)

test_requests
  status: 'requested' | 'in_progress' | 'result_uploaded' | 'ready_for_release' | 'released' | 'cancelled'
  final_price_php (snapshot), discount_kind → FK discount_types(code) (0128; was a CHECK from 0011)
  clinic_fee_php, doctor_pf_php (doctor lines, 0064), attending physician resolved coalesce(line, visit)
  is_package_header / parent_id (0040), assigned_to, deleted_at/by/reason (0125)

services
  kind: 'lab_test' | 'lab_package' | 'doctor_consultation' | 'doctor_procedure' | …, price_php, requires_signoff,
  senior_pwd_eligible (0098), senior_discount_php (0067 — READ-ONLY legacy, only price history shows it)

discount_types (0128)   code (immutable slug) | label | kind percent|fixed|custom | rate | is_statutory | active
physicians (0129)       compensation_arrangement pf_split|shareholder|rent_paying, default_consultation_fee_php, clinic_cut_php
eod_close_records       counted_cash_php + counted_denominations jsonb (0132: bill_1000..bill_20, coin_20..coin_0.25 — ₱20 bill and coin are separate piles)
```

## Trigger functions to know cold

| Function / trigger | Where | Behaviour |
|---|---|---|
| `enforce_payment_before_release()` → `trg_test_requests_payment_gate` | 0001, **0133** | BEFORE UPDATE on `test_requests`; raises when `NEW.status='released'` and the visit is neither in `('paid','waived')` NOR HMO-billed. 0133 added the `hmo_provider_id is not null` carve-out so the release gate matches `labQueueGate` — one definition of "money is settled". Fires for **mark consultation/procedure done** too: `markDoctorLineDoneAction` writes `status='released'` directly. |
| `recalc_visit_payment()` → `trg_payments_recalc` (+ `_on_void`, 0111) | 0001/0111 | Sums non-voided payments → `paid_php`, sets `payment_status` paid/partial/unpaid; **preserves `'waived'`**. |
| `advance_test_on_result_upload()` | 0001/0059 | On result link (and on `results.finalised_at` NULL→set) flips `in_progress` → `result_uploaded` (if `requires_signoff`) else `ready_for_release`. |
| `bridge_test_request_released()` | 0030 … 0109, 0131 | Release → revenue JE (HMO splits, discount lines) + `doctor_pf_entries` accrual. **P0034** (attending physician required) fires only when `coalesce(doctor_pf_php,0) > 0` (0131) — a ₱0-PF procedure with no physician releases fine. |
| `enforce_consent_before_release()` | 0086/0088 | Same transition; blocks when the consent gate is ON and the patient has no current consent. |
| 0125 deletion guards | 0125 | P0042 visit not unpaid · P0043 line released · P0044 deleting a package component directly · P0045 payment against a deleted visit · P0046 payment_status change on a deleted visit. `fn_queue_delete_cascade` cascades header↔components on delete and restore; per-line delete recalcs `total_php` by the snapshotted `final_price_php` delta. |
| `guard_statutory_discount()` | 0128 | P0047 on any rate/code/active change or delete of the statutory Senior/PWD row; `discount_types_one_statutory_idx` caps it at one row. |
| `eod_close_denominations_check()` | 0132 | P0048: unknown slug, non-integer/negative count, or breakdown ≠ `counted_cash_php`. NULL is skipped so admin can reopen legacy closes. |

## Pure helpers (vitest-covered, no DB) — reuse, don't re-derive

| Module | What it decides |
|---|---|
| `src/lib/pricing/discounts.ts` — `lineDiscount`, `discountOptionsFor` | One arithmetic for the form preview AND the create action's authoritative recompute. A statutory code posted against a senior-ineligible line is dropped entirely (no ₱0 senior line). |
| `src/lib/visits/consultation-fee.ts` — `defaultClinicFee`, `splitDoctorFee`, `doctorLineBase` | Doctor-line pricing. Blank consult fee = ₱0 (rejected); blank procedure fee = catalog price. `clinic_cut_php` override applies to CONSULT lines only; procedures default to a flat ₱0 clinic fee (doctor PF = full fee). |
| `src/lib/visits/money-settled.ts` — `moneySettled`, `MONEY_SETTLED_VISITS_OR` | The single definition: "money is settled" = `payment_status in ('paid','waived') OR hmo_provider_id is not null`. Mirrors migration 0133's SQL; the test pins the SQL text so the two cannot drift. Used by `labQueueGate` and by the visit page's `canRelease` (which gates the Release / Release-all / bulk / Mark-done buttons). |
| `src/lib/visits/lab-gate.ts` — `labQueueGate`, `LAB_QUEUE_GATE_VISITS_OR` | Thin wrapper over `moneySettled` plus the "waiting for payment" hint. Applied to the lab worklist (All/Mine) via `.or(LAB_QUEUE_GATE_VISITS_OR, { foreignTable: "visits" })` on the `visits!inner` embed, and to `claimTestAction` / `claimConsolidated`. Pending-release / Released-today stay ungated. |
| `src/lib/visits/deletion.ts` — `visitDeletability`, `testDeletability`, `QUEUE_DELETE_ROLES` | Deletable ⇔ `payment_status='unpaid'` (waived is NOT deletable — it can hold released results). Never keys on queue visibility, so it composes with the lab gate. |
| `src/lib/visits/receipt-policy.ts` — `isConsultOnlyOrder`, `shouldPrintReceipt` | Consult-only visit (every non-deleted line classifies as `consult`) prints NO receipt; procedures still print; unknown kinds and empty lists print (fail-safe). |
| `src/lib/visits/classification.ts` | Lab Tests is the COMPLEMENT of the two doctor kinds, never an allow-list. `foldVisitGroups` merges split encounters. |
| `src/lib/accounting/cash-denominations.ts` | The 11 denomination slugs; totals in **centavos** (₱0.25 × n drifts in float). Mirrored by the SQL values table + P0048 whitelist — `cash-denominations.parity.test.ts` parses migration 0132 to keep all three in step. |
| `src/lib/accounting/amount-in-words.ts`, `pf-labels.ts` | Peso amounts spelled out (voucher convention); bookkeeper vs doctor-facing basis labels. |
| `src/lib/accounting/pg-errors.ts` — `translatePgError` | P0001–P0034, P0040–P0048 → user-facing strings. Add a case for every new `raise`. |
| `src/lib/dates/manila.ts` — `manilaRangeUtc`, `isISODate`, `shiftISODate`, `todayManilaISODate` | Every date bound is a **half-open Manila window** (`gte` start, `lt` next day). Never build `${d}T00:00:00` strings — Postgres reads them as UTC, 8 hours early. |

## Server actions & routes

| Concern | Where |
|---|---|
| Record payment | `…/payments/new/actions.ts` → `recordPaymentAction` (`PaymentRecordSchema` in `src/lib/validations/payment.ts`), `audit({ action: 'payment.recorded' })` |
| Void payment (soft) | `…/payments/[id]/void/actions.ts` → `voidPaymentAction`; resets a linked gift code to `'purchased'`; P0007 blocks un-void; reversal JE via the bridge |
| Waive balance (admin) | `…/visits/[id]/actions.ts` → `waiveVisitBalanceAction` — the one legitimate manual `payment_status` write; guarded against deleted visits |
| Mark consult / procedure done | `…/visits/[id]/actions.ts` → `markDoctorLineDoneAction` (+ thin `markConsultationDoneAction` / `markProcedureDoneAction`); PF accrues via the 0064 trigger on release |
| Assign attending physician | visit detail `attending-physician-dialog.tsx` (reception/admin) — the fix for a P0034 dead end |
| Queue deletion / restore | `src/lib/actions/visits/queue-deletion.ts`; dialog `src/components/staff/queue-delete-dialog.tsx`; admin report `/staff/admin/reports/deleted-entries` |
| Re-issue portal PIN (consult-only visits) | `src/lib/actions/visits/reissue-pin.ts` + `src/components/staff/reissue-pin-button.tsx` — prints a portal-access slip (DRM-ID + PIN, no billing) |
| No-receipt notice | `src/components/staff/no-receipt-notice.tsx` — both receipt routes render this instead of 404 when policy suppresses the slip |
| Discounts admin | `/staff/admin/discounts` (list / new / edit), `src/lib/validations/discount-type.ts`; nav under Catalog & setup |
| Cash drawer / EOD | `/staff/payments/cash-drawer`, `/staff/payments/eod` (close by denomination; `CloseEodSchema` in `src/lib/validations/accounting.ts` — `counted_cash_php` is derived server-side, not posted), `/staff/payments/eod/[closeId]/count-sheet` (A5 print, reception/admin, audited `eod_close.count_sheet_viewed`), `/staff/payments/petty-cash` |
| Admin cash report | `/staff/admin/operations/cash` — denomination sub-row, CSV in pieces, "Cash count trends" panel (`denomination-trends.ts`) |
| PF payouts | `/staff/admin/accounting/pf-payouts` (`src/lib/actions/accounting/pf-disbursements.ts`), acknowledgment slip at `pf-payouts/[id]/slip` (A4, two copies, audited `pf_disbursement.slip_printed`) |
| GL routing | `/staff/admin/accounting/payment-routing` (method → CoA map), `cash-routing`, `hmo-claims`, `patient-ar` |
| Visits archive export | `/api/admin/visits.csv` — admin, RLS-scoped client (not service-role), chunked past the 1000-row cap, audited `visits.exported` |

## Doctor lines (consult + procedure)

- Two doctor kinds: `doctor_consultation` (fee typed at the counter, prefilled from `physicians.default_consultation_fee_php`, split by `clinic_cut_php` / arrangement) and `doctor_procedure` (fee from catalog unless typed; clinic fee flat ₱0). **Prod had zero `doctor_procedure` services as of 2026-08-06** — procedure paths are exercised only by tests.
- Physician required at intake only when the line's PF > 0; release mirrors that (0131). The visit-detail amber "release blocked" warning scopes to PF-accruing lines.
- `voidPfDisbursement` UNLINKS every entry from the batch, so a voided payout always lists zero entries — anything that compares entries to the header must skip voided batches.

## Discounts

Admin-managed `discount_types` catalog. Kinds `percent` / `fixed` / `custom` (custom = counter-typed amount; a built-in row admins may rename/deactivate but never create). Legacy codes `pct_10` / `pct_5` / `other_pct_20` / `senior_pwd_20` are load-bearing: `src/lib/accounting/mappers.ts` routes Sheets export columns by code equality and receipts key the senior-ID section on `senior_pwd_20`. Deactivate, never delete. The new-visit form loads the catalog at page load; the create action re-queries `active=true`, so a mid-session deactivation silently drops the previewed discount (accepted).

## Cash close / EOD

- `cash_shifts` (`morning`/`afternoon`), `eod_close_records` per `business_date` + shift, `eod_cash_adjustments` (`float_initial`, `float_topup`, `float_pullout`, `petty_cash_in/out`, `salary_advance`, `courier_fee`, `salary_payout`).
- The close grid is the source of truth: counted total and difference are computed from denominations, never typed.
- `cash_drawer_state` is **service_role-only** (0118; re-created in 0132 with the ACL restated). Don't re-grant `authenticated`.
- **Trends panel wording is deliberately loose** ("consistent with …"): payments record amounts, not the notes handed over, so no per-denomination expectation exists. Attribution is arithmetic only; centavo residue = keyed amount, not a miscount. Don't tighten it.

## HMO

`hmo_providers` (seeded by `scripts/seed-hmo-providers.ts`), `visits.hmo_provider_id` / `test_requests.hmo_provider_id`, `due_days_for_invoice`. **An HMO-billed visit passes both the lab gate and the release gate while unpaid** (0133) — the patient gets the result at the counter and the GL bridge books the receivable into 1110 AR HMO on release, which is what creates the claim. Do NOT reach for admin "waive balance" to unblock an HMO visit: waiving writes off a collectible. The reception queue's stage helper (`queue-stage.ts`) stays payment-only on purpose — "waiting" means the counter has cash to collect, and an HMO visit has none. HMO settlements are ordinary `payments` rows with `method='hmo'`; claims tracking lives under `admin/accounting/hmo-claims` + `patient-ar`. No approval-gating trigger — `hmo_approval_date` is informational.

## Accounting GL bridge (0028–0033, 0048/0049, 0064)

- Payment insert → JE (DR cash account per `payment_method_account_map` / CR AR-Patient or AR-HMO).
- Test release → revenue JE with HMO splits + discount lines + doctor PF accrual (`bridge_test_request_released`).
- Void / undo-release → reversal JE.
- Everything routes through service-role RPCs (`ap_*`, `reverse_petty_cash_entry`, …) that take `p_actor_id` from `requireAdminStaff()` — that is NOT a spoofing hole (0118 revoked JWT callers; investigated and closed).

## Hard rules

- **Triggers are the source of truth.** Never force `status='released'`, `deleted_at`, or a statutory rate through the admin client.
- **Never manually SET `visits.payment_status`** except `'waived'` via `waiveVisitBalanceAction`.
- **Soft-void only; soft-delete only.** No row deletes on `payments`, `visits`, `test_requests`.
- **Every read of visits/test_requests filters `deleted_at is null`** (queues, results, dashboards, receipts, exports, portal, sheet export). Mirror an existing query.
- **Every date filter uses `manilaRangeUtc`.**
- **Audit both record and void**, every print/export that discloses patient data (`*_printed`, `*_viewed`, `*.exported`), and every deletion/restore (reason required).
- **New payment method** = migration widening `payments_method_check` + `PaymentRecordSchema` + `payment_method_account_map` row + UI dropdown. Missing one breaks the GL bridge silently.
- **New P-code → `pg-errors.ts` translation** in the same PR.
- **Print surfaces**: each adds a named `@page` + `@media print` block at the tail of `src/app/globals.css` (`payout-slip` A4, `cash-count` A5, receipts A5). Two print PRs in flight always conflict there; resolution is keep both.
- **PostgREST**: no aggregates (`PGRST123`), 1000-row cap, and multi-row inserts NULL-fill keys missing from some rows (not column defaults) — carry a uniform key set (`Required<Pick<…>>`).

## When this skill should NOT trigger

- Auth / RLS / general audit-log obligations — `drmed-rls-and-auth`.
- New tables / schema changes not touching money — `drmed-migrations`.
- Result template rendering (PDFs) — `drmed-result-templates`.
- Appointments / registration (pre-visit) — `drmed-booking-and-intake`.
- Patients don't pay through the portal — there is no portal payment flow.
