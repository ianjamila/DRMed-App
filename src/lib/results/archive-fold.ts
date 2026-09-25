/**
 * The results archive's fold: one table row per visit, and inside it one
 * ITEM per report — a single test, or a report group (chemistry) whose tests
 * share ONE `results` row and ONE PDF.
 *
 * Before this, the archive listed every member test of a chemistry panel with
 * its own "CODE PDF →" link, so one PDF showed up as eight.
 *
 * Order-preserving on both levels (CLAUDE.md: a fold applied after the fetch
 * must keep the query order): a visit is inserted when its first test is seen,
 * an item when its first member is seen, and both are mutated in place.
 *
 * Pure — unit-tested in `archive-fold.test.ts`.
 */

export interface ArchiveTestRow {
  id: string;
  status: string;
  requestedAt: string;
  completedAt: string | null;
  releasedAt: string | null;
  code: string;
  name: string;
  reportGroupId: string | null;
  reportGroupName: string | null;
  visit: {
    id: string;
    visitNumber: string;
    patient: {
      first_name: string;
      last_name: string;
      drm_id: string;
      /** 0167 lifecycle — drives the Deleted/Merged badge on the archive row. */
      deleted_at: string | null;
      merged_into_id: string | null;
    } | null;
  };
}

export interface ArchiveResultLink {
  resultId: string;
  hasPdf: boolean;
  amendedAt: string | null;
  amendmentCount: number;
}

export interface ArchiveItem {
  /** Stable React key. */
  key: string;
  kind: "test" | "report";
  /** The report group a `report` item belongs to (null for a single test). */
  reportGroupId: string | null;
  /** "Chemistry" for a report; the test's name for a single test. */
  label: string;
  tests: { id: string; status: string; code: string; name: string }[];
  /** The result every member links to, when one exists. */
  resultId: string | null;
  /** A member id the staff PDF route can resolve the shared PDF from. */
  pdfTestRequestId: string | null;
  amendedAt: string | null;
  amendmentCount: number;
}

export interface ArchiveVisitRow<Extra> {
  visitId: string;
  visitNumber: string;
  patient: ArchiveTestRow["visit"]["patient"];
  items: ArchiveItem[];
  /** Every test on the row, flat — for the status summary. */
  statuses: string[];
  requestedAt: string;
  completedAt: string | null;
  releasedAt: string | null;
  extra: Extra;
}

/**
 * What "N tests" should say for one report ITEM on the archive page, given
 * how many of its members actually landed on this fetched page versus how
 * many the report really has.
 *
 * The archive paginates `test_requests` BEFORE folding (`.range()` on the
 * base query, then `foldArchiveRows` above groups whatever came back), so a
 * report can straddle a page boundary or have a sibling excluded by the date
 * range / search box. `full` is the report's TRUE live membership — from one
 * batched `result_test_requests` junction query keyed by result_id, counting
 * only test_requests with `deleted_at is null` and `visits.deleted_at is
 * null` (the same predicate the consolidated report-group page counts "N
 * tests" by, so the two surfaces never disagree about what a report's size
 * is). `shown` is how many of those members are on THIS page (`item.tests.length`).
 *
 * `full === null` means there is no result yet — the report is still on the
 * bench, folded by `report_group_id` rather than `result_id` (see
 * `foldArchiveRows`). There is nothing to join a membership count against in
 * that case (no `result_id`), so this says nothing about "of N" and just
 * reports what's on the page — not a lie, since an unfinished group has no
 * fixed final size to compare against yet.
 *
 * Pure — unit-tested in `archive-fold.test.ts`.
 */
export interface ReportMembershipOnPage {
  /** Members of the report shown on this page. */
  shown: number;
  /** True live membership count, or null when there is no result to count against yet. */
  full: number | null;
}

export interface MembershipDisplay {
  /** "8 tests" or "3 of 8 tests shown" — the caller wraps it as "Label (…)" . */
  text: string;
  /** True when at least one live member is NOT on this page. */
  partial: boolean;
}

export function reportMembershipOnPage(m: ReportMembershipOnPage): MembershipDisplay {
  const word = (n: number) => (n === 1 ? "test" : "tests");
  // No result yet, or every live member is already on the page (shown can
  // never legitimately exceed full, but a >= guard rather than === keeps this
  // from mis-reading as partial on a stale/short count instead of failing
  // closed to "looks complete").
  if (m.full === null || m.shown >= m.full) {
    // Never print a count below what's visibly on the page.
    const n = Math.max(m.shown, m.full ?? m.shown);
    return { text: `${n} ${word(n)}`, partial: false };
  }
  return { text: `${m.shown} of ${m.full} ${word(m.full)} shown`, partial: true };
}

export function foldArchiveRows<Extra>(
  rows: readonly ArchiveTestRow[],
  linkByTestId: ReadonlyMap<string, ArchiveResultLink>,
  extraFor: (row: ArchiveTestRow) => Extra,
): ArchiveVisitRow<Extra>[] {
  const visits = new Map<string, ArchiveVisitRow<Extra>>();
  const itemIndex = new Map<string, Map<string, ArchiveItem>>();

  for (const r of rows) {
    let v = visits.get(r.visit.id);
    if (!v) {
      v = {
        visitId: r.visit.id,
        visitNumber: r.visit.visitNumber,
        patient: r.visit.patient,
        items: [],
        statuses: [],
        requestedAt: r.requestedAt,
        completedAt: r.completedAt,
        releasedAt: r.releasedAt,
        extra: extraFor(r),
      };
      visits.set(r.visit.id, v);
      itemIndex.set(r.visit.id, new Map());
    } else {
      // earliest requested, latest completed/released across the visit
      if (r.requestedAt < v.requestedAt) v.requestedAt = r.requestedAt;
      if (r.completedAt && (!v.completedAt || r.completedAt > v.completedAt)) {
        v.completedAt = r.completedAt;
      }
      if (r.releasedAt && (!v.releasedAt || r.releasedAt > v.releasedAt)) {
        v.releasedAt = r.releasedAt;
      }
    }
    v.statuses.push(r.status);

    const link = linkByTestId.get(r.id) ?? null;
    const test = { id: r.id, status: r.status, code: r.code, name: r.name };

    if (!r.reportGroupId) {
      v.items.push({
        key: r.id,
        kind: "test",
        reportGroupId: null,
        label: r.name || r.code,
        tests: [test],
        resultId: link?.resultId ?? null,
        pdfTestRequestId: link?.hasPdf ? r.id : null,
        amendedAt: link?.amendedAt ?? null,
        amendmentCount: link?.amendmentCount ?? 0,
      });
      continue;
    }

    // A report-group member folds into its finished report (keyed by the
    // shared result), or — still on the bench — into one pending item per
    // group. Two finished reports for one visit + group stay two items.
    const key = link?.hasPdf ? `result:${link.resultId}` : `group:${r.reportGroupId}`;
    const items = itemIndex.get(r.visit.id)!;
    const existing = items.get(key);
    if (existing) {
      existing.tests.push(test);
      continue;
    }
    const item: ArchiveItem = {
      key,
      kind: "report",
      reportGroupId: r.reportGroupId,
      label: r.reportGroupName ?? r.code,
      tests: [test],
      resultId: link?.hasPdf ? link.resultId : null,
      pdfTestRequestId: link?.hasPdf ? r.id : null,
      amendedAt: link?.hasPdf ? link.amendedAt : null,
      amendmentCount: link?.hasPdf ? link.amendmentCount : 0,
    };
    items.set(key, item);
    v.items.push(item);
  }

  return Array.from(visits.values());
}
