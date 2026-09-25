import { ROUTE_NAME } from "@/lib/staff/route-names";
import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { hasRecentAudit } from "@/lib/server/action-helpers";
import { formatPhp } from "@/lib/marketing/format";
import { manilaDate, manilaDateTime } from "@/lib/dates/manila";
import { CONTACT, SITE } from "@/lib/marketing/site";
import { formatPatientName } from "@/lib/patients/format-name";
import { paymentMethodLabel } from "@/lib/accounting/money-routing";
import { STATEMENT_ROLES } from "@/lib/visits/statement";
import { fetchStatement } from "@/lib/visits/statement-data";
import { ReceiptLinesTable } from "@/components/staff/receipt-lines-table";
import { StatementPrintButton } from "./print-button";
import { EmailStatementButton } from "./email-button";

// One load per request, shared by metadata and the page (and, outside this
// request, by the emailed copy — see statement-data.ts).
const loadStatement = cache(async (id: string) =>
  fetchStatement(await createClient(), id),
);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireActiveStaff();
  const { id } = await params;
  if (!STATEMENT_ROLES.has(session.role)) return { title: ROUTE_NAME["/staff/visits/[id]/statement"] };
  return detailMetadata(ROUTE_NAME["/staff/visits/[id]/statement"], async () => {
    const data = await loadStatement(id).catch(() => null);
    return data ? data.visit.visit_number : null;
  });
}
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * Statement of account for one visit: every bill line, every payment and the
 * balance, with no portal PIN.
 *
 * The receipt is the counter slip that carries the PIN, and a consultation-
 * only visit prints none. This is the paper for everything else — a patient
 * claiming reimbursement from a company or HMO, a reprint for the file after
 * the PIN is gone, proof of a partial payment.
 */
export default async function StatementPage({ params }: Props) {
  const { id } = await params;
  const session = await requireActiveStaff();
  if (!STATEMENT_ROLES.has(session.role)) redirect(`/staff/visits/${id}`);
  const data = await loadStatement(id);
  if (!data) notFound();
  const {
    visit, patient, hmo, lines, subtotal, totalDiscount, total, payments, summary, hasSeniorPwdLine,
  } = data;

  // Viewing the statement discloses name, DRM-ID, bill lines and payments
  // (RA 10173). Deduped like `receipt.viewed`: force-dynamic re-renders on
  // every back-button nav.
  const admin = createAdminClient();
  const recentlyViewed = await hasRecentAudit(
    admin,
    { actor_id: session.user_id, action: "statement.viewed", resource_id: visit.id },
    5,
  );
  if (!recentlyViewed) {
    const h = await headers();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: patient.id,
      action: "statement.viewed",
      resource_type: "visit",
      resource_id: visit.id,
      metadata: {
        visit_number: visit.visit_number,
        line_count: lines.length,
        payment_count: payments.length,
        balance_php: summary.balance,
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

  const cell = "px-2 py-2 first:pl-0 last:pr-0 print:py-1";

  return (
    // Shares the receipt's A5 named page (globals.css): the statement files
    // beside the receipts it summarises.
    <div className="receipt-print mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/staff/visits/${visit.id}`}
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Visit
        </Link>
        <div className="flex flex-wrap items-start justify-end gap-2">
          <EmailStatementButton
            visitId={visit.id}
            patientEmail={patient.email}
            patientId={patient.id}
          />
          <StatementPrintButton visitId={visit.id} />
        </div>
      </div>

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
          Issued {manilaDateTime(new Date())} by {session.full_name}. This is a
          statement of account, not an official receipt.
        </p>
      </article>
    </div>
  );
}
