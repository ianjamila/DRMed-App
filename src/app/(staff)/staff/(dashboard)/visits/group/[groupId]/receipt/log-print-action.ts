"use server";

import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";

/**
 * Record that staff printed the combined (group) receipt — see
 * `visits/[id]/receipt/log-print-action.ts` for why this is its own audited
 * event, distinct from `receipt.viewed`. One row per print covering every
 * slip in the group, keyed by `visit_group_id` since that's what the URL
 * (and the printed page) is scoped to.
 */
export async function logGroupReceiptPrintAction(groupId: string): Promise<void> {
  const session = await requireActiveStaff();
  const supabase = await createClient();

  const { data: visits } = await supabase
    .from("visits")
    .select("id, visit_number, total_php, patient_id")
    .eq("visit_group_id", groupId)
    .is("deleted_at", null);

  const { ip, ua } = await ipAndAgent();

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: visits?.[0]?.patient_id ?? null,
    action: "receipt.printed",
    resource_type: "visit_group",
    resource_id: groupId,
    metadata: {
      visit_ids: (visits ?? []).map((v) => v.id),
      visit_numbers: (visits ?? []).map((v) => v.visit_number),
      total_php: (visits ?? []).reduce((s, v) => s + Number(v.total_php), 0),
    },
    ip_address: ip,
    user_agent: ua,
  });
}
