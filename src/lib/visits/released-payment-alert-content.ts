// The staff alert "Payment removed after work was completed" (Admin Tools ›
// Email Alerts, alert key `released_payment_removed`, migration 0178). Pure —
// no DB, no server-only — so the privacy rule below is unit-tested.
//
// RA 10173: the email carries NO patient name, NO test names and NO free-text
// note (staff type anything into a note or an edit reason). It says which
// visit (by number), the payment's amount and method, whether it was deleted
// (and the reason category picked), edited (and to what) or moved (and where
// to), who did it, what work on the visit was already completed — released
// results and doctor lines marked done, as counts — and what the visit now
// owes. Enforced structurally: the input has no field for any of the
// excluded things.
import { formatPhp } from "@/lib/marketing/format";
import {
  emailButton,
  emailDetailBox,
  emailParagraph,
  escapeHtml,
  renderEmailShell,
} from "@/lib/notifications/branded-email";
import {
  completedWorkSummary,
  completedWorkWentPhrase,
  releasedOnItPhrase,
  type ReleasedCounts,
} from "./payment-edit";

export type ReleasedPaymentChange = "deleted" | "edited" | "moved";

export interface ReleasedPaymentAlertInput {
  change: ReleasedPaymentChange;
  visitNumber: string;
  /** The payment as it was — for an edit, BEFORE the edit. */
  amountPhp: number;
  methodLabel: string;
  /** Delete: the category label picked ("Recorded twice" …). Null otherwise — an edit's reason is free text and never sent. */
  reasonLabel: string | null;
  /** Move: the visit the payment went to. */
  movedToVisitNumber: string | null;
  /** Edit: what the payment became. */
  editedTo: { amountPhp: number; methodLabel: string } | null;
  byName: string | null;
  /** Completed work on the visit: released results, done consults, done procedures. */
  completed: ReleasedCounts;
  owesPhp: number;
  visitUrl: string;
}

export interface ReleasedPaymentAlertContent {
  subject: string;
  text: string;
  html: string;
}

export function buildReleasedPaymentAlertEmail(input: ReleasedPaymentAlertInput): ReleasedPaymentAlertContent {
  const payment = `${formatPhp(input.amountPhp)} ${input.methodLabel}`;
  const went = completedWorkWentPhrase(input.completed);
  const subject = `Visit #${input.visitNumber} owes ${formatPhp(input.owesPhp)} after ${went}`;
  const first =
    input.change === "edited"
      ? `A ${payment} payment on visit #${input.visitNumber} was edited to ${formatPhp(input.editedTo?.amountPhp ?? 0)} ${input.editedTo?.methodLabel ?? "?"}.`
      : `A ${payment} payment was ${input.change === "moved" ? "moved off" : "deleted from"} visit #${input.visitNumber}.`;
  const intro = `${first} ${capitalise(releasedOnItPhrase(input.completed))}, and it now owes ${formatPhp(input.owesPhp)}.`;
  const whatHappened =
    input.change === "moved"
      ? `Moved to visit #${input.movedToVisitNumber ?? "?"}`
      : input.change === "edited"
        ? `Edited to ${formatPhp(input.editedTo?.amountPhp ?? 0)} ${input.editedTo?.methodLabel ?? "?"}`
        : `Deleted${input.reasonLabel ? ` — ${input.reasonLabel}` : ""}`;
  const rows: { label: string; value: string }[] = [
    { label: "Visit", value: `#${input.visitNumber}` },
    { label: "Payment", value: payment },
    { label: "What happened", value: whatHappened },
    { label: "By", value: input.byName ?? "Unknown staff member" },
    { label: "Completed work", value: completedWorkSummary(input.completed) },
    { label: "Now owes", value: formatPhp(input.owesPhp) },
  ];
  const text = [
    intro,
    "Released results stay released — follow up the balance.",
    "",
    ...rows.map((r) => `${r.label}: ${r.value}`),
    "",
    `Open the visit: ${input.visitUrl}`,
  ].join("\n");
  const html = renderEmailShell({
    heading: "Payment removed after work was completed",
    contentHtml:
      emailParagraph(escapeHtml(intro)) +
      emailParagraph("Released results stay released — follow up the balance.") +
      emailDetailBox(rows) +
      emailButton("Open the visit", input.visitUrl, "cyan"),
    receivedNote:
      'You\'re receiving this because you\'re switched on for the "Payment removed after work was completed" alert. An admin can change who gets it under Admin Tools › Email Alerts.',
  });
  return { subject, text, html };
}

function capitalise(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * Whether a Delete / Move should alert: the visit owes again and work on it
 * was already completed (released results + done doctor lines; a null from a
 * failed re-read never alerts).
 */
export function shouldAlertReleasedPaymentRemoved(input: {
  settledAfter: boolean | null;
  completedWork: number | null;
}): boolean {
  return input.settledAfter === false && (input.completedWork ?? 0) > 0;
}

/**
 * Whether an Edit should alert. Same two conditions, plus: the edit must have
 * taken money OFF the visit — the amount came down. A reference/notes-only
 * edit, a method-only change or an amount going up removes nothing, and
 * "Payment removed" would be untrue.
 */
export function shouldAlertPaymentEdited(input: {
  moneyChanged: boolean;
  oldAmountPhp: number;
  newAmountPhp: number;
  settledAfter: boolean | null;
  completedWork: number | null;
}): boolean {
  if (!input.moneyChanged) return false;
  if (Math.round(input.newAmountPhp * 100) >= Math.round(input.oldAmountPhp * 100)) return false;
  return shouldAlertReleasedPaymentRemoved(input);
}
