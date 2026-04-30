"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";

export type ClaimResult = { ok: true } | { ok: false; error: string };

export async function claimTestAction(
  testRequestId: string,
): Promise<ClaimResult> {
  const session = await requireActiveStaff();
  const supabase = await createClient();

  // Only claim if currently 'requested' — concurrency-safe.
  const { data, error } = await supabase
    .from("test_requests")
    .update({
      status: "in_progress",
      assigned_to: session.user_id,
      started_at: new Date().toISOString(),
    })
    .eq("id", testRequestId)
    .eq("status", "requested")
    .select("id, visit_id")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) {
    return {
      ok: false,
      error: "This test was already claimed or its status changed.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "test_request.claimed",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: { visit_id: data.visit_id },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/queue");
  revalidatePath(`/staff/queue/${testRequestId}`);
  return { ok: true };
}
