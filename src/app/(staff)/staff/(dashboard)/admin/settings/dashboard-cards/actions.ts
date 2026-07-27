"use server";

import { revalidatePath } from "next/cache";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import {
  DASHBOARD_CARDS,
  ALL_ROLES,
  matchesCardDefault,
  type DashboardRole,
} from "@/lib/dashboards/cards";

interface ActionResult {
  ok: boolean;
  error?: string;
}

// Toggle visibility for one (role, card_id). The table stores genuine
// overrides only: when the requested state already matches the card's own
// default the row is deleted, otherwise it's upserted. For an ordinary card
// that reproduces the old "absence means visible" behaviour; for a
// `defaultHidden` card it means absence reads as hidden and turning it on
// stores an explicit visible=true.
export async function setCardVisibility(
  role: DashboardRole,
  cardId: string,
  visible: boolean,
): Promise<ActionResult> {
  const session = await requireAdminStaff();

  if (!ALL_ROLES.includes(role)) {
    return { ok: false, error: "Invalid role." };
  }
  const card = DASHBOARD_CARDS.find((c) => c.id === cardId);
  if (!card) {
    return { ok: false, error: "Unknown card id." };
  }

  const admin = createAdminClient();

  if (matchesCardDefault(card, visible)) {
    const { error } = await admin
      .from("dashboard_card_prefs")
      .delete()
      .eq("role", role)
      .eq("card_id", cardId);
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await admin.from("dashboard_card_prefs").upsert(
      {
        role,
        card_id: cardId,
        visible,
        updated_by: session.user_id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "role,card_id" },
    );
    if (error) return { ok: false, error: error.message };
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
