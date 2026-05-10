# Accounting + Phase 12 — Project Overview

**Status:** Approved 2026-05-11. Brainstorming complete. Implementation plan pending per-sub-project.
**Owner:** ianjamila (admin / CoA owner)
**Scope class:** Option C (Full books — double-entry GL, formal close, accruals, financial statements)

---

## Goal

Build a double-entry accounting system inside drmed.ph that becomes the single source of truth for the clinic's books, replacing the live operations Sheet's role over time. Three concrete deliverables:

1. **Real per-provider HMO accounts-receivable balance** with unbilled / stuck-claim detection, covering 2023→present history.
2. **Financial statements (P&L, Balance Sheet, Cash Flow)** generated from a real GL with period-over-period comparison.
3. **Extensible foundation** for VAT/Withholding-tax capture and BIR-form output (parked as Future Phases).

## Decisions made during brainstorming

| Decision | Choice | Why |
|---|---|---|
| Depth | **Option C — Full double-entry + formal close + accruals + manual JE** | User is comfortable with proper accounting and owns the CoA personally. |
| Cutover | **Full 2023→present history backfill** | All transaction history is in one workbook. User wants to detect unbilled HMO errors and reconcile real AR balances — historical data is mandatory for that. |
| Close cadence | **Quarterly** (Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec; fiscal year = calendar year) | Smaller-business cadence; monthly granularity in schema for reports, quarterly lock for ergonomics. |
| Users | **Admin only.** No accountant role today. | Single CoA-owner; reception's flows unchanged. |
| Veritas | **Card-processor, not a payer.** Veritas Pay goes on the payments row (`card_processor`, `processor_fee_php`, `settlement_status`), not the HMO AR subledger. | Veritas issues card terminals + charges a small convenience fee with 1–3 day settlement. It's a payment method, not a counterparty for AR. |
| Go-live target | **ASAP** — prioritise 12.1 + 12.2 + 12.3 + 12.A so the AR audit lands ~4 weeks in. | Real AR balance is the user's most urgent pain. |
| VAT / Withholding tax | **Deferred to Future Phase 1.** Compensation WT capture lands in 12.6 because PH law requires withholding; only the BIR-form filing is deferred. | Accountant has not yet classified per-service VAT treatment (lab tests vs doctor consults vs procedures vs send-out). Schema stays extensible so VAT/WT accounts can be added without migration pain. |
| Payroll | **Included** as sub-project 12.6. ZKTeco DTR CSV upload → attendance → semi-monthly payroll → payslip PDF with email + print options. 5 employees. Cash payout default + bank transfer option. | User explicitly added during brainstorming. |
| Doctor PF disbursement | Tracked separately in 12.5 (not part of employee payroll) | Doctors are not employees; they have their own PF lifecycle. |

## Sub-project map

```
12.1  GL foundation (CoA + Periods + JE primitives)           ← start here
12.2  Operational → GL bridge (forward + replay harness)
12.3  HMO AR subledger + unbilled / stuck-claim detection
12.A  HMO history import (2023 → present, single workbook)    ← AR audit lands here, ~4 weeks in
12.4  Operating-expense / AP subledger
12.5  COGS + Doctor-PF subledger
12.6  Employees + Attendance (ZKTeco DTR) + Payroll + Payslip PDF
12.B  Operational/expense history import (incl. 2023+ payroll lines)
12.7  Period close (quarterly) + accruals + manual JE
12.8  Financial statements (P&L, BS, CF) with period-over-period
```

## Hard invariants

1. **Debits = Credits** on every posted JE. Enforced by a Postgres trigger; no application-level bypass.
2. **No JE posts to a closed period.** Enforced by a Postgres trigger. Reversing entries are exempt only when the reversal's own `posting_date` is in an open period (standard accountant practice — reversal lives in the current open period, not the locked one).
3. **One operational event → exactly one JE.** Every change to `payments`, `expenses`, `test_requests`-released-to-HMO, `doctor_payouts`, and `payroll_runs` emits exactly one JE. No double-posting, no orphan operational rows without a JE.
4. **CoA is append-only.** Accounts soft-disable; they never delete. Historical JEs hold stable account references.
5. **CoA codes are immutable identifiers.** Renames change `name`, never `code`.
6. **History imports go through a staging layer with a dry-run / commit gate.** Data-quality issues, mis-classifications, and stuck claims surface to admin *before* commit. No silent corrections.
7. **Reception's existing UI is untouched.** They keep encoding the same operational fields; the GL posts behind the scenes.

