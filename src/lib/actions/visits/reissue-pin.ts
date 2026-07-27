"use server";

/**
 * Re-issue a patient's one-time portal Secure PIN.
 *
 * Two callers, same action:
 *  - the patient page ("Re-issue PIN") — targets the patient's latest visit,
 *    for the everyday "they lost the slip" case;
 *  - a consultation-only visit page ("Issue portal PIN") — targets THAT visit
 *    explicitly. Consultation-only visits print no receipt (partner revisions
 *    item 1 / decision 4), so their PIN is never handed out at the counter;
 *    this is the deliberate path for the patient who later needs portal
 *    access anyway. The receipt route then renders a PIN-only slip.
 *
 * Lives under src/lib/actions like queue-deletion — shared by two route
 * folders, so it belongs to neither.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { generatePin, hashPin } from "@/lib/auth/pin";
import { setVisitPinFlash } from "@/lib/auth/visit-pin-flash";

export type ReissueResult = { ok: false; error: string };

export async function reissuePatientPinAction(
  patientId: string,
  /** Target a specific visit instead of the patient's latest. */
  visitId?: string,
): Promise<ReissueResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Only reception or admin can re-issue PINs." };
  }

  const admin = createAdminClient();

  // The patient_id filter stands even when a visit is named — it stops a
  // caller re-pointing the action at another patient's visit.
  let query = admin
    .from("visits")
    .select("id, visit_number")
    .eq("patient_id", patientId)
    // Don't hang a re-issued PIN off a queue-deleted visit (0125).
    .is("deleted_at", null);
  if (visitId) query = query.eq("id", visitId);

  const { data: latestVisit, error: visitErr } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (visitErr) return { ok: false, error: visitErr.message };
  if (!latestVisit) {
    return {
      ok: false,
      error: visitId
        ? "That visit is no longer available — it may have been deleted from the queue."
        : "No visit on record yet. Create a visit first — that issues a fresh PIN automatically.",
    };
  }

  const plainPin = generatePin();
  const pinHash = await hashPin(plainPin);
  const newExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();

  const { error: updateErr } = await admin
    .from("visit_pins")
    .update({
      pin_hash: pinHash,
      failed_attempts: 0,
      locked_until: null,
      last_used_at: null,
      expires_at: newExpiresAt,
    })
    .eq("visit_id", latestVisit.id);

  if (updateErr) return { ok: false, error: updateErr.message };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: patientId,
    action: "visit_pin.reissued",
    resource_type: "visit",
    resource_id: latestVisit.id,
    metadata: {
      visit_number: latestVisit.visit_number,
      reason: "manual_reissue",
      target: visitId ? "named_visit" : "latest_visit",
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  await setVisitPinFlash({ visit_id: latestVisit.id, pin: plainPin });
  redirect(`/staff/visits/${latestVisit.id}/receipt`);
}
