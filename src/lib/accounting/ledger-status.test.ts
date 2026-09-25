/**
 * Guard: every ledger TOTAL/aggregation query counts posted AND reversed
 * journal entries, never posted alone.
 *
 * WHY THIS EXISTS
 * ----------------
 * Reversing an entry marks the ORIGINAL `status = 'reversed'` and inserts a
 * mirror `status = 'posted'` entry with debit/credit swapped (see
 * `reverseJournalEntryBySource` in journal-entry.ts). A report that filters
 * `journal_entries.status = 'posted'` therefore keeps the mirror and drops
 * the original — a reversal subtracts the amount twice instead of netting to
 * zero. That shipped: June 2026 showed −₱418,319 of expenses, Cash on Hand
 * was overstated by ₱417,959, and a September undo-release showed −₱360
 * revenue.
 *
 * Every file below is a $ TOTAL over `journal_lines`/`journal_entries` and
 * must filter with `LEDGER_TOTAL_STATUSES` (posted + reversed), not a bare
 * `.eq("journal_entries.status", "posted")`. This is a source-text guard, in
 * the style of `hardened-views.test.ts` and `query-surfaces.test.ts` — a
 * convention nobody checks is a convention that decays.
 *
 * NOT covered here: operational LOOKUPS that find "the live entry to
 * reverse/link" (cash-drawer, HMO claims, PF disbursement void,
 * journal-entry.ts, the bank-rec JE-candidate matcher). Those stay
 * posted-only on purpose — see the second describe block below, which pins
 * that they do NOT use LEDGER_TOTAL_STATUSES, so the split stays visible and
 * intentional rather than silently drifting either way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEDGER_TOTAL_STATUSES } from "./ledger-status";

const ROOT = process.cwd();

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

/** Files whose journal_lines/journal_entries query is a $ TOTAL. */
const TOTAL_FILES = [
  "src/lib/accounting/income-statement.ts",
  "src/app/(staff)/staff/(dashboard)/admin/accounting/financial-statements/balance-sheet/page.tsx",
  "src/app/(staff)/staff/(dashboard)/admin/accounting/financial-statements/cash-flow/page.tsx",
  "src/app/(staff)/staff/(dashboard)/admin/accounting/variance/page.tsx",
];

/**
 * Files whose journal_entries.status filter is an operational LOOKUP (find
 * the live entry to match/reverse), which must stay posted-only.
 */
const LOOKUP_FILES = [
  "src/app/(staff)/staff/(dashboard)/admin/accounting/bank-rec/actions.ts",
  "src/app/(staff)/staff/(dashboard)/admin/accounting/bank-rec/[id]/page.tsx",
];

describe("ledger TOTAL files count posted + reversed", () => {
  it("pins the LEDGER_TOTAL_STATUSES value", () => {
    expect(LEDGER_TOTAL_STATUSES).toEqual(["posted", "reversed"]);
  });

  for (const file of TOTAL_FILES) {
    it(`${file} filters journal_entries.status with LEDGER_TOTAL_STATUSES`, () => {
      const src = read(file);
      expect(src).toMatch(/LEDGER_TOTAL_STATUSES/);
      expect(src).toMatch(/\.in\(\s*["']journal_entries\.status["']\s*,\s*LEDGER_TOTAL_STATUSES\s*\)/);
      // This fails loudly if the filter ever reverts to posted-only.
      expect(src).not.toMatch(/\.eq\(\s*["']journal_entries\.status["']\s*,\s*["']posted["']\s*\)/);
    });
  }
});

describe("operational lookups stay posted-only on purpose", () => {
  for (const file of LOOKUP_FILES) {
    it(`${file} still filters journal_entries.status to 'posted' only`, () => {
      const src = read(file);
      expect(src).toMatch(/\.eq\(\s*["']journal_entries\.status["']\s*,\s*["']posted["']\s*\)/);
      expect(src).not.toMatch(/LEDGER_TOTAL_STATUSES/);
    });
  }
});
