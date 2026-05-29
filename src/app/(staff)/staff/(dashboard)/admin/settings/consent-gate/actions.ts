"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

interface ActionResult {
  ok: boolean;
  error?: string;
}

// Flip the RA 10173 consent release-gate on/off. When ON, the DB trigger
// enforce_consent_before_release() blocks any test_request transition to
// 'released' unless the patient has current consent on file. Admin-only.
export async function setConsentGateRequiredAction(
  enabled: boolean,
): Promise<ActionResult> {
  const session = await requireAdminStaff();

  const admin = createAdminClient();
  const { error } = await admin
    .from("consent_settings")
    .update({ gate_required: enabled, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) return { ok: false, error: error.message };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: enabled ? "consent_gate.enabled" : "consent_gate.disabled",
    resource_type: "consent_settings",
    // consent_settings is a global singleton (no per-row UUID); audit_log.
    // resource_id is a uuid column, so leave it null and capture the change
    // in metadata.
    resource_id: null,
    metadata: { gate_required: enabled },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/settings/consent-gate");
  return { ok: true };
}
