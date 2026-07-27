/**
 * Which visits get a printed receipt (partner revisions item 1, decision 4).
 *
 * The clinic asked us to stop printing a slip for doctor consultations: the
 * patient pays the consultation fee at the counter and walks to the doctor —
 * the paper served no purpose and wasted a sheet per patient.
 *
 * The caveat the audit flagged is that the receipt is also the delivery
 * vehicle for the one-time portal Secure PIN. Decision 4 accepted that: a
 * consultation-only patient has no lab result to view, so no portal access is
 * lost. The moment ANY non-consult line is on the order — a lab test, an
 * imaging study, a doctor procedure — the receipt comes back, PIN and all.
 * (A mixed order is stored as two visits sharing a `visit_group_id`, so the
 * lab half still prints its slip and carries the PIN; only the doctor half's
 * slip is suppressed.)
 *
 * No server-only imports — unit-testable, and used by both the server action
 * that redirects after visit creation and the receipt pages themselves.
 */

import { classifyKind } from "./classification";

/**
 * True when every billable line on the order is a doctor consultation.
 *
 * An EMPTY line list is deliberately NOT consultation-only: "we know of no
 * lines" must never suppress a receipt, since the caller may simply have
 * failed to load them.
 */
export function isConsultOnlyOrder(kinds: readonly string[]): boolean {
  if (kinds.length === 0) return false;
  return kinds.every((kind) => classifyKind(kind) === "consult");
}

/**
 * Whether a visit should print a receipt at all. The inverse of
 * `isConsultOnlyOrder`, named for the calling site so the pages read as
 * policy rather than as a kind check.
 */
export function shouldPrintReceipt(kinds: readonly string[]): boolean {
  return !isConsultOnlyOrder(kinds);
}

/** Shown wherever a suppressed receipt would otherwise have been offered. */
export const CONSULT_ONLY_RECEIPT_NOTE =
  "Consultation-only visits don't print a receipt. Add lab work or a procedure to the visit and a slip (with the patient's portal PIN) prints for it.";
