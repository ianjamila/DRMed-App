"use server";

import { createPatientClient } from "@/lib/supabase/patient";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { auditPatientStatement } from "@/lib/portal/statement-audit";

/**
 * Record that a patient printed (or saved as PDF) their statement of account.
 *
 * The visit is looked up through the patient-scoped client, so a visit id
 * that is not the caller's writes nothing — the audit row can only ever name
 * the patient's own visit.
 */
export async function logPatientStatementPrintAction(visitId: string): Promise<void> {
  // requirePatientProfile, like the page: it follows a merged record to the
  // surviving patient, whose id now owns the visit.
  const session = await requirePatientProfile();
  const db = await createPatientClient(session.patient_id);
  const { data: visit } = await db
    .from("visits")
    .select("id, visit_number")
    .eq("id", visitId)
    .eq("patient_id", session.patient_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!visit) return;

  await auditPatientStatement("statement.printed", {
    patientId: session.patient_id,
    drmId: session.drm_id,
    visitId: visit.id,
    visitNumber: visit.visit_number,
  });
}
