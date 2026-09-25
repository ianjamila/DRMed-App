/**
 * The emailed copy of a visit's statement of account.
 *
 * Same content as the printed page (`/staff/visits/[id]/statement`): every
 * bill line with a package's tests listed under it, every live payment, and
 * the balance. Like the paper, it never carries the portal PIN — the only
 * copy that does is the counter receipt.
 *
 * Pure (no `server-only`) so it is unit-tested; the send action feeds it the
 * same `fetchStatement` result the page renders.
 */
import { formatPhp } from "@/lib/marketing/format";
import { manilaDate, manilaDateTime } from "@/lib/dates/manila";
import { formatPatientName } from "@/lib/patients/format-name";
import { paymentMethodLabel } from "@/lib/accounting/money-routing";
import {
  arrangeReceiptRows,
  type PackageAwareReceiptLine,
} from "@/lib/visits/receipt-totals";
import type { StatementSummary } from "@/lib/visits/statement";
import {
  renderEmailShell,
  emailParagraph,
  emailDetailBox,
  emailFinePrint,
  emailAmountTable,
  escapeHtml,
  type EmailAmountRow,
} from "@/lib/notifications/branded-email";

export interface StatementEmailInput {
  patient: {
    first_name: string | null;
    middle_name: string | null;
    last_name: string | null;
    drm_id: string;
  };
  visit: { visit_number: string | number; visit_date: string };
  hmoName: string | null;
  lines: readonly (PackageAwareReceiptLine & { svc?: { name: string } | undefined })[];
  subtotal: number;
  totalDiscount: number;
  total: number;
  payments: readonly {
    amount_php: number | string;
    method: string | null;
    reference_number: string | null;
    received_at: string;
  }[];
  summary: StatementSummary;
  issuedAt: Date;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const NOT_A_RECEIPT = "This is a statement of account, not an official receipt.";

export function renderStatementEmail(input: StatementEmailInput): RenderedEmail {
  const { patient, visit, hmoName, summary } = input;
  const visitLabel = `#${visit.visit_number}`;
  const greeting = patient.first_name?.trim() || "there";
  const name = formatPatientName(patient);
  const visitLine = `${visitLabel} · ${manilaDate(visit.visit_date)}`;

  const billRows: EmailAmountRow[] = arrangeReceiptRows(input.lines).map((r) =>
    r.includedInPackage && !r.showAmounts
      ? { label: `· ${r.line.svc?.name ?? "Test"}`, amount: "", sub: true }
      : { label: r.line.svc?.name ?? "Service", amount: formatPhp(r.line.final) },
  );
  if (input.totalDiscount > 0) {
    billRows.push({ label: "Subtotal", amount: formatPhp(input.subtotal) });
    billRows.push({ label: "Discounts", amount: `− ${formatPhp(input.totalDiscount)}` });
  }
  billRows.push({ label: "Total charges", amount: formatPhp(input.total), total: true });

  const paymentRows: EmailAmountRow[] = input.payments.map((p) => ({
    label: [
      manilaDateTime(p.received_at),
      p.method ? paymentMethodLabel(p.method) : null,
      p.reference_number ? `ref ${p.reference_number}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    amount: formatPhp(Number(p.amount_php)),
  }));

  const balanceAmount = formatPhp(Math.abs(summary.balance));
  const summaryRows: EmailAmountRow[] = [
    { label: "Total charges", amount: formatPhp(summary.charges) },
    { label: "Total paid", amount: formatPhp(summary.paid) },
    ...(summary.waived > 0 ? [{ label: "Balance waived", amount: formatPhp(summary.waived) }] : []),
    { label: summary.balanceLabel, amount: balanceAmount, total: true },
  ];
  const hmoNote =
    hmoName && summary.balance > 0
      ? `The HMO's share is settled through the ${hmoName} claim, not at the counter.`
      : null;

  const subject = `Your DRMed statement of account — visit ${visitLabel}`;

  const pad = (label: string, amount: string) => `${label}  ${amount}`;
  const text = [
    `Hi ${greeting},`,
    "",
    "Here is the statement of account for your visit, as requested.",
    "",
    `Patient: ${name} (${patient.drm_id})`,
    `Visit: ${visitLine}${hmoName ? ` · billed to ${hmoName}` : ""}`,
    "",
    "CHARGES",
    ...billRows.map((r) =>
      r.sub ? `   ${r.label}` : r.total ? `${r.label}: ${r.amount}` : pad(r.label, r.amount),
    ),
    "",
    "PAYMENTS RECEIVED",
    ...(paymentRows.length === 0
      ? ["No payments recorded."]
      : paymentRows.map((r) => pad(r.label, r.amount))),
    "",
    ...summaryRows.map((r) => `${r.label}: ${r.amount}`),
    ...(hmoNote ? ["", hmoNote] : []),
    "",
    `Issued ${manilaDateTime(input.issuedAt)}. ${NOT_A_RECEIPT}`,
    "",
    "— DRMed Clinic and Laboratory",
  ].join("\n");

  const html = renderEmailShell({
    heading: "Your statement of account",
    contentHtml:
      emailParagraph(`Hi <b>${escapeHtml(greeting)}</b>,`) +
      emailParagraph("Here is the statement of account for your visit, as requested.") +
      emailDetailBox([
        { label: "Patient", value: `${name} (${patient.drm_id})` },
        { label: "Visit", value: visitLine },
        ...(hmoName ? [{ label: "Billed to", value: hmoName }] : []),
      ]) +
      emailParagraph("<b>Charges</b>") +
      emailAmountTable(billRows) +
      emailParagraph("<b>Payments received</b>") +
      (paymentRows.length === 0
        ? emailFinePrint("No payments recorded.")
        : emailAmountTable(paymentRows)) +
      emailAmountTable(summaryRows) +
      (hmoNote ? emailFinePrint(escapeHtml(hmoNote)) : "") +
      emailFinePrint(`Issued ${escapeHtml(manilaDateTime(input.issuedAt))}. ${NOT_A_RECEIPT}`),
    receivedNote:
      "You received this because DRMed staff emailed you the statement of account for your visit.",
  });

  return { subject, text, html };
}
