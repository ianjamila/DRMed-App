import "server-only";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

/**
 * Audit a patient opening or printing their own statement of account in the
 * portal (RA 10173: every patient view of their record is logged).
 *
 * `statement.viewed` is deduped over five minutes, like the staff page's —
 * the portal page is force-dynamic, so every back-button nav re-renders it.
 * The dedupe reads `audit_log`, the compliance ledger, which patients cannot
 * read under RLS; that is the only service-role use here (the same kind of
 * read the portal's data-export route is allowlisted for). The statement's
 * own data is read by the caller through the patient-scoped client.
 */
export async function auditPatientStatement(
  action: "statement.viewed" | "statement.printed",
  entry: { patientId: string; drmId: string; visitId: string; visitNumber: string | number | null },
): Promise<void> {
  if (action === "statement.viewed") {
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data } = await createAdminClient()
      .from("audit_log")
      .select("id")
      .eq("actor_type", "patient")
      .eq("action", action)
      .eq("patient_id", entry.patientId)
      .eq("resource_id", entry.visitId)
      .gte("created_at", since)
      .limit(1);
    if (data && data.length > 0) return;
  }

  const h = await headers();
  await audit({
    actor_id: null,
    actor_type: "patient",
    patient_id: entry.patientId,
    action,
    resource_type: "visit",
    resource_id: entry.visitId,
    metadata: { drm_id: entry.drmId, visit_number: entry.visitNumber, via: "portal" },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });
}
