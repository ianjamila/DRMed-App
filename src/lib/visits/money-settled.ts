/**
 * "Money is settled" — the one predicate the app and the database agree on.
 *
 * A visit's money is settled when it is paid in full, waived, or billed to an
 * HMO. HMO patients never pay at the counter: the receivable is booked into
 * 1110 AR HMO by the GL bridge at RELEASE, and settlement follows months later
 * through the AR subledger. Gating on payment alone would therefore withhold
 * the result until after a settlement that only the release can trigger, so
 * `hmo_provider_id` is the carve-out.
 *
 * Two gates share this definition:
 *   * the lab-queue gate (labQueueGate in ./lab-gate.ts) — who may claim and
 *     see bench work, enforced in the claim Server Actions;
 *   * the results RELEASE gate — enforced by the DB trigger
 *     `enforce_payment_before_release` (migration 0133), which is the source of
 *     truth for money. Everything here is UX: it disables buttons and writes
 *     tooltips so staff are not sent into an error they cannot fix.
 *
 * Keep this in lockstep with 0133's SQL. The unit test pins both this
 * predicate and the PostgREST filter string.
 *
 * NOT covered by this definition, on purpose: the reception queue's stage
 * helper (./queue-stage.ts). "Waiting" there means the counter still has cash
 * to collect, which is a different question from whether results may leave the
 * building.
 */

export interface MoneySettledVisit {
  payment_status: string;
  hmo_provider_id: string | null;
}

/** Payment statuses that settle a visit on their own, without an HMO. */
export const SETTLED_PAYMENT_STATUSES = ["paid", "waived"] as const;

export function moneySettled(visit: MoneySettledVisit): boolean {
  return (
    (SETTLED_PAYMENT_STATUSES as readonly string[]).includes(
      visit.payment_status,
    ) || visit.hmo_provider_id !== null
  );
}

/**
 * The same predicate as a PostgREST `.or()` filter on an embedded `visits`
 * table — apply with `{ foreignTable: "visits" }` on a `visits!inner` join so
 * gated rows drop out of the query itself (keeping paging counts honest).
 */
export const MONEY_SETTLED_VISITS_OR =
  "payment_status.in.(paid,waived),hmo_provider_id.not.is.null";
