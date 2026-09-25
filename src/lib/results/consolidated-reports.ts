/**
 * Pure helpers for consolidated (report-group) results — the chemistry panel
 * that folds several `test_requests` into ONE `results` row and ONE PDF via
 * the `result_test_requests` junction.
 *
 * Two surfaces need the same split:
 *  - the consolidated route (`/staff/queue/consolidated/{visit}/{group}`),
 *    which shows the entry form for work still on the bench AND a card for
 *    every report already finalised for that visit + group;
 *  - the results archive, which must show one PDF per report, not one per
 *    member test.
 *
 * No DB, no RSC — unit-tested in `consolidated-reports.test.ts`.
 */

/** Statuses the entry form works on (claim → encode → finalise). */
export const ENCODING_STATUSES = ["requested", "in_progress", "result_uploaded"] as const;

export interface ConsolidatedMemberRow {
  id: string;
  status: string;
  /** Linked result, if any (the junction is unique per test_request). */
  resultId: string | null;
  /** The linked result has a stored PDF — i.e. finalise completed. */
  hasPdf: boolean;
}

export interface ConsolidatedPartition {
  /** Test ids the entry form should claim / finalise, in input order. */
  encodeIds: string[];
  /** One entry per finished report, in first-seen order. */
  reports: { resultId: string; memberIds: string[] }[];
}

/**
 * Split a visit + group's member tests into "still to encode" and "already
 * finished reports".
 *
 * A test linked to a result WITH a stored PDF belongs to that report whatever
 * its status (`result_uploaded` awaiting sign-off, `ready_for_release`
 * awaiting payment, `released`) and must never reach the claim/finalise
 * controls — finalise refuses a test whose result already has a PDF. A test
 * linked to a result WITHOUT a PDF is a half-finished finalise attempt; it
 * stays in the form so a retry can complete it. Anything else (cancelled, or
 * an unexpected status with no report) is in neither list.
 *
 * Order-preserving: a report is inserted when its first member is seen.
 */
export function partitionConsolidatedMembers(
  rows: readonly ConsolidatedMemberRow[],
): ConsolidatedPartition {
  const encodeIds: string[] = [];
  const reports = new Map<string, string[]>();
  for (const r of rows) {
    if (r.resultId && r.hasPdf) {
      const members = reports.get(r.resultId);
      if (members) members.push(r.id);
      else reports.set(r.resultId, [r.id]);
      continue;
    }
    if ((ENCODING_STATUSES as readonly string[]).includes(r.status)) {
      encodeIds.push(r.id);
    }
  }
  return {
    encodeIds,
    reports: Array.from(reports, ([resultId, memberIds]) => ({ resultId, memberIds })),
  };
}

/**
 * The one status a report card headlines. A report is only "Released" once
 * every member is; otherwise the least-progressed member decides, because
 * that is what the patient is still waiting on.
 */
export function reportHeadlineStatus(statuses: readonly string[]): string {
  const order = ["result_uploaded", "ready_for_release", "released"];
  let worst = "released";
  for (const s of statuses) {
    const i = order.indexOf(s);
    if (i === -1) continue;
    if (i < order.indexOf(worst)) worst = s;
  }
  return worst;
}

/**
 * True when a service's code only repeats its name — `TRIGLYCERIDES` /
 * `TRIGLYCERIDES`, `SGOT_AST` / `SGOT/AST`. On prod that is 265 of 273 active
 * services, so printing both reads as every test listed twice. Compared
 * case-insensitively with everything but letters and digits stripped.
 */
export function codeDuplicatesName(code: string, name: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const c = norm(code);
  return c.length > 0 && c === norm(name);
}
