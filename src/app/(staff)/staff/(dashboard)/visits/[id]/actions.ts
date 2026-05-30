"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { notifyResultReleased } from "@/lib/notifications/notify-released";
import { translatePgError } from "@/lib/accounting/pg-errors";

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
    // The payment-gating and consent-gating triggers raise check_violation
    // (23514). translatePgError turns both into friendly, gate-specific text.
    return { ok: false, error: translatePgError(error) };
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

export async function markConsultationDoneAction(
  testRequestId: string,
  visitId: string,
): Promise<ReleaseResult> {
  const session = await requireActiveStaff();
  const supabase = await createClient();

  // This action is only for consultation lines — releasing fires PF accrual.
  // Guard server-side so a future/mis-wired caller can't release another kind.
  const { data: tr } = await supabase
    .from("test_requests")
    .select("services ( kind )")
    .eq("id", testRequestId)
    .eq("visit_id", visitId)
    .maybeSingle();
  const svc = Array.isArray(tr?.services) ? tr?.services[0] : tr?.services;
  if (!tr || svc?.kind !== "doctor_consultation") {
    return { ok: false, error: "This action is only for consultations." };
  }

  const now = new Date().toISOString();

  const { error } = await supabase
    .from("test_requests")
    .update({
      status: "released",
      released_at: now,
      released_by: session.user_id,
      release_medium: "other",
    })
    .eq("id", testRequestId)
    .eq("visit_id", visitId);

  if (error) {
    // Payment gate (visit not paid) or P0034 (consult has no attending
    // physician) → friendly text.
    return { ok: false, error: translatePgError(error) };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "consultation.completed",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: { visit_id: visitId },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/visits/${visitId}`);
  return { ok: true };
}
