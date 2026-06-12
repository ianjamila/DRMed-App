# 9999 Suspense — Out-of-Pocket Expense Reclassification (dry-run + sign-off)

**Status:** ✅ APPLIED to prod 2026-06-10 (see "Outcome" at the bottom).
**Prod project:** `qhptbmafrosgibooelpp` (writes via Supabase MCP, dry-run + sign-off — books-recon pattern).
**Origin:** Remaining suspense cleanup flagged in [[project-books-reconciliation-2026]] ("resolve the 9999 OOP rows, ~₱27,364 2026; check 2024–2025 too").

## What's in 9999 Suspense

`9999 Suspense` is `type='memo'` → **excluded from every P&L / expense view** (`v_ops_daily_expenses`, `v_ops_daily_pnl`, `v_ops_daily_expense_accounts` all filter `coa.type='expense'`; the financial statements do the same). So nothing currently in 9999 touches net income.

| Side | lines | total | meaning |
|---|--:|--:|---|
| **DR 9999** | 100 | **₱608,016.83** | "Out of Pocket Expense" rows from the master-sheet history import. Each JE = `DR 9999 / CR 2500 Due to Shareholders` (all `mop=IAN`). A liability (owed back to Ian) was booked but the **matching expense was never recognized.** This is the cleanup task. |
| CR 9999 | 3 | ₱31,117.00 | Separate issue — salary/benefit JEs where the **cash credit** couldn't be parsed (typo `CLINIC GCAZSH`; `10K GCASH, REST CASH` split; `NOT YET GIVEN, FOR LAST PAY NA` unpaid). Surfaced below, handled separately. |

The importer parks OOP rows at 9999 by design (`scripts/history-import/expenses.ts`: "the actual expense type is in the description — park at Suspense for admin to reclassify case-by-case").

## Key accounting facts (verified on prod)

1. **9999 is memo → not in P&L.** Reclassifying DR 9999 → 6xxx **adds real expense** and **lowers net income** in each year. This is a correction of an understatement, not a cosmetic move.
2. **No double-count of statutory remittances.** Payroll history is **cash-basis net**: salary JEs are 2-line `DR 6100 / CR 1010` at take-home amounts; all withholding-liability accounts (2300/2310/2320/2330/2360) and 6121/6122/6123 are **empty**. So booking the full SSS/PhilHealth/Pag-IBIG remittance as employer expense is correct — the employee share was never separately expensed.
3. **No period is closed** (108 `accounting_periods` rows, 0 `closed`) → in-place line edits are permitted.

## Proposed mapping (DR 9999 → real account)

The credit side (2500 Due to Shareholders) is correct and untouched. Only the debit account moves. Mapping is by description keyword; ties to ₱608,016.83 with **zero unmapped**.

