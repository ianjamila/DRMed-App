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

/**
 * Groups already-validated ids by the exact `deleted_at` string each one
 * carries (P1, finding 3: a bulk-delete Undo's restore write must predicate
 * on the EXACT deleted_at it read, not merely "is not null" — otherwise a
 * restore-and-re-delete landing between the read and the write is silently
 * undone). Callers issue one predicated UPDATE per group. Insertion order is
 * preserved within each group.
 */
export function groupIdsByDeletedAt(rows: readonly { id: string; deleted_at: string }[]): Map<string, string[]> {
  const byValue = new Map<string, string[]>();
  for (const r of rows) {
    const list = byValue.get(r.deleted_at) ?? [];
    list.push(r.id);
    byValue.set(r.deleted_at, list);
  }
  return byValue;
}

/**
 * Of a panel's member ids, which ones a restore write brought back when NOT
 * ALL of them did (P2, finding 6: a member that changed in the instant
 * between pre-validation and the restore write must be compensated back to
 * its prior deleted state, not left restored while the panel is reported as
 * refused). Returns null when there is nothing to compensate: either none of
 * the ids came back (the caller already reports the whole panel refused) or
 * every one of them did (a clean, fully-restored panel).
 */
export function partiallyRestoredIds(ids: readonly string[], restoredIds: ReadonlySet<string>): string[] | null {
  const restored = ids.filter((id) => restoredIds.has(id));
  if (restored.length === 0 || restored.length === ids.length) return null;
  return restored;
}
