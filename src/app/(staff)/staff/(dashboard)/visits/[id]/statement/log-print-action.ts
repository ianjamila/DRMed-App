"use server";

import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";

/**
 * Record that staff printed a visit's statement of account.
 *
 * The statement discloses the patient's name, DRM-ID, every bill line and
 * every payment (RA 10173), so printing it leaves its own `statement.printed`
 * row, distinct from `statement.viewed` on render — the same split as the
 * receipt's `receipt.printed` / `receipt.viewed`.
 */
export async function logStatementPrintAction(visitId: string): Promise<void> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") return;
  const supabase = await createClient();

  // Deliberately NOT filtered on deleted_at, for the receipt's reason: this
  // hydrates the attribution on an audit row. The page 404s on a deleted
  // visit, so arriving here with one means it was deleted between render and
  // print — after window.print() — and the disclosure still happened.
  const { data: visit } = await supabase
    .from("visits")
    .select("id, visit_number, total_php, paid_php, patient_id")
    .eq("id", visitId)
    .maybeSingle();

  const { ip, ua } = await ipAndAgent();

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: visit?.patient_id ?? null,
    action: "statement.printed",
    resource_type: "visit",
    resource_id: visitId,
    metadata: {
      visit_number: visit?.visit_number ?? null,
      total_php: visit ? Number(visit.total_php) : null,
      paid_php: visit ? Number(visit.paid_php) : null,
    },
    ip_address: ip,
    user_agent: ua,
  });
}
