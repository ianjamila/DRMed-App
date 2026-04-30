"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";

export type ReleaseResult =
  | { ok: true }
  | { ok: false; error: string };

export async function releaseTestAction(
  testRequestId: string,
  visitId: string,
): Promise<ReleaseResult> {
  const session = await requireActiveStaff();
  const supabase = await createClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
    })
    .eq("id", testRequestId)
    .eq("visit_id", visitId);

  if (error) {
    // The payment-gating trigger raises check_violation when the visit isn't paid.
    return { ok: false, error: error.message };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "test_request.released",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: { visit_id: visitId },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
}
