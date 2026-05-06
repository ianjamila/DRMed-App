"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

export type ResubscribeResult = { ok: true } | { ok: false; error: string };

export async function resubscribeAction(
  token: string,
): Promise<ResubscribeResult> {
  if (!token || token.length < 8) {
    return { ok: false, error: "Invalid link." };
  }

  const admin = createAdminClient();
  const { data: row, error: lookupErr } = await admin
    .from("subscribers")
    .select("id, unsubscribed_at, email")
    .eq("unsubscribe_token", token)
    .maybeSingle();
  if (lookupErr || !row) {
    return { ok: false, error: "Could not find that subscription." };
  }
  if (row.unsubscribed_at === null) {
    // Already active — nothing to do.
    return { ok: true };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  const { error } = await admin
    .from("subscribers")
    .update({
      unsubscribed_at: null,
      consent_at: new Date().toISOString(),
      consent_ip: ip,
    })
    .eq("id", row.id);
  if (error) return { ok: false, error: error.message };

  await audit({
    actor_id: null,
    actor_type: "anonymous",
    action: "newsletter.resubscribed",
    resource_type: "subscriber",
    resource_id: row.id,
    metadata: { via: "unsubscribe_undo" },
    ip_address: ip,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/unsubscribe`);
  return { ok: true };
}
