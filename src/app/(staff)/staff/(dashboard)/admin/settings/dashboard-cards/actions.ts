"use server";

import { revalidatePath } from "next/cache";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { DASHBOARD_CARDS, ALL_ROLES, type DashboardRole } from "@/lib/dashboards/cards";

interface ActionResult {
  ok: boolean;
  error?: string;
}

// Toggle visibility for one (role, card_id). Persists via upsert.
// If visible=true (the default), the row is deleted so the absence-means-visible
// invariant holds — keeps the table small.
export async function setCardVisibility(
  role: DashboardRole,
  cardId: string,
  visible: boolean,
): Promise<ActionResult> {
  const session = await requireAdminStaff();

  if (!ALL_ROLES.includes(role)) {
    return { ok: false, error: "Invalid role." };
  }
  if (!DASHBOARD_CARDS.find((c) => c.id === cardId)) {
    return { ok: false, error: "Unknown card id." };
  }

  const admin = createAdminClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = admin as any;

  if (visible) {
    const { error } = (await client
      .from("dashboard_card_prefs")
      .delete()
      .eq("role", role)
      .eq("card_id", cardId)) as { error: { message?: string } | null };
    if (error) return { ok: false, error: error.message ?? "Delete failed." };
  } else {
    const { error } = (await client.from("dashboard_card_prefs").upsert(
      {
        role,
        card_id: cardId,
        visible: false,
        updated_by: session.user_id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "role,card_id" },
    )) as { error: { message?: string } | null };
    if (error) return { ok: false, error: error.message ?? "Upsert failed." };
  }

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: visible ? "dashboard_card.shown" : "dashboard_card.hidden",
    resource_type: "dashboard_card_prefs",
    resource_id: `${role}:${cardId}`,
    metadata: { role, card_id: cardId, visible },
  });

  revalidatePath("/staff");
  revalidatePath("/staff/admin/settings/dashboard-cards");
  return { ok: true };
}
