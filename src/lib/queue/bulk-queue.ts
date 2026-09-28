// Pure pieces of the lab queue's bulk bar (spec §6): the selection kinds a
// row carries, the server actions' result shape, and the message the bar
// shows afterwards. Lives in src/lib because "use server" modules may only
// export async functions and both sides need these.

import { formatBulkOutcome } from "@/lib/ui/bulk-outcome";

export const QUEUE_KIND = {
  claim: "claimable",
  unclaim: "unclaimable",
  delete: "deletable",
} as const;
export type QueueKind = (typeof QUEUE_KIND)[keyof typeof QUEUE_KIND];

/** Kinds for one single-test row, from the same predicates that decide which buttons the row shows. */
export function queueRowKinds(flags: {
  claimable: boolean;
  unclaimable: boolean;
  deletable: boolean;
}): QueueKind[] {
  const kinds: QueueKind[] = [];
  if (flags.claimable) kinds.push(QUEUE_KIND.claim);
  if (flags.unclaimable) kinds.push(QUEUE_KIND.unclaim);
  if (flags.deletable) kinds.push(QUEUE_KIND.delete);
  return kinds;
}

export interface SkippedRow {
  id: string;
  reason: string;
}

/** Every id sent lands in exactly one of changedIds / skipped. */
export type BulkQueueResult =
  | { ok: true; changedIds: string[]; skipped: SkippedRow[] }
  | { ok: false; error: string };

/** What the bar knows about a selectable row — serialisable, built by the server page. */
export interface QueueRowInfo {
  visitId: string;
  /** "CBC — Santos, Maria": how the result message names the row. */
  label: string;
  /** The holder the operator SAW (unclaim sends it as a predicate); null when unclaimed. */
  assignedTo: string | null;
}

/**
 * "Claimed 3 of 5 tests." plus one line per skipped row, naming it and why.
 * Every skipped row is named (at most 100, the action cap): the bar clears
 * the selection afterwards, so this message is the only record of what was
 * left alone. `verb` is past tense, capitalised.
 */
export function bulkQueueMessage(
  verb: string,
  sentCount: number,
  result: { changedIds: readonly string[]; skipped: readonly SkippedRow[] },
  rowsByKey: Readonly<Record<string, QueueRowInfo>>,
): string {
  return formatBulkOutcome({
    verb,
    noun: { one: "test", many: "tests" },
    sent: sentCount,
    changed: result.changedIds.length,
    notChanged: result.skipped.map((s) => ({
      label: rowsByKey[s.id]?.label ?? "A test",
      reason: s.reason,
    })),
  });
}
