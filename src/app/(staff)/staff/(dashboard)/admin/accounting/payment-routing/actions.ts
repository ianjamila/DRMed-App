"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { UpdatePaymentMethodMapSchema } from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";

export type PaymentRoutingResult = { ok: true } | { ok: false; error: string };

export async function updatePaymentMethodMapAction(
  mapId: string,
  accountId: string,
  notes: string | null,
): Promise<PaymentRoutingResult> {
  const session = await requireAdminStaff();

  const parsed = UpdatePaymentMethodMapSchema.safeParse({ account_id: accountId, notes });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const admin = createAdminClient();

  const { data: before } = await admin
    .from("payment_method_account_map")
    .select("payment_method, account_id, notes")
    .eq("id", mapId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Mapping not found." };

  const { error } = await admin
    .from("payment_method_account_map")
    .update({
      account_id: parsed.data.account_id,
      notes: parsed.data.notes ?? null,
    })
    .eq("id", mapId);
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payment_method_map.updated",
    resource_type: "payment_method_account_map",
    resource_id: mapId,
    metadata: { before, after: parsed.data },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/accounting/payment-routing");
  return { ok: true };
}
