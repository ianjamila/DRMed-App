"use server";

/**
 * Mark / unmark a visit as a sample (training or testing) visit — 0181.
 * Reception + admin only (canMarkSample); every change is audit-logged as
 * visit.sample_marked / visit.sample_unmarked. See src/lib/visits/sample.ts.
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { canMarkSample } from "@/lib/visits/sample";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertVisitPatientActive } from "@/lib/patients/require-active";

export type SetVisitSampleResult =
  | { ok: true }
  | { ok: false; error: string };

export async function setVisitSampleAction(
  visitId: string,
  isSample: boolean,
): Promise<SetVisitSampleResult> {
  const session = await requireActiveStaff();
  if (!canMarkSample(session.role)) {
    return {
      ok: false,
      error: "Only reception or admin can mark a sample visit.",
    };
  }

  // 0167: a deleted or merged patient's history is read-only until restored.
  const active = await assertVisitPatientActive(createAdminClient(), visitId);
  if (!active.ok) return { ok: false, error: active.error };

  const supabase = await createClient();
  // Live visits only: a deleted visit is already out of every report, and
  // flipping it would only add noise to the audit log.
  const { data: updated, error } = await supabase
    .from("visits")
    .update({ is_sample: isSample })
    .eq("id", visitId)
    .eq("is_sample", !isSample)
    .is("deleted_at", null)
    .select("id, visit_number, patient_id");
  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated || updated.length === 0) {
    revalidatePath(`/staff/visits/${visitId}`);
    return {
      ok: false,
      error: isSample
        ? "This visit is already marked as a sample, or was deleted. Refresh the page."
        : "This visit is no longer marked as a sample, or was deleted. Refresh the page.",
    };
  }

  const row = updated[0];
  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: row.patient_id,
    action: isSample ? "visit.sample_marked" : "visit.sample_unmarked",
    resource_type: "visit",
    resource_id: visitId,
    metadata: { visit_number: row.visit_number },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/visits/${visitId}`);
  revalidatePath("/staff/visits");
  revalidatePath("/staff/visits/queue");
  revalidatePath("/staff/queue");
  return { ok: true };
}
