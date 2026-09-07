/**
 * Lab-queue payment gate (partner revisions item 10, decision 1).
 *
 * A visit's lab work becomes claimable — and visible on the lab queue's
 * worklist tabs — only once the visit is fully paid, waived, or billed to an
 * HMO. HMO patients never pay at the counter (settlement comes months later
 * through the AR subledger), so a bare payment_status check would block every
 * HMO visit from the bench; `hmo_provider_id` is the carve-out.
 *
 * The predicate itself lives in ./money-settled.ts, because the release
 * trigger `enforce_payment_before_release` encodes exactly the same rule since
 * migration 0133 — one definition of "money is settled" across the app. (It
 * did not always: until 0133 the release trigger was paid/waived only, and an
 * HMO visit could reach the bench but never reach the patient.) The reception
 * queue's "waiting" stage (queue-stage.ts) deliberately stays payment-only.
 *
 * This gate is enforced in the claim Server Actions; result RELEASE stays
 * enforced by the DB trigger, which remains the source of truth for money.
 * There is no claim-side DB trigger on purpose: non-claim writers legitimately
 * insert `in_progress` rows (package headers at visit creation, legacy
 * backfills).
 */

import {
  MONEY_SETTLED_VISITS_OR,
  moneySettled,
  type MoneySettledVisit,
} from "./money-settled";

export type LabGateVisitShape = MoneySettledVisit;

export type LabGate =
  | { ok: true }
  | { ok: false; reason: "waiting_for_payment"; hint: string };

const WAITING_HINT =
  "This visit is still waiting for payment. Lab work opens once it's fully paid or covered by an HMO.";

export function labQueueGate(visit: LabGateVisitShape): LabGate {
  if (moneySettled(visit)) return { ok: true };
  return { ok: false, reason: "waiting_for_payment", hint: WAITING_HINT };
}

/**
 * The same predicate as a PostgREST `.or()` filter on the embedded `visits`
 * table — apply with `{ foreignTable: "visits" }` on a `visits!inner` join so
 * gated rows drop out of the queue query itself (keeping paging counts
 * honest). Keep in lockstep with labQueueGate(); the unit test pins both.
 */
export const LAB_QUEUE_GATE_VISITS_OR = MONEY_SETTLED_VISITS_OR;
