/**
 * Queue-entry deletion eligibility (partner revisions item 22, decision 6).
 *
 * Reception + admin may soft-delete UNPAID queue entries only; entries with
 * recorded payments go through admin payment-void first, which recalcs the
 * visit back to 'unpaid' and re-opens this path. The DB triggers in
 * 0125_queue_entry_soft_delete.sql are the source of truth — these pure
 * helpers exist so the UI can decide which affordances to render (and what
 * hint to show when deletion is blocked) without a server round-trip.
 */

export const QUEUE_DELETE_ROLES: ReadonlySet<string> = new Set([
  "reception",
  "admin",
]);

export type DeleteBlockedReason =
  | "role"
  | "already_deleted"
  | "has_payments"
  | "waived"
  | "released"
  | "package_component"
  | "shared_report"
  | "hmo_claimed";

export type Deletability =
  | { ok: true }
  | { ok: false; reason: DeleteBlockedReason; hint: string };

const HINTS: Record<DeleteBlockedReason, string> = {
  role: "Only reception or admin can delete queue entries.",
  already_deleted: "Already deleted.",
  has_payments: "Has recorded payments — void them first.",
  waived: "Balance was waived — deletion not available.",
  released: "Has a released result — undo the release first.",
  package_component: "Part of a package — delete the whole package instead.",
  shared_report:
    "Part of a finished combined report (e.g. Chemistry) — it can’t be deleted on its own.",
  hmo_claimed: "Already claimed from an HMO — void the claim batch first.",
};

function blocked(reason: DeleteBlockedReason): Deletability {
  return { ok: false, reason, hint: HINTS[reason] };
}

/** An `hmo_claim_items ( batch_voided )` embed, as PostgREST returns it. */
export interface ClaimItemEmbed {
  batch_voided: boolean;
}

/**
 * Is this line's money still out with an HMO? (0147, P0050.)
 *
 * Select the flag and filter HERE — never `.eq("hmo_claim_items.batch_voided",
 * false)` on the embed. PostgREST silently ignores a filter on a LEFT-joined
 * embed and hands back every row, so that spelling compiles, runs, and reports
 * an open claim for a batch that was voided months ago.
 */
export function hasOpenHmoClaim(
  items: readonly ClaimItemEmbed[] | null | undefined,
): boolean {
  return (items ?? []).some((ci) => !ci.batch_voided);
}

/**
 * One `result_test_requests` row, flattened for the fold below: which result
 * a test links to, and whether that result has a stored PDF.
 */
export interface ResultLinkRow {
  test_request_id: string;
  result_id: string;
  storage_path: string | null;
}

/**
 * Which test_request ids sit on a FINISHED combined report — linked to a
 * result with a stored PDF that has more than one linked test (0172, P0067).
 *
 * A result linked to exactly one test is an ordinary single-test report and
 * stays deletable as before; only a report shared by several tests (the
 * chemistry panel) locks its members, because deleting one alone would leave
 * a PDF that still reports a test the bill no longer has.
 *
 * Fold, not a per-row lookup: whether a test is "shared" depends on how many
 * OTHER rows link to the same result, so the caller fetches every relevant
 * junction row once (batched) and this counts membership.
 */
export function sharedReportTestIds(
  links: readonly ResultLinkRow[],
): ReadonlySet<string> {
  const byResult = new Map<string, string[]>();
  for (const l of links) {
    if (!l.storage_path) continue;
    const members = byResult.get(l.result_id) ?? [];
    members.push(l.test_request_id);
    byResult.set(l.result_id, members);
  }
  const shared = new Set<string>();
  for (const members of byResult.values()) {
    if (members.length > 1) {
      for (const id of members) shared.add(id);
    }
  }
  return shared;
}

