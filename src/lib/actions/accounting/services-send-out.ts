"use server";

// updateSendOutConfig — partial-update action focused on the send-out fields
// (unit cost + vendor). The full /staff/admin/services/[id]/edit form submits
// through `services/actions.ts` updateServiceAction, which also handles all
// other service columns (name, price, kind, etc.) in one round-trip. Use
// THIS action for programmatic / quick-edit paths (e.g., the
// /cogs/send-outs/unconfigured remediation page) where only the send-out
// fields need to change.

import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { SendOutConfigSchema } from "@/lib/validations/accounting";

type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export async function updateSendOutConfig(input: {
  service_id: string;
  send_out_unit_cost_php: number;
  send_out_vendor_id: string;
}): Promise<ActionResult<{ updated: true }>> {
  const staff = await requireAdminStaff();
  const parsed = SendOutConfigSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };

  const admin = createAdminClient();

  const { data: before } = await admin
    .from("services")
    .select("send_out_unit_cost_php, send_out_vendor_id, is_send_out")
    .eq("id", input.service_id)
    .single();

  if (!before?.is_send_out) {
    return { ok: false, error: "Service is not marked as send-out" };
  }

  const { error } = await admin
    .from("services")
    .update({
      send_out_unit_cost_php: input.send_out_unit_cost_php,
      send_out_vendor_id: input.send_out_vendor_id,
    })
    .eq("id", input.service_id);
  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "service.send_out_config_updated",
    resource_type: "services",
    resource_id: input.service_id,
    metadata: {
      before: { cost: before.send_out_unit_cost_php, vendor: before.send_out_vendor_id },
      after: { cost: input.send_out_unit_cost_php, vendor: input.send_out_vendor_id },
    },
  });
  return { ok: true, data: { updated: true } };
}
