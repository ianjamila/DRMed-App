"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import type { ConsentActionResult } from "./grant";

const Schema = z.object({
  patientId: z.string().uuid(),
  reason: z
    .string()
    .trim()
    .min(3, "Give a brief reason for the withdrawal."),
});

export async function withdrawConsentAction(
  raw: z.input<typeof Schema>,
): Promise<ConsentActionResult> {
  const session = await requireAdminStaff();
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const d = parsed.data;

  const admin = createAdminClient();
  const { ip, ua } = await ipAndAgent();

  const { error } = await admin.from("patient_consents").insert({
    patient_id: d.patientId,
    event_type: "withdrawn",
    actor_kind: "staff",
    created_by: session.user_id,
    reason: d.reason,
    ip,
    user_agent: ua,
  });
  if (error) return { ok: false, error: translatePgError(error) };

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: d.patientId,
    action: "consent.withdrawn",
    resource_type: "patient",
    resource_id: d.patientId,
    metadata: { reason: d.reason },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(`/staff/patients/${d.patientId}`);
  return { ok: true };
}
