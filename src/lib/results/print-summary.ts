// Pure half of the "Printed …" note under every Print result button. The
// server-only reader (print-history.ts) feeds it result.printed_staff audit
// rows; kept apart so the fold is unit-testable (no server-only import).
//
// Keyed by result FILE, not by test line: what goes out on paper is a file,
// and a consolidated chemistry PDF is shared by the whole panel — printing it
// from one member hands over every member. Every print row carries
// metadata.result_id (the single-result route and the visit's Print all).
// An amended result keeps its id but gets a new file and a higher
// amendment_count, which every print row also stamps — so a correction's
// note starts empty: that version has not been handed over yet.

export type PrintSummary = {
  count: number;
  lastAt: string;
  // Staff name of the latest print, or null when the profile is gone.
  lastBy: string | null;
};

export type PrintEventRow = {
  result_id: string | null;
  // metadata->>amendment_count: text off the JSON, the file version printed.
  amendment_count: string | null;
  created_at: string;
  actor_id: string | null;
};

/**
 * Pure: audit rows → per-file count and latest print, counting only prints
 * of each file's CURRENT version (`currentVersions`: result id →
 * amendment_count). A row with no version stamp never counts.
 */
export function foldPrintEvents(
  rows: readonly PrintEventRow[],
  names: ReadonlyMap<string, string>,
  currentVersions: ReadonlyMap<string, number>,
): Map<string, PrintSummary> {
  const out = new Map<string, PrintSummary>();
  for (const row of rows) {
    if (!row.result_id) continue;
    const current = currentVersions.get(row.result_id);
    if (current === undefined || row.amendment_count !== String(current)) continue;
    const by = row.actor_id ? (names.get(row.actor_id) ?? null) : null;
    const seen = out.get(row.result_id);
    if (!seen) {
      out.set(row.result_id, { count: 1, lastAt: row.created_at, lastBy: by });
      continue;
    }
    seen.count += 1;
    if (row.created_at > seen.lastAt) {
      seen.lastAt = row.created_at;
      seen.lastBy = by;
    }
  }
  return out;
}

/**
 * The amendment_count a print/view audit row stamps: that of the file the
 * request actually SERVED. Version N (1 = the original) is the file that
 * amendment_count = N - 1 describes; with no `?version=N` the current file
 * (version amendment_count + 1) went out. Stamping the current count on a
 * print of a replaced version would mark the correction as handed over
 * (review of #223, 2026-09-25).
 */
export function servedAmendmentCount(
  requestedVersion: number | null,
  currentVersion: number,
): number {
  return (requestedVersion ?? currentVersion) - 1;
}
