"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { SubscribeSchema } from "@/lib/validations/newsletter";

export type SubscribeResult =
  | { ok: true; alreadyActive: boolean }
  | { ok: false; error: string };

export async function subscribeAction(
  _prev: SubscribeResult | null,
  formData: FormData,
): Promise<SubscribeResult> {
  // Honeypot — silent drop if filled.
  if ((formData.get("website") ?? "") !== "") {
    return { ok: true, alreadyActive: false };
  }

  const parsed = SubscribeSchema.safeParse({
    email: formData.get("email"),
    source: formData.get("source"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const h = await headers();
  const ipAddress = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = h.get("user-agent");

  const admin = createAdminClient();

  // Idempotent: re-submitting the same email refreshes consent and clears
  // any prior unsubscribed_at, restoring active status. The unsubscribe
  // token stays stable across re-subscriptions so a previously-issued
  // link still works.
  const { data: existing } = await admin
    .from("subscribers")
    .select("id, unsubscribed_at")
    .eq("email", parsed.data.email)
    .maybeSingle();

  if (existing) {
    const wasActive = existing.unsubscribed_at === null;
    const { error } = await admin
      .from("subscribers")
      .update({
        unsubscribed_at: null,
        consent_at: new Date().toISOString(),
        consent_ip: ipAddress,
        source: parsed.data.source,
      })
      .eq("id", existing.id);
    if (error) {
      console.error("subscribers update failed", error);
      return { ok: false, error: "Could not save your subscription." };
    }
    if (!wasActive) {
      await audit({
        actor_id: null,
        actor_type: "anonymous",
        action: "newsletter.resubscribed",
        resource_type: "subscriber",
        resource_id: existing.id,
        metadata: { source: parsed.data.source },
        ip_address: ipAddress,
        user_agent: userAgent,
      });
    }
    return { ok: true, alreadyActive: wasActive };
  }

  const { data: created, error } = await admin
    .from("subscribers")
    .insert({
      email: parsed.data.email,
      source: parsed.data.source,
      consent_ip: ipAddress,
    })
    .select("id")
    .single();
  if (error || !created) {
    console.error("subscribers insert failed", error);
    return { ok: false, error: "Could not save your subscription." };
  }

  await audit({
    actor_id: null,
    actor_type: "anonymous",
    action: "newsletter.subscribed",
    resource_type: "subscriber",
    resource_id: created.id,
    metadata: { source: parsed.data.source },
    ip_address: ipAddress,
    user_agent: userAgent,
  });

  return { ok: true, alreadyActive: false };
}
