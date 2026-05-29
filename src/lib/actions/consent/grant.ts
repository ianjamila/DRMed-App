"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { CURRENT_CONSENT_NOTICE_VERSION } from "@/lib/consent/notice";

const Schema = z
  .object({
    patientId: z.string().uuid(),
    method: z.enum(["paper_wet_signature", "onscreen_signature"]),
    signatory: z.enum(["self", "guardian", "representative"]),
    signatoryName: z.string().trim().min(1).optional(),
    signatoryRelationship: z.string().trim().min(1).optional(),
    artifactPath: z.string().trim().min(1).optional(),
  })
  .refine(
    (d) =>
      d.signatory === "self" ||
      (!!d.signatoryName && !!d.signatoryRelationship),
    {
      message: "Guardian/representative name and relationship are required.",
      path: ["signatoryName"],
    },
  );

export type ConsentActionResult = { ok: true } | { ok: false; error: string };

export async function recordConsentGrantAction(
  raw: z.input<typeof Schema>,
): Promise<ConsentActionResult> {
  const session = await requireActiveStaff();
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const d = parsed.data;

  const admin = createAdminClient();
  const { ip, ua } = await ipAndAgent();

  const { error } = await admin.from("patient_consents").insert({
    patient_id: d.patientId,
    event_type: "granted",
    method: d.method,
    notice_version: CURRENT_CONSENT_NOTICE_VERSION,
    signatory: d.signatory,
    signatory_name: d.signatoryName ?? null,
    signatory_relationship: d.signatoryRelationship ?? null,
    artifact_path: d.artifactPath ?? null,
    actor_kind: "staff",
    created_by: session.user_id,
    ip,
    user_agent: ua,
  });
  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: d.patientId,
    action: "consent.granted",
    resource_type: "patient",
    resource_id: d.patientId,
    metadata: {
      method: d.method,
      notice_version: CURRENT_CONSENT_NOTICE_VERSION,
      signatory: d.signatory,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/patients/${d.patientId}`);
  return { ok: true };
}
