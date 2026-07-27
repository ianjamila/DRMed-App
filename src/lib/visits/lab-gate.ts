/**
 * Lab-queue payment gate (partner revisions item 10, decision 1).
 *
 * A visit's lab work becomes claimable — and visible on the lab queue's
 * worklist tabs — only once the visit is fully paid, waived, or billed to an
 * HMO. HMO patients never pay at the counter (settlement comes months later
 * through the AR subledger), so a bare payment_status check would block every
 * HMO visit from the bench; `hmo_provider_id` is the carve-out.
 *
 * The passing payment statuses ('paid', 'waived') deliberately match both the
 * reception queue's "waiting" stage (queue-stage.ts) and the release trigger
 * `enforce_payment_before_release` — one definition of "money is settled"
 * across the app. This gate is enforced in the claim Server Actions; result
 * RELEASE stays enforced by the DB trigger, which remains the source of truth
 * for money. There is no claim-side DB trigger on purpose: non-claim writers
 * legitimately insert `in_progress` rows (package headers at visit creation,
 * legacy backfills).
 */

export interface LabGateVisitShape {
  payment_status: string;
  hmo_provider_id: string | null;
}

export type LabGate =
  | { ok: true }
  | { ok: false; reason: "waiting_for_payment"; hint: string };

const WAITING_HINT =
  "This visit is still waiting for payment. Lab work opens once it's fully paid or covered by an HMO.";

export function labQueueGate(visit: LabGateVisitShape): LabGate {
  const settled =
    visit.payment_status === "paid" || visit.payment_status === "waived";
  if (settled || visit.hmo_provider_id !== null) return { ok: true };
  return { ok: false, reason: "waiting_for_payment", hint: WAITING_HINT };
}

/**
 * The same predicate as a PostgREST `.or()` filter on the embedded `visits`
 * table — apply with `{ foreignTable: "visits" }` on a `visits!inner` join so
 * gated rows drop out of the queue query itself (keeping paging counts
 * honest). Keep in lockstep with labQueueGate(); the unit test pins both.
 */
export const LAB_QUEUE_GATE_VISITS_OR =
  "payment_status.in.(paid,waived),hmo_provider_id.not.is.null";
