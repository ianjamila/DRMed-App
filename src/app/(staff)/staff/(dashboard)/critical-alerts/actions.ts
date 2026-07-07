"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { translatePgError } from "@/lib/accounting/pg-errors";

export type AcknowledgeResult = { ok: true } | { ok: false; error: string };

export async function acknowledgeCriticalAlertAction(
  alertId: string,
): Promise<AcknowledgeResult> {
  const session = await requireActiveStaff();
  if (session.role !== "pathologist" && session.role !== "admin") {
    return {
      ok: false,
      error: "Only pathologists and admins can acknowledge critical alerts.",
    };
  }
  const supabase = await createClient();

  // Pre-read for the audit metadata (test request + parameter).
  const { data: alert } = await supabase
    .from("critical_alerts")
    .select("id, test_request_id, parameter_name")
    .eq("id", alertId)
    .maybeSingle();
  if (!alert) {
    return { ok: false, error: "Alert not found." };
  }

  // Only an unacknowledged alert can be acknowledged — concurrency-safe.
  const { data, error } = await supabase
    .from("critical_alerts")
    .update({
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: session.user_id,
    })
    .eq("id", alertId)
    .is("acknowledged_at", null)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, error: translatePgError(error) };
  if (!data) {
    return {
      ok: false,
      error: "This alert was already acknowledged by someone else.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "critical_alert.acknowledged",
    resource_type: "critical_alert",
    resource_id: alertId,
    metadata: {
      test_request_id: alert.test_request_id,
      parameter_name: alert.parameter_name,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/critical-alerts");
  revalidatePath("/staff");
  return { ok: true };
}
