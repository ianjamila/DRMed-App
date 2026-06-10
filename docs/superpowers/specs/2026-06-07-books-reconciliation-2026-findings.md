# 2026 Books Reconciliation — GL vs manual Income Statement (Jan–May 2026)

**Date:** 2026-06-07
**Status:** DIAGNOSIS COMPLETE — fix not yet applied (prod writes, needs sign-off)
**Trigger:** The B1.3 "Expenses & P&L" tab showed Jan–May 2026 **net income −₱306k**,
but the clinic's manual Income Statement shows **+₱262,142.86**. This documents the
root cause (it is **not** a B1.3 bug — the tab faithfully reports the GL) and the fix plan.

**Sources:**
- App GL: prod project `qhptbmafrosgibooelpp`, posted journal entries (via Supabase MCP).
- Manual income statement: `~/Downloads/DR MED MASTERSHEET (1).xlsx` → tab
  **"Income Statement Monthly (2026)"** (current; May complete, EBIT +₱262,142.86).
  (The older `DR MED MASTERSHEET.xlsx` dated May 27 had May incomplete — do not use.)
- Rent income source: `~/Downloads/DOCTOR'S RENT _ SOA.xlsx` → **RENT TRACKER** /
  **RENT BILLING** (per-doctor rent ledger, Dec 2023→; **still being completed**).
- **June 2026 is intentionally ignored** (partial in both systems).

## Headline

| | GL (app books) | Manual sheet | Gap |
|---|--:|--:|--:|
| Net revenue | 2,891,778.85 | 2,979,930.64 | −88,151.79 (GL low) |
| Total expenses | 3,141,114.12 | 2,717,787.78 | +423,326.34 (GL high) |
| **Net income** | **−249,335.27** | **+262,142.86** | **511,478.13** |

(The tab's headline −₱306,240.77 is the *operational* net — lab+consult gross profit −
expenses. −₱249,335.27 is the GL Income-Statement net, the tab's "reconciliation to books"
line. Both are GL-faithful; the difference between them is rent-expense recognition, already
correct. The real problem is below.)

## Root cause #1 (dominant, ₱418,319) — DUPLICATE expense booking

Operating expenses were booked **twice** during the historical books setup:

| Source layer | Entries | Expense total (Jan–May) |
|---|--:|--:|
| `history_import` (direct JEs) | 306 | **2,722,794.78** ≈ the sheet (₱2,717,788, within ₱5k) |
| `bill_post` (history-imported AP bills) | 75 | **418,319.34** ← pure duplicate |

**All 75 `bill_post` expense entries are tagged `[history imported_at=…]` and there are
ZERO genuine live AP bills** (all confined to Jan–May 2026). They re-book the same costs the
`history_import` JEs already booked. Biggest hits:
- **Send Out (6420):** history_import ₱377,592 + duplicate bill_post ₱320,507 = ₱698,098 (sheet ₱396,292)
- **Legal & Regulatory (6610):** history_import ₱222,948 (= sheet exactly) + duplicate bill_post ₱84,173 = ₱307,121

Removing the `bill_post` layer closes ₱418,319 of the ₱423,326 expense gap. **The B1.3
books-tie invariant still holds** (these are real `type='expense'` postings) — the invariant
proves the views are internally consistent, not that the books are *complete/correct*.

## Root cause #2 (₱37,500) — Rent Received from Doctors not booked

GL account **`4300 Rent Received from Doctors` has ₱0** posted for 2026 (and `4920 Doctor
Consultation Discounts` ₱0). The sheet books ₱37,500 rent income Jan–May (Jan 19,800 + Mar
17,700). Source = the rent SOA RENT TRACKER. In the shareholder model, **rent is the clinic's
real earnings from rent-paying doctors** — currently missing from the GL entirely.

## Issue #3 (−₱50,852) — Lab revenue timing / incomplete May import

Net lab revenue: GL ₱2,828,249 vs sheet ₱2,879,101. Driven by month-level cutoff, **mostly
May** (GL May lab ₱452,641 vs sheet ₱540,876 ≈ −88k) partly offset by Feb (GL over ~+27k).
Looks like the clinical/books import hadn't fully ingested late-May when last run. Likely
self-resolves on a fresh import; verify.

## Issue #4 (minor, ~₱23k) — March Doctors Payroll