## What this project does NOT do — captured as Future Phases

| Future Phase | Scope | Trigger to start |
|---|---|---|
| **FP1 — VAT & WT capture (single source of truth)** | Per-service `vat_treatment` enum, output VAT capture on revenue, input VAT capture on expenses, monthly 2550M / quarterly 2550Q summary views, doctor 2307 generation, alphalist of payees. | Accountant classifies revenue lines and confirms WT treatment. |
| **FP2 — BIR form filing surfaces** | Generation of 2550M/Q, 1601-C, 2316, 1701, alphalists. Optional eFPS hand-off. | User wants to bring BIR filing in-house. |
| **FP3 — Monthly close workflow** | Per-month lock + close calendar (the close-management skill's day-by-day cadence). Schema-compatible with today's quarterly close. | If reporting needs sharper than quarterly grain. |
| **FP4 — Bank statement reconciliation** | OFX/CSV import of bank statements; auto-match against cash receipts and disbursements; reconciliation report. | If audit demands tighter cash controls. |
| **FP5 — Budget vs Actual** | Budget table + variance reports (variance-analysis skill methodology). | Once historical actuals stabilise enough to budget against. |
| **FP6 — Multi-currency** | Multi-currency JE lines + FX gain/loss accounts. | If USD/SGD HMO contracts or foreign vendor payments materialise. |
| **FP7 — Accountant role** | Read-only accountant user with restricted access to admin accounting surfaces. | If user delegates monthly close to an external CPA who needs in-app access. |

## Dependencies

- Existing schema (migrations 0001–0027) is the base. The accounting project adds migrations starting at 0028.
- Existing audit logging infrastructure (`audit_log` table, `audit()` helper).
- Existing admin auth gate (`requireAdminStaff`).
- No new external services required for 12.1–12.8. Payroll uses no external integrations; payslip email goes through the existing Resend setup.

## Sequencing notes

- **12.A** (HMO history import) runs *after* 12.3 — needs the subledger schema in place to import into. It surfaces the unbilled / stuck-claim findings via 12.3's reports.
- **12.B** runs *after* 12.4 + 12.5 + 12.6 — needs all operational-side subledgers (AP, COGS, doctor PF, payroll) to ingest into.
- **12.7** runs *after* 12.B — has to operate over a complete-data GL.
- **12.8** runs *after* 12.7 — period-over-period only meaningful with closed periods.

## Estimated effort

- Roughly **8 weeks** for one developer, with the AR-audit answer (12.1 + 12.2 + 12.3 + 12.A) landing around week 4.
- Payroll (12.6) is ~1.5 weeks of that.
- Imports (12.A + 12.B) are ~1.5 weeks combined, dominated by schema-drift normalisation across three Sheet generations.

## Each sub-project gets its own spec → plan → implementation cycle

This document is the umbrella. Per-sub-project specs land in `docs/superpowers/specs/` as we approach each one. First spec: `2026-05-11-12.1-gl-foundation-design.md`.

---

## References

- Source-of-truth workbook: `https://docs.google.com/spreadsheets/d/19K95OGYr2EaR-lPXLMkATMue8FK-ScFZPU5NFw59-vw/` (DR MED MASTERSHEET). Contains Income Statement 2024/2025/2026, HMO Receivables aging, multiple transaction tabs (Lab Services, Doctor Consultations, Doctor Procedures HMO), and incomplete Balance Sheet + Cash Flow tabs (gids 1604226357 and 1321985174 respectively).
- Methodology references (Anthropic skills installed during brainstorming): `financial-statements`, `journal-entry`, `reconciliation`, `close-management`, `variance-analysis`.
- Memory: `~/.claude/projects/.../memory/project_accounting_export.md` — captures the prior Sheet-export-only approach (Phase 7A/7B/7C) that this project supersedes.
