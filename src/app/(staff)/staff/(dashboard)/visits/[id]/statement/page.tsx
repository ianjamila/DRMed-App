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
import { STATEMENT_ROLES } from "@/lib/visits/statement";
import { fetchStatement } from "@/lib/visits/statement-data";
import { StatementSheet } from "@/components/statement/statement-sheet";
import { StatementPrintButton } from "./print-button";
import { EmailStatementButton } from "@/components/staff/email-statement-button";

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
  const { visit, patient, lines, payments, summary } = data;

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
            isSample={visit.is_sample}
          />
          <StatementPrintButton visitId={visit.id} />
        </div>
      </div>

      <StatementSheet data={data} issuedAt={new Date()} issuedBy={session.full_name} />
    </div>
  );
}
