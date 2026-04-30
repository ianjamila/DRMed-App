"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { generatePin, hashPin } from "@/lib/auth/pin";
import { setVisitPinFlash } from "@/lib/auth/visit-pin-flash";

export type ReissueResult = { ok: false; error: string };

// Generates a fresh Secure PIN for the patient's latest visit and stashes
// the plain value in the receipt flash. Redirects to that visit's receipt
// page so reception can print and hand it over. Reception or admin only.
export async function reissuePatientPinAction(
  patientId: string,
): Promise<ReissueResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Only reception or admin can re-issue PINs." };
  }

  const admin = createAdminClient();

  const { data: latestVisit, error: visitErr } = await admin
    .from("visits")
    .select("id, visit_number")
    .eq("patient_id", patientId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (visitErr) return { ok: false, error: visitErr.message };
  if (!latestVisit) {
    return {
      ok: false,
      error: "No visit on record yet. Create a visit first — that issues a fresh PIN automatically.",
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
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  await setVisitPinFlash({ visit_id: latestVisit.id, pin: plainPin });
  redirect(`/staff/visits/${latestVisit.id}/receipt`);
}
