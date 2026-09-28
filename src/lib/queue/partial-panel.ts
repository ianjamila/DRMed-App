// Pure helpers for the lab queue's panel-write compensation paths (P1: a
// failed compensation attempt must never leave a committed change unaudited).
// When a panel write changes only SOME members and the attempt to put the
// rest back fails, whatever is STILL in the state this call wrote is a real,
// committed change — never dropped silently. No I/O here; the fresh DB read
// and the audit write live beside each call site in queue/actions.ts.

export interface CommittedRowState {
  id: string;
  status: string;
  assigned_to: string | null;
  started_at: string | null;
}

/**
 * Of a fresh read of the rows a failed (or partial) compensation attempt
 * targeted, which are STILL exactly in the state this call put them in.
 * `isCommitted` encodes that state per call site (claim: in_progress + this
 * caller + this call's started_at; unclaim: requested + unassigned; reclaim:
 * in_progress + the reclaimed holder — see queue/actions.ts).
 */
export function stillCommittedRows<T extends CommittedRowState>(
  fresh: readonly T[],
  isCommitted: (row: T) => boolean,
): T[] {
  return fresh.filter(isCommitted);
}

/** Skip/notRestored reason once ANY row is found still-committed after a
 * failed compensation — the panel is refused, but never silently. */
export const PARTIAL_PANEL_LEFTOVER_REASON =
  "Part of this panel changed and could not be put back — open it to check.";
