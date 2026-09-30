// A pending-callback booking that already has a requested date is loaded
// twice: by loadPendingCallback (by status) and by loadScheduledRange (by
// date), so it used to render in Pending callback AND in Today / Next 30
// days — two checkboxes, double-counted tabs. Owner decision 2026-09-28: it
// lives ONLY in its date section, where the row carries a "Callback needed"
// tag. Pending callback keeps the undated ones (and any dated before today,
// which no dated section loads) and says how many moved.
export function withoutDatedCallbacks<G extends { key: string }>(
  pending: readonly G[],
  dated: ReadonlyArray<readonly G[]>,
): { pending: G[]; moved: G[] } {
  const datedKeys = new Set<string>();
  for (const list of dated) for (const group of list) datedKeys.add(group.key);
  const kept: G[] = [];
  const moved: G[] = [];
  for (const group of pending) (datedKeys.has(group.key) ? moved : kept).push(group);
  return { pending: kept, moved };
}
