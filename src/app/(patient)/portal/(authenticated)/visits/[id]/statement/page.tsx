import Link from "next/link";
import { notFound } from "next/navigation";
import { createPatientClient } from "@/lib/supabase/patient";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { fetchStatement } from "@/lib/visits/statement-data";
import { auditPatientStatement } from "@/lib/portal/statement-audit";
import { StatementSheet } from "@/components/statement/statement-sheet";
import { PatientStatementPrintButton } from "./print-button";

export const metadata = {
  title: "Statement of account",
};
export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * The patient's own statement of account for one visit — the same sheet
 * reception prints (`StatementSheet`), so a patient claiming a reimbursement
 * no longer needs to come back to the counter for it.
 *
 * Read through the patient-scoped client: visits / test_requests / payments
 * RLS only return the patient's own rows, so another patient's visit id
 * loads nothing → notFound(). The patient-id comparison below stays as
 * defense in depth, like the visit page's `.eq("patient_id", …)`.
 */
export default async function PatientStatementPage({ params }: Props) {
  const { id } = await params;
  const patient = await requirePatientProfile();
  const db = await createPatientClient(patient.patient_id);

  const data = await fetchStatement(db, id);
  if (!data || data.patient.id !== patient.patient_id) notFound();

  await auditPatientStatement("statement.viewed", {
    patientId: patient.patient_id,
    drmId: patient.drm_id,
    visitId: data.visit.id,
    visitNumber: data.visit.visit_number,
  });

  return (
    // The receipt's A5 named page (globals.css), same as the staff copy.
    <div className="receipt-print mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-3 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/portal/visits/${data.visit.id}`}
          className="link-brand text-xs font-bold uppercase tracking-wider"
        >
          ← Visit
        </Link>
        <PatientStatementPrintButton visitId={data.visit.id} />
      </div>
      <p className="mb-4 text-sm text-[color:var(--color-brand-text-soft)] print:hidden">
        To keep a copy for your HMO or employer, press Print and choose
        &ldquo;Save as PDF&rdquo;.
      </p>
      <StatementSheet data={data} issuedAt={new Date()} />
    </div>
  );
}
