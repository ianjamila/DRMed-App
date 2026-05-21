"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";

export type ResubscribeResult =
  | { ok: true }
  | { ok: false; error: string; retryAfterSec?: number };

export async function resubscribeAction(
  token: string,
): Promise<ResubscribeResult> {
  if (!token || token.length < 8) {
    return { ok: false, error: "Invalid link." };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  if (ip) {
    const limit = await checkRateLimit({
      bucket: "newsletter_resubscribe",
      identifier: ip,
      ...RATE_LIMITS.newsletter_resubscribe,
    });
    if (!limit.allowed) {
      return {
        ok: false,
        error: "Too many requests. Try again in a minute.",
        retryAfterSec: limit.retryAfterSec,
      };
    }
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
