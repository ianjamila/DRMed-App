"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";

export type CancelResult = { ok: true } | { ok: false; error: string };

// Public cancel — anyone holding the appointment id (UUID) from the
// confirmation email/SMS can flip status to cancelled. We refuse if the
// appointment is in a terminal state already (cancelled, completed,
// no_show) so the URL can't be reused to re-cancel.
export async function cancelAppointmentAction(
  appointmentId: string,
): Promise<CancelResult> {
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

  const h = await headers();
  await audit({
    actor_id: null,
    actor_type: "anonymous",
    patient_id: existing.patient_id,
    action: "appointment.cancelled",
    resource_type: "appointment",
    resource_id: appointmentId,
    metadata: { source: "public_cancel_link" },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/appointments/cancel/${appointmentId}`);
  return { ok: true };
}
