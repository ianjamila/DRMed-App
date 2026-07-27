"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { requireActiveStaff } from "@/lib/auth/require-staff";

// PIN re-issue moved to src/lib/actions/visits/reissue-pin.ts — the visit page
// calls it too (consultation-only visits print no receipt to carry the PIN).

export type VerifyIdentityResult = { ok: true } | { ok: false; error: string };

// M5: explicit counterpart of the visit-created auto-clear — reception checks
// the patient's ID at the counter and marks the pre-registration verified
// without needing a visit. No-op (still ok) if the flag is already clear.
export async function verifyPatientIdentityAction(
  patientId: string,
): Promise<VerifyIdentityResult> {
  const session = await requireActiveStaff();

  const admin = createAdminClient();
  const { data: cleared, error } = await admin
    .from("patients")
    .update({ pre_registered: false })
    .eq("id", patientId)
    .eq("pre_registered", true)
    .select("id");
  if (error) return { ok: false, error: error.message };

  if (cleared && cleared.length > 0) {
    const { ip, ua } = await ipAndAgent();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: patientId,
      action: "patient.identity_verified",
      resource_type: "patient",
      resource_id: patientId,
      metadata: { via: "manual" },
      ip_address: ip,
      user_agent: ua,
    });
  }

  return { ok: true };
}
