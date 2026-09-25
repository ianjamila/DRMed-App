import { formatPhp } from "@/lib/marketing/format";
import { manilaDate, manilaDateTime } from "@/lib/dates/manila";
import { CONTACT, SITE } from "@/lib/marketing/site";
import { formatPatientName } from "@/lib/patients/format-name";
import { paymentMethodLabel } from "@/lib/accounting/money-routing";
import type { StatementData } from "@/lib/visits/statement-data";
import { ReceiptLinesTable } from "@/components/staff/receipt-lines-table";

/**
 * The statement of account sheet — one visit's bill lines, live payments and
 * balance, with no portal PIN.
 *
 * Rendered by the staff page (`/staff/visits/[id]/statement`) and the patient
 * portal (`/portal/visits/[id]/statement`) from the same `fetchStatement`
 * result, so the two can never show different figures. Place it inside a
 * `.receipt-print` wrapper: it prints on the receipt's A5 named page.
 */
export function StatementSheet({
  data,
  issuedAt,
  issuedBy,
}: {
  data: StatementData;
  issuedAt: Date;
  /** Staff name on the staff copy; omitted on the patient's own copy. */
  issuedBy?: string;
}) {
  const {
    visit, patient, hmo, lines, subtotal, totalDiscount, total, payments, summary, hasSeniorPwdLine,
  } = data;
  const cell = "px-2 py-2 first:pl-0 last:pr-0 print:py-1";

  return (
    <article className="receipt-sheet rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-8 print:border-0 print:p-0 print:text-xs">
      <header className="border-b border-[color:var(--color-brand-bg-mid)] pb-4 print:pb-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- plain img prints reliably */}
        <img src="/logo.png" alt="DRMed" className="mb-2 h-14 w-auto print:mb-1 print:h-10" />
        <p className="font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)] print:text-lg">
          {SITE.name}
        </p>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          {CONTACT.address.line1}, {CONTACT.address.line2}, {CONTACT.address.city}
        </p>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          {CONTACT.phone.mobile} · {CONTACT.phone.landline} · {CONTACT.email}
        </p>
        <p className="mt-2 inline-block rounded bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)]">
          Statement of account
        </p>
      </header>

      <div className="grid gap-3 border-b border-[color:var(--color-brand-bg-mid)] py-4 text-sm sm:grid-cols-2 print:py-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Patient
          </p>
          <p className="mt-0.5 font-semibold text-[color:var(--color-brand-navy)]">
            {formatPatientName(patient)}
          </p>
          <p className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
            {patient.drm_id}
          </p>
        </div>
        <div className="sm:text-right">
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Visit
          </p>
          <p className="mt-0.5 font-semibold">
            #{visit.visit_number} · {manilaDate(visit.visit_date)}
          </p>
          {hmo ? (
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Billed to {hmo.name}
            </p>
          ) : null}
        </div>
      </div>

      {lines.length === 0 ? (
        <p className="py-6 text-sm text-[color:var(--color-brand-text-soft)]">
          No charges on this visit.
        </p>
      ) : (
        <ReceiptLinesTable
          lines={lines}
          subtotal={subtotal}
          totalDiscount={totalDiscount}
          total={total}
          totalLabel="Total charges"
          discountNote={
            hasSeniorPwdLine && patient.senior_pwd_id_number ? (
              <span className="ml-2 text-xs">
                (Senior/PWD ID: {patient.senior_pwd_id_number})
              </span>
            ) : null
          }
        />
      )}

      <section className="mt-4 break-inside-avoid border-t border-[color:var(--color-brand-bg-mid)] pt-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Payments received
        </h2>
        {payments.length === 0 ? (
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            No payments recorded.
          </p>
        ) : (
          <table className="mt-1 w-full text-sm print:text-xs">
            <thead className="text-left text-xs text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className={cell}>Date</th>
                <th className={cell}>Method</th>
                <th className={cell}>Reference</th>
                <th className={`${cell} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className={`${cell} whitespace-nowrap`}>{manilaDateTime(p.received_at)}</td>
                  <td className={cell}>{p.method ? paymentMethodLabel(p.method) : "—"}</td>
                  <td className={`${cell} [overflow-wrap:anywhere]`}>{p.reference_number ?? "—"}</td>
                  <td className={`${cell} whitespace-nowrap text-right tabular-nums`}>
                    {formatPhp(Number(p.amount_php))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-sm">
          <dt className="text-right text-[color:var(--color-brand-text-soft)]">Total charges</dt>
          <dd className="text-right tabular-nums">{formatPhp(summary.charges)}</dd>
          <dt className="text-right text-[color:var(--color-brand-text-soft)]">Total paid</dt>
          <dd className="text-right tabular-nums">− {formatPhp(summary.paid)}</dd>
          {summary.waived > 0 ? (
            <>
              <dt className="text-right text-[color:var(--color-brand-text-soft)]">Balance waived</dt>
              <dd className="text-right tabular-nums">− {formatPhp(summary.waived)}</dd>
            </>
          ) : null}
          <dt className="border-t-2 border-[color:var(--color-brand-navy)] pt-2 text-right font-bold">
            {summary.balanceLabel}
          </dt>
          <dd className="border-t-2 border-[color:var(--color-brand-navy)] pt-2 text-right font-heading text-xl font-extrabold tabular-nums">
            {formatPhp(Math.abs(summary.balance))}
          </dd>
        </dl>
        {hmo && summary.balance > 0 ? (
          <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
            The HMO&apos;s share is settled through the {hmo.name} claim, not at the counter.
          </p>
        ) : null}
      </section>

      <p className="mt-6 text-[10px] text-[color:var(--color-brand-text-soft)] print:mt-3">
        Issued {manilaDateTime(issuedAt)}{issuedBy ? ` by ${issuedBy}` : ""}. This is a
        statement of account, not an official receipt.
      </p>
    </article>
  );
}
