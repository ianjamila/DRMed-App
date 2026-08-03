"use server";

/**
 * Sets a visit's attending physician after intake (partner revisions item
 * 23 / audit gap 3).
 *
 * Intake legitimately allows zero-PF procedures with no physician, but the
 * COGS/PF release trigger (P0034, migration 0064) raises for ANY doctor line
 * whose coalesce(test_requests.attending_physician_id, visits.attending_
 * physician_id) is null at release time. Before this action there was no UI
 * anywhere to fix that after the visit was created — this is the fix. A
 * former per-line sibling (setLineAttendingPhysician) was dead code (no
 * caller, no UI) and was removed rather than wired up; test_requests.
 * attending_physician_id and the trigger's COALESCE stay as-is, but note no
 * writer has ever populated that column — the per-line override is schema
 * capacity only, not live data.
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { VisitAttendingSchema } from "@/lib/validations/accounting";

type ActionResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export async function setVisitAttendingPhysician(input: {
  visit_id: string;
  attending_physician_id: string | null;
}): Promise<ActionResult<{ updated: true }>> {
  const session = await requireActiveStaff();
  // Mirrors reissuePatientPinAction's gate — assigning the attending
  // physician is intake data, same lane as issuing the visit's PIN.
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Only reception or admin can set the attending physician." };
  }

  const parsed = VisitAttendingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  // `visits: staff full` (0023) grants UPDATE to every staff role, so the
  // user-scoped client is the right one here — no admin client needed.
  const supabase = await createClient();

  const { data: before } = await supabase
    .from("visits")
    .select("attending_physician_id, deleted_at")
    .eq("id", parsed.data.visit_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Visit not found." };
  if (before.deleted_at !== null) {
    return {
      ok: false,
      error: "This visit was deleted from the queue. Restore it before changing its physician.",
    };
  }

  const { data: updated, error } = await supabase
    .from("visits")
    .update({ attending_physician_id: parsed.data.attending_physician_id })
    .eq("id", parsed.data.visit_id)
    .is("deleted_at", null)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };
  if (!updated || updated.length === 0) {
    revalidatePath(`/staff/visits/${parsed.data.visit_id}`);
    return { ok: false, error: "This visit can no longer be updated." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "visit.attending_physician_updated",
    resource_type: "visit",
    resource_id: parsed.data.visit_id,
    metadata: {
      before: before.attending_physician_id,
      after: parsed.data.attending_physician_id,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/visits/${parsed.data.visit_id}`);
  return { ok: true, data: { updated: true } };
}