export interface VisitDeleteShape {
  payment_status: string;
  deleted_at: string | null;
  /** Statuses of the visit's test_requests (all of them, incl. headers). */
  test_statuses: readonly string[];
  /**
   * Does ANY of the visit's lines carry a non-voided `hmo_claim_item`? (0147,
   * P0050.) Required rather than optional so a new caller has to answer it —
   * defaulting it to false would quietly re-offer a delete the DB refuses.
   */
  has_open_hmo_claim: boolean;
}

export function visitDeletability(
  role: string,
  visit: VisitDeleteShape,
): Deletability {
  if (!QUEUE_DELETE_ROLES.has(role)) return blocked("role");
  if (visit.deleted_at !== null) return blocked("already_deleted");
  if (visit.payment_status === "waived") return blocked("waived");
  if (visit.payment_status !== "unpaid") return blocked("has_payments");
  if (visit.test_statuses.includes("released")) return blocked("released");
  if (visit.has_open_hmo_claim) return blocked("hmo_claimed");
  return { ok: true };
}

/**
 * What the visit page offers in place of the header's Delete button.
 *
 * - `none`: this role never deletes visits — render nothing.
 * - `delete`: the ordinary Delete.
 * - `sample`: admin only, and released results are the ONLY blocker — offer
 *   "Delete sample visit" (deleteSampleVisitAction undoes the releases, then
 *   deletes). Re-running the rule without the released statuses means a
 *   later blocker (an open HMO claim) is reported rather than hidden behind
 *   "released".
 * - `blocked`: say why, instead of hiding the button.
 */
export type VisitDeleteAffordance =
  | { kind: "none" }
  | { kind: "delete" }
  | { kind: "sample" }
  | { kind: "blocked"; hint: string };

export const RELEASED_ASK_ADMIN_HINT =
  "Has a released result — ask an admin to delete it.";

export function withoutReleased(visit: VisitDeleteShape): VisitDeleteShape {
  return {
    ...visit,
    test_statuses: visit.test_statuses.filter((s) => s !== "released"),
  };
}

export function visitDeleteAffordance(
  role: string,
  visit: VisitDeleteShape,
): VisitDeleteAffordance {
  const d = visitDeletability(role, visit);
  if (d.ok) return { kind: "delete" };
  if (d.reason === "role") return { kind: "none" };
  if (d.reason !== "released") return { kind: "blocked", hint: d.hint };
  const rest = visitDeletability(role, withoutReleased(visit));
  if (!rest.ok) return { kind: "blocked", hint: rest.hint };
  return role === "admin"
    ? { kind: "sample" }
    : { kind: "blocked", hint: RELEASED_ASK_ADMIN_HINT };
}

export interface TestDeleteShape {
  status: string;
  deleted_at: string | null;
  parent_id: string | null;
  visit_payment_status: string;
  visit_deleted_at: string | null;
  /** Does THIS line carry a non-voided `hmo_claim_item`? (0147, P0050.) */
  has_open_hmo_claim: boolean;
  /**
   * Is this line one of SEVERAL tests linked to a finished combined report
   * (0172, P0067) — `sharedReportTestIds` says so. Required rather than
   * optional so a new caller has to answer it — defaulting it to false would
   * quietly re-offer a delete the DB refuses.
   */
  has_shared_report: boolean;
}

export function testDeletability(
  role: string,
  test: TestDeleteShape,
): Deletability {
  if (!QUEUE_DELETE_ROLES.has(role)) return blocked("role");
  if (test.deleted_at !== null || test.visit_deleted_at !== null) {
    return blocked("already_deleted");
  }
  if (test.status === "released") return blocked("released");
  if (test.parent_id !== null) return blocked("package_component");
  // Mirrors the trigger's order (0172): the combined-report reason comes
  // next, then the HMO-claim reason, both ahead of the generic "not unpaid"
  // (which an HMO visit never trips anyway — 0133).
  if (test.has_shared_report) return blocked("shared_report");
  if (test.has_open_hmo_claim) return blocked("hmo_claimed");
  if (test.visit_payment_status === "waived") return blocked("waived");
  if (test.visit_payment_status !== "unpaid") return blocked("has_payments");
  return { ok: true };
}
