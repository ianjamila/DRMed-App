"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";
import { CURRENT_CONSENT_NOTICE_VERSION } from "@/lib/consent/notice";

const Schema = z.object({
  signatory: z.enum(["self", "guardian", "representative"]).default("self"),
  signatoryName: z.string().trim().min(1).optional(),
  signatoryRelationship: z.string().trim().min(1).optional(),
});

export type ConsentActionResult = { ok: true } | { ok: false; error: string };

export async function acceptConsentPortalAction(
  raw: z.input<typeof Schema>,
): Promise<ConsentActionResult> {
  const session = await getPatientSession();
  if (!session) return { ok: false, error: "Session expired. Sign in again." };
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const d = parsed.data;
  if (
    d.signatory !== "self" &&
    (!d.signatoryName || !d.signatoryRelationship)
  ) {
    return {
      ok: false,
      error: "Guardian/representative name and relationship are required.",
    };
  }

  const admin = createAdminClient();
  const { ip, ua } = await ipAndAgent();

  const { error } = await admin.from("patient_consents").insert({
    patient_id: session.patient_id,
    event_type: "granted",
    method: "portal_acceptance",
    notice_version: CURRENT_CONSENT_NOTICE_VERSION,
    signatory: d.signatory,
    signatory_name: d.signatoryName ?? null,
    signatory_relationship: d.signatoryRelationship ?? null,
    actor_kind: "patient",
    ip,
    user_agent: ua,
  });
  if (error) return { ok: false, error: "Could not record your consent. Try again." };

  await audit({
    actor_id: null,
    actor_type: "patient",
    patient_id: session.patient_id,
    action: "consent.granted",
    resource_type: "patient",
    resource_id: session.patient_id,
    metadata: {
      method: "portal_acceptance",
      notice_version: CURRENT_CONSENT_NOTICE_VERSION,
      signatory: d.signatory,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath("/portal", "layout");
  return { ok: true };
}
