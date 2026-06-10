# Books Reconciliation — Steps 2–4 Investigation & Decision Memo (2026-06-10)

**Status:** ✅ APPLIED to prod 2026-06-10 (see "Outcome" at the bottom).
**Prereq:** Step 1 done & verified (net Jan–May 2026 = **+₱168,984.07**; bill_post layer = 0).
**Prod project:** `qhptbmafrosgibooelpp` (writes via Supabase MCP, each step dry-run + sign-off).

## Headline finding (changes the plan)

The original plan assumed the manual **Income Statement Monthly (2026)** summary (EBIT Jan–May
= **+₱262,142.86**) is the source of truth and the GL is wrong. **Investigation shows the
opposite for lab revenue:** the GL is a faithful, per-transaction mirror of the daily
`LAB SERVICE` source tab, tie-to-source **to the peso**:

| Month | GL 4100 (gross lab) | Daily `LAB SERVICE` tab | Monthly summary (sheet row 5) |
|---|--:|--:|--:|
| Jan | 653,461.50 | 653,461.50 ✓ | 647,517.50 (summary −5,944) |
| Feb | 700,249.50 | 700,249.50 ✓ | 673,536.50 (summary −26,713) |
| Mar | 573,267.50 | 573,267.50 ✓ | 571,268.50 (summary −1,999) |
| Apr | 576,363.70 | 576,363.70 ✓ | 576,363.70 ✓ |
| May | 448,651.20 (imported ≤05-26) | 542,856.00 (complete) | 540,876.00 |

So the Jan/Feb/Mar "over-bookings" flagged in the original diagnosis are **not errors** — the
GL equals the granular daily transactions; the hand-keyed **monthly summary is the less
accurate artifact**. There are **zero duplicate lab JEs** (3,875 distinct row-keys). Removing
"excess" Jan/Feb/Mar lab would delete *real revenue and real recorded cash* (cash legs
1010/1020/1030/1110) and would corrupt the books + the 12.C cash reconciliation — the mirror
of step 1's phantom cash *out*flow.

## What is genuinely wrong (the real gaps)

1. **Rent Received from Doctors (4300) = ₱0** — genuinely unbooked. Sheet recognizes
   Jan 19,800 + Mar 17,700 = **₱37,500**. No import script books rent (confirmed). Real missing income.
2. **Late-May not imported.** Lab + expenses imported only through **2026-05-26**; the complete
   `(1)` mastersheet has 05-27…05-30. Missing late-May (Jan–May window):
   - Lab: +94,204.80 gross (4100), +4,191.00 discount (4910) → **net lab +₱90,013.80**
   - Expenses: 6110 +1,085, 6410 +3,650, 6420 +18,700, 6700 +1,062 = **+₱24,497**
   - Consult: **₱0** (already complete for May — 5,640 = GL).
   - Net income effect of completing late-May = +90,013.80 − 24,497 = **+₱65,516.80**.
3. **March 6110 "TAGAYUNA SEPT 2024–DECEMBER 2025" = ₱24,000** (JE-2026-0033). A **real cash
   payment made in March 2026** for doctor PF work spanning Sept 2024–Dec 2025. The books are
   **cash-basis** (everything booked when cash moves), so on that basis it correctly sits in
   2026. The monthly summary excluded it (accrual thinking). NOT a duplicate/error.

## Source / mechanism facts

- Importers: `scripts/history-import/{lab-services,expenses,doctor-consultations}.ts`,
  `npm run import:history:* -- --year=YYYY [--xlsx=PATH] [--commit --confirm="I-mean-it"]`.
- **Idempotent by row-number marker** in JE notes (`xlsx LAB SERVICE r{N}` etc.) → re-running
  only adds not-yet-booked rows. 05-01…05-26 values are identical between the old and `(1)`
  sheets (verified), so row numbers are stable and re-import is safe (still confirm via dry-run).
- **`--year` only — no date range.** `--year=2026` would ALSO pull in partial June (bulk June
  not yet imported — only 4 stray June/July JEs exist) and a July consult row. To keep the
  "books complete through May" boundary clean, cap at 05-31 (small importer `--to-date` tweak)
  OR accept June/July in.
- Source of truth file = `~/Downloads/DR MED MASTERSHEET (1).xlsx` (complete; the importer
  default `DR MED MASTERSHEET.xlsx` is the May-incomplete one — must pass `--xlsx=…(1).xlsx`).
- Cash leg by MOP: GCASH→1030, BPI→1020, BDO→1021, CHEQUE→1020, blank/CASH→1010, HMO→1110.
- 9999 Suspense Jan–May = 27,364 (OOP rows; balance-sheet, no net-income effect) — out of scope.

## Projected Jan–May 2026 net income (decision-dependent)

