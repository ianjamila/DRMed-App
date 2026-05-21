"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";

export type CancelResult =
  | { ok: true }
  | { ok: false; error: string; retryAfterSec?: number };

// Public cancel — anyone holding the appointment id (UUID) from the
// confirmation email/SMS can flip status to cancelled. We refuse if the
// appointment is in a terminal state already (cancelled, completed,
// no_show) so the URL can't be reused to re-cancel.
export async function cancelAppointmentAction(
  appointmentId: string,
): Promise<CancelResult> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  if (ip) {
    const limit = await checkRateLimit({
      bucket: "appointment_cancel",
      identifier: ip,
      ...RATE_LIMITS.appointment_cancel,
    });
    if (!limit.allowed) {
      return {
        ok: false,
        error: "Too many requests. Try again in a minute.",
        retryAfterSec: limit.retryAfterSec,
      };
    }
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("appointments")
    .select("id, status, patient_id")
    .eq("id", appointmentId)
    .maybeSingle();

  if (!existing) return { ok: false, error: "Appointment not found." };
  if (existing.status === "cancelled") {
    return { ok: false, error: "This appointment is already cancelled." };
  }
  if (
    existing.status === "completed" ||
    existing.status === "no_show" ||
    existing.status === "arrived"
  ) {
    return {
      ok: false,
      error:
        "This appointment can no longer be cancelled online. Please call us.",
    };
  }

  const { error } = await admin
    .from("appointments")
    .update({ status: "cancelled" })
    .eq("id", appointmentId);

  if (error) return { ok: false, error: error.message };

  await audit({
    actor_id: null,
    actor_type: "anonymous",
    patient_id: existing.patient_id,
    action: "appointment.cancelled",
    resource_type: "appointment",
    resource_id: appointmentId,
    metadata: { source: "public_cancel_link" },
    ip_address: ip,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/appointments/cancel/${appointmentId}`);
  return { ok: true };
}
