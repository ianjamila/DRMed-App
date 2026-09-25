"use server";

import { createPatientClient } from "@/lib/supabase/patient";
import { requirePatientProfile } from "@/lib/auth/require-patient";
import { reportError } from "@/lib/observability/report-error";
import { fetchStatement } from "@/lib/visits/statement-data";
import { sendStatementEmail, type SendStatementResult } from "@/lib/visits/send-statement-email";

/**
 * The patient's "Email it to me" on their own statement of account.
 *
 * Loaded through the patient-scoped client, so only the patient's own visit
 * can be sent, and only to the email on their own record. Same one-sender
 * claim, template and audit trail as the staff button (sendStatementEmail);
 * the audit row carries actor_type "patient".
 */
export async function emailMyStatementAction(visitId: string): Promise<SendStatementResult> {
  const patient = await requirePatientProfile();

  let data;
  try {
    data = await fetchStatement(await createPatientClient(patient.patient_id), visitId);
  } catch (err) {
    await reportError({ scope: "statement/email:portal-load", error: err, metadata: { visit_id: visitId } });
    return { ok: false, error: "Couldn't load your statement. Try again." };
  }
  if (!data || data.patient.id !== patient.patient_id) {
    return { ok: false, error: "This visit isn't available." };
  }

  return sendStatementEmail(data, { type: "patient", drmId: patient.drm_id });
}
