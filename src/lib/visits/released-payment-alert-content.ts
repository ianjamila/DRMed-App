// The staff alert "Payment removed after results went out" (Admin Tools ›
// Email Alerts, alert key `released_payment_removed`, migration 0178). Pure —
// no DB, no server-only — so the privacy rule below is unit-tested.
//
// RA 10173: the email carries NO patient name, NO test names and NO free-text
// note (staff type anything into a note). It says which visit (by number),
// the payment's amount and method, whether it was deleted or moved (and the
// reason category picked), who did it, how many results had gone out, and
// what the visit now owes. Enforced structurally: the input has no field for
// any of the excluded things.
import { formatPhp } from "@/lib/marketing/format";
import {
  emailButton,
  emailDetailBox,
  emailParagraph,
  escapeHtml,
  renderEmailShell,
} from "@/lib/notifications/branded-email";

export interface ReleasedPaymentAlertInput {
  change: "deleted" | "moved";
  visitNumber: string;
  amountPhp: number;
  methodLabel: string;
  /** Delete: the category label picked ("Recorded twice" …). Null for a move. */
  reasonLabel: string | null;
  /** Move: the visit the payment went to. */
  movedToVisitNumber: string | null;
  byName: string | null;
  releasedResults: number;
  owesPhp: number;
  visitUrl: string;
}

export interface ReleasedPaymentAlertContent {
  subject: string;
  text: string;
  html: string;
}

export function buildReleasedPaymentAlertEmail(input: ReleasedPaymentAlertInput): ReleasedPaymentAlertContent {
  const verb = input.change === "moved" ? "moved off" : "deleted from";
  const results = `${input.releasedResults} ${input.releasedResults === 1 ? "result" : "results"}`;
  const subject = `Visit #${input.visitNumber} owes ${formatPhp(input.owesPhp)} after its results went out`;
  const intro = `A ${formatPhp(input.amountPhp)} ${input.methodLabel} payment was ${verb} visit #${input.visitNumber}. ${results} on that visit had already been released, and it now owes ${formatPhp(input.owesPhp)}.`;
  const rows: { label: string; value: string }[] = [
    { label: "Visit", value: `#${input.visitNumber}` },
    { label: "Payment", value: `${formatPhp(input.amountPhp)} ${input.methodLabel}` },
    {
      label: "What happened",
      value:
        input.change === "moved"
          ? `Moved to visit #${input.movedToVisitNumber ?? "?"}`
          : `Deleted${input.reasonLabel ? ` — ${input.reasonLabel}` : ""}`,
    },
    { label: "By", value: input.byName ?? "Unknown staff member" },
    { label: "Results already released", value: String(input.releasedResults) },
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
    heading: "Payment removed after results went out",
    contentHtml:
      emailParagraph(escapeHtml(intro)) +
      emailParagraph("Released results stay released — follow up the balance.") +
      emailDetailBox(rows) +
      emailButton("Open the visit", input.visitUrl, "cyan"),
    receivedNote:
      'You\'re receiving this because you\'re switched on for the "Payment removed after results went out" alert. An admin can change who gets it under Admin Tools › Email Alerts.',
  });
  return { subject, text, html };
}

/** Whether a Delete / Move should alert: the visit owes again and results already went out. */
export function shouldAlertReleasedPaymentRemoved(input: {
  settledAfter: boolean | null;
  releasedResults: number | null;
}): boolean {
  return input.settledAfter === false && (input.releasedResults ?? 0) > 0;
}
