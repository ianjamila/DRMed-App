/**
 * Statuses to count in a ledger TOTAL / aggregation (a $ sum over
 * `journal_lines`/`journal_entries` for a report, statement or dashboard
 * tile).
 *
 * Reversing an entry marks the ORIGINAL `status = 'reversed'` and inserts a
 * mirror entry (`source_kind = 'reversal'`, `reverses = <original id>`,
 * `status = 'posted'`) with debit/credit swapped so the pair nets to zero.
 * A filter of `status = 'posted'` alone therefore keeps the mirror and drops
 * the original — a reversal subtracts the amount twice instead of netting to
 * zero. Every ledger total must count BOTH statuses so a reversed pair
 * cancels out exactly, as if the reversed entry had never posted.
 *
 * This is NOT for operational lookups that find "the live entry to
 * reverse/link" (e.g. cash-drawer close, HMO claim linking, PF disbursement
 * void, `journal-entry.ts`'s `reverseJournalEntryBySource`, the `bridge_*` /
 * `ap_*` SQL functions) — those must stay `status = 'posted'` only, since a
 * reversed entry is no longer the live record to act on.
 */
export const LEDGER_TOTAL_STATUSES = ["posted", "reversed"] as const;
