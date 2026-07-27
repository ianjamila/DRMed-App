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
  | "package_component";

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
};

function blocked(reason: DeleteBlockedReason): Deletability {
  return { ok: false, reason, hint: HINTS[reason] };
}

export interface VisitDeleteShape {
  payment_status: string;
  deleted_at: string | null;
  /** Statuses of the visit's test_requests (all of them, incl. headers). */
  test_statuses: readonly string[];
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
  return { ok: true };
}

export interface TestDeleteShape {
  status: string;
  deleted_at: string | null;
  parent_id: string | null;
  visit_payment_status: string;
  visit_deleted_at: string | null;
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
  if (test.visit_payment_status === "waived") return blocked("waived");
  if (test.visit_payment_status !== "unpaid") return blocked("has_payments");
  return { ok: true };
}