GL `6110` March = ₱47,134 vs sheet ₱23,134 (≈ doubled). All `history_import`. Plus tiny
line diffs (Office/Lab Supplies/Maintenance/Travel/APE ~₱14k) from May data freshness.

## Consult is NOT a discrepancy (corrected)

GL consult revenue (net, ₱63,530) equals the sheet's net consult (gross ₱1,066,176 − PF
"discount" ₱1,002,846 = ₱63,330) to within ₱200. Pure gross-vs-net presentation, **zero**
net-income effect. (An earlier hypothesis that consult drove the gap was wrong.)

## ✅ Step 1 APPLIED to prod 2026-06-08

The duplicate-expense reversal (fix step 1 below) was **executed and verified on prod**
`qhptbmafrosgibooelpp`. Execution spec/plan:
`specs/2026-06-08-books-recon-step1-void-duplicate-bills.md` +
`plans/2026-06-08-books-recon-step1-void-duplicate-bills.md`.

- **What ran:** all 75 history-imported AP bills + their 75 cash payments voided via the app's
  guarded RPCs (`ap_void_bill_payment_cascade` then `ap_void_bill_with_guard`), in one atomic
  transaction, attributed to admin Ian Jamila. Originals retained as `status='reversed'` (not
  deleted); 75 + 75 `audit_log` rows written.
- **Investigation refinement:** each duplicate was a full lifecycle (`Dr expense / Cr AP` bill
  **+** `Dr AP / Cr Cash` payment, all cash to `1010`), so the payment had to be voided first
  (the bill-void guard P0029 blocks paid bills). The whole AP subledger was confirmed to be
  *nothing but* these 75 duplicates — zero genuine live bills.
- **Result (verified):** GL net income Jan–May 2026 **−₱249,335.27 → +₱168,984.07**; expense
  ₱3,141,114.12 → **₱2,722,794.78** (= `history_import` only, ties to the sheet); B1.3
  `v_ops_daily_expenses` view ties to ₱2,722,794.78; AP subledger net ₱0; phantom cash outflow
  of ₱418,319.34 removed; trial balance still balances (debits = credits = ₱26,282,199.49).
- **Remaining gap to the +₱262,143 sheet figure (~₱93k):** steps 2–4 below, still pending.

## Fix plan (prod writes — requires sign-off; step 1 ✅ DONE 2026-06-08)

1. ✅ **DONE** — **Reverse the 75 duplicate `bill_post` expense JEs** (₱418,319.34).
   Filter: `source_kind='bill_post' AND description ILIKE '%[history imported_at%'`.
   **Use the app's bill-void path**, not raw JE deletion — each bill_post JE has an AP-liability
   leg and a `bills` row (BL-2026-xxxx); void must unwind the full entry + AP subledger.
   Safe because the filter targets only history-tagged imports, never future live bills.
   → GL net rises −249,335 → **+168,984**.
2. **Book Rent Received from Doctors (4300)** from the RENT TRACKER (₱37,500 Jan–May; full
   history available). → **+206,484**.
3. **Re-run the clinical/books import for late May 2026** to close the lab-revenue cutoff
   (~+₱50,852 net). → **~+257k**.
4. **Fix the March `6110` Doctors Payroll** double (~₱24k) + reconcile residual line diffs.
   → lands at **≈ +₱262k**, matching the sheet.
5. **Re-verify**: re-run the per-account GL query + `scripts/ops-daily/validate-expenses.sql`
   (books-tie still holds) and confirm the B1.3 tab + Financial Statements page now show ~+₱262k.

## Impact / notes

- **The B1.3 dashboard, the Financial Statements page, and every GL report are all affected**
  by the same duplicate booking — fixing the books fixes them all at once. The B1.3 tab is a
  **live GL view**, so it self-corrects after the books fix — **no code change**.
- This is a **books-data cleanup sub-project**, not a B1.3 follow-up. Scope it on its own
  (brainstorm → plan), and confirm with the partner which layer to keep (recommend: keep
  `history_import`, void the 75 `bill_post` duplicates).
- Likely the same double-import pattern should be checked for **2024–2025** too (here it was
  confined to Jan–May 2026 — all-time `bill_post` = these 75 — but verify when the rest of the
  rent/lab history is reconciled).

## Repro queries

See `scripts/books-recon/reconcile-2026.sql` (per-account GL breakdown + source_kind split +
duplicate sizing). The exceljs dumpers for the sheets are `tmp/dump-any.ts` / `tmp/list-sheets.ts`.
