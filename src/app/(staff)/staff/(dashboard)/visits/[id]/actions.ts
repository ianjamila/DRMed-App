"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { notifyResultReleased } from "@/lib/notifications/notify-released";

export type ReleaseMedium =
  | "physical"
  | "email"
  | "viber"
  | "gcash"
  | "pickup"
  | "other";

export type ReleaseResult =
  | { ok: true }
  | { ok: false; error: string };

const VALID_MEDIA: readonly ReleaseMedium[] = [
  "physical",
  "email",
  "viber",
  "gcash",
  "pickup",
  "other",
];

export async function releaseTestAction(
  testRequestId: string,
  visitId: string,
  releaseMedium: ReleaseMedium,
): Promise<ReleaseResult> {
  if (!VALID_MEDIA.includes(releaseMedium)) {
    return { ok: false, error: "Invalid release medium." };
  }
  const session = await requireActiveStaff();
  const supabase = await createClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
      release_medium: releaseMedium,
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
    metadata: { visit_id: visitId, release_medium: releaseMedium },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  // Fire-and-forget notification. Failures are audit-logged inside, never
  // bubble up — release is the source of truth.
  try {
    await notifyResultReleased({ testRequestId, visitId });
  } catch (err) {
    console.error("notifyResultReleased threw", err);
  }

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
}
