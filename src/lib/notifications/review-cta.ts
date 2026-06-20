import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

// True if this patient has already been sent a review CTA in a previously
// DELIVERED result email (audit metadata review_cta.shown === true). Filters on
// patient_id first, so even the common first-ask case (no matching row) is an
// index scan over that one patient's few result.notified rows via
// idx_audit_log_patient_id — never a full audit_log scan. No migration.
export async function patientAlreadyAskedForReview(
  admin: AdminClient,
  patientId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("audit_log")
    .select("id")
    .eq("patient_id", patientId)
    .eq("action", "result.notified")
    .eq("metadata->review_cta->>shown", "true")
    .limit(1);
  return Boolean(data && data.length > 0);
}
