/**
 * Status tabs for /staff/results.
 *
 * "Unclaimed" and "In progress" split the SAME pair of pre-result statuses
 * ('requested', 'in_progress') by OWNERSHIP rather than by status: a test is
 * unclaimed while `assigned_to` is null and in progress once somebody holds it.
 * That matches how the rest of the app already counts unclaimed work — the lab
 * dashboard's "Unclaimed in my sections" card and its "Oldest unclaimed" strip
 * both run `status in ('requested','in_progress') and assigned_to is null`.
 *
 * Before the split, In progress ran the bare status pair, so a test nobody had
 * picked up looked identical to one already on the bench and the archive had no
 * way to answer "what is waiting for someone to start it?".
 *
 * Splitting on the assignee rather than on the status keeps the two tabs a
 * partition — every pre-result row lands in exactly one of them, including the
 * off-nominal combinations the state machine shouldn't mint but the column
 * permits (claim sets status + assignee together, unclaim clears both, and
 * neither is DB-constrained).
 */

export const RESULT_STATUSES = [
  "all",
  "released",
  "ready",
  "in_progress",
  "unclaimed",
  "cancelled",
] as const;

export type ResultStatusFilter = (typeof RESULT_STATUSES)[number];

export const RESULT_STATUS_LABEL: Record<ResultStatusFilter, string> = {
  all: "All",
  released: "Released",
  ready: "Ready for release",
  in_progress: "In progress",
  unclaimed: "Unclaimed",
  cancelled: "Cancelled",
};

/** The assignee predicate a tab layers on top of its status set. */
export type AssigneeScope = "any" | "unclaimed" | "claimed";

export interface ResultStatusSpec {
  /** Underlying `test_requests.status` values the tab covers. */
  statuses: string[];
  assignee: AssigneeScope;
  /**
   * Unclaimed is a worklist — the row that has waited longest matters most, so
   * it sorts oldest-first like the lab queue's worklist tabs. Every other tab
   * is an archive view and stays newest-first.
   */
  oldestFirst: boolean;
}

export const RESULT_STATUS_SPEC: Record<
  Exclude<ResultStatusFilter, "all">,
  ResultStatusSpec
> = {
  released: { statuses: ["released"], assignee: "any", oldestFirst: false },
  ready: {
    statuses: ["result_uploaded", "ready_for_release"],
    assignee: "any",
    oldestFirst: false,
  },
  in_progress: {
    statuses: ["requested", "in_progress"],
    assignee: "claimed",
    oldestFirst: false,
  },
  unclaimed: {
    statuses: ["requested", "in_progress"],
    assignee: "unclaimed",
    oldestFirst: true,
  },
  cancelled: { statuses: ["cancelled"], assignee: "any", oldestFirst: false },
};

/** Narrow an untrusted `?status=` search param to a known tab. */
export function parseResultStatusFilter(
  raw: string | undefined,
): ResultStatusFilter {
  return RESULT_STATUSES.includes(raw as ResultStatusFilter)
    ? (raw as ResultStatusFilter)
    : "all";
}

/** `undefined` for "All", which applies no status/assignee narrowing. */
export function resultStatusSpec(
  filter: ResultStatusFilter,
): ResultStatusSpec | undefined {
  return filter === "all" ? undefined : RESULT_STATUS_SPEC[filter];
}
