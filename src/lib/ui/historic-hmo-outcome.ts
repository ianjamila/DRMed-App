import { formatBulkOutcome } from "@/lib/ui/bulk-outcome";

// Pure outcome-text builder for the three historic-HMO-claims bulk actions
// (owner 2026-09-28: Mark billed / Mark paid / Write off, each with a
// 10-minute Undo). Kept in its own module — not inline in
// hmo-claims-client.tsx — so it can be unit-tested without importing that
// file's "./actions" chain, which is "use server" and pulls in modules that
// `import "server-only"` (loadOwnBatchRows, audit, reverseJournalEntryBySource):
// importing those from a plain vitest (node) run throws
// "This module cannot be imported from a Client Component module."

export type HistoricBulkKind = "billed" | "paid" | "writeoff";

const HISTORIC_BULK_VERB: Record<HistoricBulkKind, string> = {
  billed: "Marked",
  paid: "Marked",
  writeoff: "Wrote off",
};
const HISTORIC_BULK_TAIL: Record<HistoricBulkKind, string | undefined> = {
  billed: "as billed",
  paid: "as paid",
  writeoff: undefined,
};

export function historicBulkOutcomeMessage(kind: HistoricBulkKind, sent: number, changed: number): string {
  const head = formatBulkOutcome({
    verb: HISTORIC_BULK_VERB[kind],
    tail: HISTORIC_BULK_TAIL[kind],
    noun: { one: "claim", many: "claims" },
    sent,
    changed,
    notChanged: [],
  });
  if (changed === 0 || kind === "billed") return head;
  // Paid / write-off post a journal entry per claim — Undo reverses it.
  return `${head} Undo within 10 minutes reverses the journal entr${changed === 1 ? "y" : "ies"} and returns ${changed === 1 ? "it" : "them"} to the status ${changed === 1 ? "it" : "they"} had before.`;
}
