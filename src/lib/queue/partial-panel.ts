// Pure helper for the exact-deleted_at restore write (queue-restore-core.ts).
// This file used to also hold the lab queue's panel-write COMPENSATION helpers
// (stillCommittedRows, partiallyRestoredIds, PARTIAL_PANEL_LEFTOVER_REASON);
// they went when a panel's Undo became atomic in the database (0191 un-claim,
// 0200 re-claim and restore — one statement each, every member or none), so
// nothing is written member by member and compensated any more.

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
