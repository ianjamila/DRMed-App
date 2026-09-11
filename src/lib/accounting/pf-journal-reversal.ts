// Pure helper extracted out of pf-disbursement-void.ts so it can be
// unit-tested without pulling in "server-only" (vitest coverage is pure logic
// only — see vitest.config.ts). No DB, no RSC.

export interface PfJournalLine {
  account_id: string;
  debit_php: number;
  credit_php: number;
  description: string | null;
  line_order: number;
}

/**
 * Mirrors one journal_line into its reversal shape for a PF disbursement
 * void: debit/credit swapped, the description prefixed. Used identically by
 * the single-disbursement void path and the bulk EOD payout's
 * failure-rollback path via voidPfDisbursementAndUnlink() so the two can't
 * drift on how a reversal line is built.
 */
export function reversePfJournalLine(
  entryId: string,
  line: PfJournalLine,
): {
  entry_id: string;
  line_order: number;
  account_id: string;
  debit_php: number;
  credit_php: number;
  description: string;
} {
  return {
    entry_id: entryId,
    line_order: line.line_order,
    account_id: line.account_id,
    debit_php: line.credit_php,
    credit_php: line.debit_php,
    description: `Reversal: ${line.description ?? ""}`,
  };
}
