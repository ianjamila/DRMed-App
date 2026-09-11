"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";

export type CancelResult =
  | { ok: true; cancelledCount: number }
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
    .select("id, status, patient_id, booking_group_id")
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

  // N11: a multi-service booking (diagnostic package, lab request with
  // several tests…) inserts one appointment row per service, all sharing
  // booking_group_id — the shared booking core's grouping key (see
  // lib/appointments/create.ts). Cancelling "this appointment" from the
  // patient's point of view means cancelling the whole request, not just
  // the lead row they happened to land on. Terminal siblings (already
  // completed/arrived/no-show/cancelled individually by reception) are left
  // alone — only the still-open ones move.
  let idsToCancel = [existing.id];
  if (existing.booking_group_id) {
    const { data: group, error: groupErr } = await admin
      .from("appointments")
      .select("id, status")
      .eq("booking_group_id", existing.booking_group_id);
    if (groupErr) return { ok: false, error: groupErr.message };
    const openIds = (group ?? [])
      .filter((r) => !["cancelled", "completed", "no_show", "arrived"].includes(r.status))
      .map((r) => r.id);
    idsToCancel = openIds.includes(existing.id) ? openIds : [...openIds, existing.id];
  }

  const { data: updated, error } = await admin
    .from("appointments")
    .update({ status: "cancelled" })
    .in("id", idsToCancel)
    .select("id");

  if (error) return { ok: false, error: error.message };

  const cancelledIds = (updated ?? []).map((r) => r.id);
  const cancelledCount = cancelledIds.length;
  const ua = h.get("user-agent");
  await Promise.all(
    cancelledIds.map((id) =>
      audit({
        actor_id: null,
        actor_type: "anonymous",
        patient_id: existing.patient_id,
        action: "appointment.cancelled",
        resource_type: "appointment",
        resource_id: id,
        metadata: {
          source: "public_cancel_link",
          group_appointment_ids: cancelledIds,
          group_cancelled_count: cancelledCount,
        },
        ip_address: ip,
        user_agent: ua,
      }),
    ),
  );

  revalidatePath(`/appointments/cancel/${appointmentId}`);
  return { ok: true, cancelledCount };
}