| Approach | Net income | vs summary |
|---|--:|--:|
| Current (step 1 done) | +168,984.07 | — |
| **A. Keep granular GL** + rent + late-May, **keep** TAGAYUNA (cash-basis) | **≈ +272,001** | +9,858 |
| A but **reclass** TAGAYUNA out of 2026 | ≈ +296,001 | +33,858 |
| B. Force-match the +262,143 summary (reverse real Jan/Feb/Mar lab) | +262,143 | 0 — **not recommended** (deletes real revenue + cash) |

**Recommendation: Approach A**, keep TAGAYUNA (cash-basis consistency). The GL is the more
accurate artifact; the manual monthly summary should be updated toward the GL, not vice versa.
Books land ≈ **+₱272,001** — a *finding*, not a failure to hit +262,143.

## Open decisions for the partner/user
1. Reconciliation philosophy: **A (keep granular GL)** vs B (force +262,143).
2. Rent (4300) offset account — which cash/bank account did the ₱37,500 land in?
3. TAGAYUNA ₱24,000 — keep in 2026 (cash-basis) vs reclass to prior period.
4. Late-May re-import scope — cap at 2026-05-31 vs allow partial June/July.

## Decisions (partner, 2026-06-10)
1. **Trust the granular GL** — fix only the genuine gaps; do NOT reverse Jan/Feb/Mar lab.
2. **Rent offset = BPI (1020)** (confirmed bank-to-bank to DRMED HEALTHCARE INC.).
3. **TAGAYUNA kept in March 2026** (cash-basis) — step 4 is a no-op.
4. **Re-import capped at 2026-05-31** — added a `--to-date` guard to the lab + expense importers.

## Outcome — APPLIED to prod 2026-06-10

- **Step 2 (rent):** booked `JE-2026-4962` (Jan 19,800) + `JE-2026-4963` (Mar 17,700),
  Dr 1020 BPI / Cr 4300, `source_kind='manual'`, + 2 `audit_log` rows (actor Ian Jamila).
  → rent 4300 = ₱37,500; net Jan–May −→ **+206,484.07**.
- **Step 3 (late-May import, capped ≤05-31, complete `(1)` sheet):**
  - lab-services `--commit`: **posted=101**, already=3,875, failed=0; HMO subledger posted=25.
    Added gross 4100 +₱94,204.80, discount 4910 +₱4,191.
  - expenses `--commit`: **posted=6**, already=314, failed=0 (6110 +1,085, 6410 +3,650,
    6420 +18,700, 6700 +1,062 = +₱24,497).
  - June/July held out by the cutoff.
- **Step 4:** no-op (TAGAYUNA kept).
- **Verified:** Jan–May 2026 **net income = +₱272,001.07** (revenue 3,151,218.40 −
  contra 131,925.55 − expense 2,747,291.78). Trial balance balances (26,438,401.49 =
  26,438,401.49). AP still 0/0 (step-1 integrity intact). B1.3 books-tie invariant holds
  (per-account = v0094 = P&L expense = 2,747,291.78); the B1.3 tab + Financial Statements
  self-corrected (live GL views, no code change). The ₱0.20 vs the ₱272,000.87 estimate is
  importer round-2 on one row — immaterial.
- **Final position vs the manual summary:** books land **+₱272,001** — ~₱9,858 above the
  hand-keyed monthly summary's +₱262,143, because the GL captures the actual per-transaction
  lab revenue the summary under-counted (Feb especially). The GL is the more accurate artifact;
  the partner should update the monthly summary toward it, not the reverse.
- **Code change:** added `--to-date=YYYY-MM-DD` cutoff to
  `scripts/history-import/{lab-services,expenses}.ts` (rows after the cutoff are held).

## 2024–2025 re-check (2026-06-10, read-only) — CLEAN, no writes needed

Re-checked prior years for the same incomplete-import / duplicate patterns. **All clean:**
- **Zero duplicate import markers** across every year (LAB SERVICE 18,655 / EXPENSES 1,717 /
  DOCTOR CONSULTATION 1,679 — all distinct). The 75 `bill_post` AP dups were confined to 2026
  (voided in step 1).
- **Lab (4100)** ties to the source `LAB SERVICE` tab **to the peso**: 2023 162,195.00;
  2024 4,154,848.50; 2025 5,627,809.75 — GL = sheet exactly. No alternate 4100 source.
- **Doctor consult (4200)** ties via the importer's parser exactly: 2024 ₱58,038.00,
  2025 ₱126,012.00 = GL.
- **Expenses** tie: 2024 GL = importer 3,667,463.13 exactly. 2025 GL 4,960,251.59 =
  EXPENSES-tab 4,950,590.37 **+ ₱9,661.22 Veritas Pay card-merchant fees (65 JEs → 6610)** —
  a legitimate separate source, not a gap. So 2025 is complete + correct.
- **Conclusion:** the late-May-2026 incomplete-import situation does **not** recur in 2024–2025;
  those years are fully and correctly booked. No corrective writes required.
