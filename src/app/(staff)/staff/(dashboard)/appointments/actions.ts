"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";

type Transition = "arrived" | "no_show" | "cancelled" | "confirmed";

const ALLOWED_FROM: Record<Transition, string[]> = {
  arrived: ["confirmed"],
  no_show: ["confirmed"],
  cancelled: ["confirmed", "arrived", "pending_callback"],
  // Revert: bounce any non-completed status back to confirmed for
  // accidental presses. Completed stays locked — tied to a real visit.
  confirmed: ["arrived", "no_show", "cancelled", "pending_callback"],
};

export type ApptResult = { ok: true } | { ok: false; error: string };

async function transitionGroup(
  appointmentIds: ReadonlyArray<string>,
  to: Transition,
): Promise<ApptResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Reception or admin only." };
  }
  if (appointmentIds.length === 0) {
    return { ok: false, error: "No appointments to update." };
  }

  const supabase = await createClient();
  const allowed = ALLOWED_FROM[to];
  const { data, error } = await supabase
    .from("appointments")
    .update({ status: to })
    .in("id", [...appointmentIds])
    .in("status", allowed)
    .select("id, patient_id");

  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: `Appointment is not in a state we can mark "${to.replace(/_/g, " ")}".`,
    };
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  // One audit row per appointment so the trail per-row stays grep-able,
  // but include the booking-group siblings in metadata so the group is
  // reconstructable.
  await Promise.all(
    data.map((row) =>
      audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: row.patient_id,
        action: `appointment.${to}`,
        resource_type: "appointment",
        resource_id: row.id,
        metadata: {
          actor_role: session.role,
          group_appointment_ids: data.map((r) => r.id),
        },
        ip_address: ip,
        user_agent: ua,
      }),
    ),
  );

  revalidatePath("/staff/appointments");
  return { ok: true };
}

export async function markArrivedAction(
  ids: ReadonlyArray<string>,
): Promise<ApptResult> {
  return transitionGroup(ids, "arrived");
}

export async function markNoShowAction(
  ids: ReadonlyArray<string>,
): Promise<ApptResult> {
  return transitionGroup(ids, "no_show");
}

export async function cancelByStaffAction(
  ids: ReadonlyArray<string>,
): Promise<ApptResult> {
  return transitionGroup(ids, "cancelled");
}

export async function revertToConfirmedAction(
  ids: ReadonlyArray<string>,
): Promise<ApptResult> {
  return transitionGroup(ids, "confirmed");
}

export async function deleteAppointmentAction(
  appointmentIds: ReadonlyArray<string>,
): Promise<ApptResult> {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    return { ok: false, error: "Admin only." };
  }
  if (appointmentIds.length === 0) {
    return { ok: false, error: "No appointments to delete." };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("appointments")
    .select("id, patient_id, status, scheduled_at")
    .in("id", [...appointmentIds]);
  if (!existing || existing.length === 0) {
    return { ok: false, error: "No matching appointments." };
  }

  const { error } = await supabase
    .from("appointments")
    .delete()
    .in("id", [...appointmentIds]);
  if (error) return { ok: false, error: error.message };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  await Promise.all(
    existing.map((row) =>
      audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: row.patient_id,
        action: "appointment.deleted",
        resource_type: "appointment",
        resource_id: row.id,
        metadata: {
          previous_status: row.status,
          scheduled_at: row.scheduled_at,
          group_appointment_ids: existing.map((r) => r.id),
        },
        ip_address: ip,
        user_agent: ua,
      }),
    ),
  );

  revalidatePath("/staff/appointments");
  return { ok: true };
}