| Target | Account | Rows | Total | 2023 | 2024 | 2025 | 2026 |
|---|---|--:|--:|--:|--:|--:|--:|
| 6121 | Employer SSS Contribution | 14 | 128,640.00 | — | 105,420.00 | 23,220.00 | — |
| 6122 | Employer PhilHealth Contribution | 28 | 109,167.05 | — | 38,966.22 | 50,704.83 | 19,496.00 |
| 6123 | Employer Pag-IBIG Contribution | 11 | 16,600.00 | — | 16,600.00 | — | — |
| 6220 | Telecommunication / Internet (PLDT) | 24 | 52,787.40 | 1,967.00 | 21,637.00 | 21,315.40 | 7,868.00 |
| 6310 | Maintenance & Repair (Fernan, Wilcon) | 6 | 31,911.20 | 20,411.20 | 11,500.00 | — | — |
| 6400 | Office Supplies (True Value) | 1 | 2,368.25 | 2,368.25 | — | — | — |
| 6500 | Marketing (Frannie — iPhone trade for services) | 1 | 10,000.00 | 10,000.00 | — | — | — |
| 6600 | Permits (Mayor's Permit) | 1 | 13,602.96 | — | 13,602.96 | — | — |
| 6610 | Legal & Regulatory (YDL Law, DST, Notary) | 4 | 65,440.94 | 62,000.00 | 3,440.94 | — | — |
| 6620 | Insurance (Fire/CGL) | 1 | 2,912.03 | — | 2,912.03 | — | — |
| 6710 | APE (Mhel rebate) | 1 | 25,500.00 | — | 25,500.00 | — | — |
| **EQUIP** | **Equipment bucket — PARTNER DECISION** | **8** | **149,087.00** | 88,148.00 | 60,939.00 | — | — |
| | **TOTAL** | **100** | **608,016.83** | 184,894.45 | 300,518.15 | 95,240.23 | 27,364.00 |

### Equipment bucket (8 rows — capitalize vs expense)

No "small-equipment expense" account exists — only `1500 Equipment` (asset) + `6300 Depreciation`. So the choice is capitalize-to-1500 (no P&L hit; depreciate later) vs expense to a 6xxx bucket (full P&L hit in the period).

| JE | Date | Item | Amount | Note |
|---|---|---|--:|---|
| JE-2023-0012 | 2023-12-31 | New PC | 40,000.00 | clearly capital |
| JE-2023-0013 | 2023-12-31 | New PC | 40,000.00 | clearly capital |
| JE-2024-0002 | 2024-01-22 | Lightbox - Leon | 48,000.00 | signage — capital (or marketing) |
| JE-2024-0008 | 2024-12-16 | Canon PIXMA G2730 printer | 6,995.00 | borderline |
| JE-2024-0009 | 2024-04-15 | Canon PIXMA G1020 printer | 5,944.00 | borderline |
| JE-2023-0009 | 2023-12-31 | Biometrics device | 3,699.00 | small |
| JE-2023-0010 | 2023-12-31 | Vault / safe | 2,999.00 | small |
| JE-2023-0011 | 2023-12-31 | New Telephone | 1,450.00 | small |

## Net-income impact (per year)

| Year | If EQUIP **capitalized** (92 rows hit P&L) | If EQUIP **expensed** (100 rows hit P&L) |
|---|--:|--:|
| 2023 | −96,746.45 | −184,894.45 |
| 2024 | −239,579.15 | −300,518.15 |
| 2025 | −95,240.23 | −95,240.23 |
| 2026 | −27,364.00 | −27,364.00 |

2026 note: lowers the just-reconciled Jan–May net income (+₱272,001.07) by ₱27,364 → **≈ +₱244,637**. Correct (these are real expenses Ian paid that were never recognized). The +272,001 reconciliation explicitly listed OOP as "out of scope / balance-sheet" — this closes that.

## Execution plan (after sign-off)

- **In-place reclassification** — `UPDATE journal_lines SET account_id = <target>` on the DR-9999 line of each JE. Preserves date/period, amount, and the 2500 credit; the AFTER-UPDATE balance trigger passes (amounts unchanged); `block_inactive_account` is INSERT-only. Drains 9999 (DR side) to exactly ₱0.
- One transaction; append a provenance marker to each JE's notes (`| reclass 9999→<code> 2026-06-10`); insert `audit_log` rows attributed to admin Ian Jamila (books-recon pattern).
- Verify: 9999 DR = 0; per-account expense deltas match the table; trial balance still balances; B1.3 / financial-statement views self-correct (live GL views).

## The 3 CR-side suspense rows (₱31,117 — separate)

| JE | Date | Amount | Raw MOP | Proposed |
|---|---|--:|---|---|
| JE-2025-0418 | 2025-07-04 | 9,386.50 | `CLINIC GCAZSH` (typo) | → CR 1030 GCash |
| JE-2025-0457 | 2025-07-31 | 14,580.00 | `10K GCASH, REST CASH` | → split CR 1030 ₱10,000 / 1010 ₱4,580 |
| JE-2025-0647 | 2025-11-20 | 7,150.50 | `NOT YET GIVEN, FOR LAST PAY NA` | unpaid wage → **CR 2360 Salaries Payable** (not cash) — partner confirm |

## Outcome — APPLIED to prod 2026-06-10

Partner decisions (2026-06-10): **include the 3 CR-side rows**; **apply on prod**. Equipment bucket settled in two steps: first capitalize-all-8, then — after a follow-up that surfaced the cash-basis-inconsistency + de-minimis tradeoff — partner approved the **₱10k materiality split**: keep the 2 PCs + Lightbox (**₱128,000**) in 1500 Equipment, move the 5 sub-₱10k items (2 printers, biometric, vault, telephone = **₱21,087**) to **6400 Office Supplies**. Depreciation schedule on the ₱128,000 = agreed follow-up.

Executed as one atomic `DO` block (Supabase MCP) with built-in assertions (self-rollback if 9999 didn't drain or TB broke). In-place `journal_lines.account_id` edits; split row done via draft-flip; 103 `audit_log` rows (`journal_entry.reclassified`, actor Ian Jamila `8c25a556-…`); `| [9999 reclass 2026-06-10]` stamped on each entry's notes.

**Verified on prod:**
- **9999 Suspense = ₱0 / 0 lines** (both DR and CR fully drained).
- Trial balance still balances.
- DR targets tie to the dry-run **to the peso**: 1500 ₱149,087 (8) · 6121 ₱128,640 (14) · 6122 ₱109,167.05 (28) · 6123 ₱16,600 (11) · 6220 ₱52,787.40 (24) · 6310 ₱31,911.20 (6) · 6400 ₱2,368.25 · 6500 ₱10,000 · 6600 ₱13,602.96 · 6610 ₱65,440.94 (4) · 6620 ₱2,912.03 · 6710 ₱25,500 — total ₱608,016.83 / 100 rows.
- CR rows: JE-2025-0418 `6100/1030 9,386.50`; JE-2025-0457 `6120/1030 10,000 + 1010 4,580`; JE-2025-0647 `6100/2360 7,150.50` — all posted & balanced.

**Equipment after the materiality split (2nd prod write, audit-logged):** 1500 Equipment = **₱128,000** (2 PCs + Lightbox only); 6400 Office Supplies +₱21,087 (5 small items). Verified: 1500=128,000, 6400 delta +21,087, 9999=₱0, TB balances. Note: the 5 small items sum to **₱21,087** (not ₱20,939 — earlier arithmetic slip caught by the DO-block assertion, which rolled back; corrected before applying).

**P&L impact (now in the income statement; was previously memo/off-P&L):** expense added 2023 +₱104,894.45 (incl. ₱8,148 small equip), 2024 +₱252,518.15 (incl. ₱12,939 small equip), 2025 +₱95,240.23, 2026 +₱27,364.00. PCs + Lightbox (₱128,000) capitalized → off-P&L. Jan–May 2026 net income +₱272,001.07 → **+₱244,637.07** (confirmed via `v_ops_daily_pnl`).

**Follow-ups:**
- **Depreciation = DEFERRED by partner (2026-06-11).** ₱128,000 stays capitalized at full cost in 1500 (PCs 2 × ₱40k, in service Dec 2023; Lightbox ₱48k, Jan 2024). No automated depreciation exists in the app, so deferral = zero action. If a standing "no depreciation" (cash-basis) policy is later wanted, the coherent move is to expense the PCs + Lightbox to 6400 as well (dry-run + sign-off; check BIR capitalization-threshold tax angle first) — not capitalize-and-never-depreciate.
- The manual monthly Income Statement summary should be updated toward the GL (books-recon philosophy: GL is the more accurate artifact).
