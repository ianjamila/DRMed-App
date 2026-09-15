/**
 * The render-time snapshot a receipt page hands to its print action, and the
 * reconciliation that turns it into `receipt.printed` audit metadata.
 *
 * WHY THIS EXISTS. `receipt.printed` is the record of a disclosure: which
 * slips went on paper, and for how much. The group action used to answer that
 * by re-reading the group at print time and keeping the rows that were live
 * *then*, which is a different question with two wrong answers:
 *
 *  1. A visit soft-deleted between render and print dropped out of
 *     `visit_ids` and `total_php` — even though it was on the page when the
 *     button was pressed, and `window.print()` fires BEFORE the action, so the
 *     paper is already out. The single-visit sibling refuses to filter for
 *     exactly this reason; the group one filtered anyway.
 *  2. A consultation-only slip that `shouldPrintReceipt` suppressed was still
 *     live, so it was *counted* — inflating `total_php` with money that never
 *     appeared on any sheet.
 *
 * The page knows what it rendered; the action cannot re-derive it. So the page
 * passes the selection down and the action reconciles it against the group.
 *
 * WHAT IS AND ISN'T TRUSTED. The snapshot carries ids only — the *selection*.
 * Every figure in the audit row is recomputed server-side from rows read back
 * out of the database, and any id that is not genuinely part of this group is
 * dropped and counted. A caller can therefore narrow what it claims to have
 * printed, but cannot invent a visit, a line, or a peso.
 *
 * No `server-only` import — pure and unit-tested.
 */

/** One slip as the page rendered it: the visit, and the lines it listed. */
export interface PrintedSlipSnapshot {
  visitId: string;
  lineIds: string[];
}

/** What a group receipt page rendered, in the order it rendered it. */
export interface GroupPrintSnapshot {
  slips: PrintedSlipSnapshot[];
}

/** A line of a group visit as read back at print time — deleted ones included. */
export interface PrintTimeLine {
  id: string;
  /** Net price, via `toReceiptLine` so it matches the printed figure exactly. */
  final: number;
  deleted: boolean;
}

/** A group visit as read back at print time — deleted ones included. */
export interface PrintTimeVisit {
  id: string;
  visitNumber: string | null;
  deleted: boolean;
  lines: PrintTimeLine[];
}

export type ReconciledPrintMetadata = {
  /** The visits that were on the paper, in render order. */
  visit_ids: string[];
  visit_numbers: (string | null)[];
  slip_count: number;
  line_count: number;
  /** Sum of the net prices of the printed lines — the paper's grand total. */
  total_php: number;
  /**
   * Printed rows that have since been soft-deleted. They stay in the counts
   * above (they were disclosed); this says the record and the current data
   * legitimately disagree, instead of leaving a silent gap.
   */
  visits_deleted_after_render: string[];
  lines_deleted_after_render: string[];
  /**
   * Group visits that were NOT printed — a consultation-only slip the page
   * suppressed, or a sibling already deleted before the render. Without this
   * the row looks like an incomplete print rather than a deliberate one.
   */
  visits_not_printed: string[];
  /** Snapshot ids that matched nothing in the group. Expected to be 0. */
  snapshot_ids_dropped: number;
};

/**
 * Turn a render-time snapshot plus the group as it stands now into the
 * metadata for one `receipt.printed` row.
 *
 * `groupVisits` must be read UNFILTERED on `deleted_at` — a visit or line
 * deleted after the render still has to resolve, or the disclosure it was part
 * of goes unrecorded.
 */
export function reconcileGroupPrintSnapshot(
  snapshot: GroupPrintSnapshot,
  groupVisits: readonly PrintTimeVisit[],
): ReconciledPrintMetadata {
  const byVisitId = new Map(groupVisits.map((v) => [v.id, v]));

  const visitIds: string[] = [];
  const visitNumbers: (string | null)[] = [];
  const visitsDeleted: string[] = [];
  const linesDeleted: string[] = [];
  const printedVisitIds = new Set<string>();
  let lineCount = 0;
  let totalPhp = 0;
  let dropped = 0;

  for (const slip of snapshot.slips) {
    const visit = byVisitId.get(slip.visitId);
    // Not in this group at all: a stale snapshot, or a tampered one. Count it
    // and move on — never let it reach the audit row.
    if (!visit || printedVisitIds.has(visit.id)) {
      dropped += 1;
      continue;
    }
    printedVisitIds.add(visit.id);
    visitIds.push(visit.id);
    visitNumbers.push(visit.visitNumber);
    if (visit.deleted) visitsDeleted.push(visit.id);

    const byLineId = new Map(visit.lines.map((l) => [l.id, l]));
    const seenLineIds = new Set<string>();
    for (const lineId of slip.lineIds) {
      const line = byLineId.get(lineId);
      if (!line || seenLineIds.has(lineId)) {
        dropped += 1;
        continue;
      }
      seenLineIds.add(lineId);
      lineCount += 1;
      totalPhp += Number(line.final);
      if (line.deleted) linesDeleted.push(line.id);
    }
  }

  return {
    visit_ids: visitIds,
    visit_numbers: visitNumbers,
    slip_count: visitIds.length,
    line_count: lineCount,
    total_php: totalPhp,
    visits_deleted_after_render: visitsDeleted,
    lines_deleted_after_render: linesDeleted,
    visits_not_printed: groupVisits
      .map((v) => v.id)
      .filter((id) => !printedVisitIds.has(id)),
    snapshot_ids_dropped: dropped,
  };
}
