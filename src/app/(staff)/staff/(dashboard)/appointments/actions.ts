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
  cancelled: ["confirmed", "arrived"],
  // Revert path: bounce any non-completed status back to confirmed for
  // accidental presses. Completed visits stay locked — those are tied to
  // a real visit + payment record, can't be reset on a click.
  confirmed: ["arrived", "no_show", "cancelled"],
};

export type ApptResult = { ok: true } | { ok: false; error: string };

async function transitionAction(
  appointmentId: string,
  to: Transition,
): Promise<ApptResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Reception or admin only." };
  }

  const supabase = await createClient();
  const allowed = ALLOWED_FROM[to];
  const { data, error } = await supabase
    .from("appointments")
    .update({ status: to })
    .eq("id", appointmentId)
    .in("status", allowed)
    .select("id, patient_id")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) {
    return {
      ok: false,
      error: `Appointment is not in a state we can mark "${to.replace(/_/g, " ")}".`,
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: data.patient_id,
    action: `appointment.${to}`,
    resource_type: "appointment",
    resource_id: appointmentId,
    metadata: { actor_role: session.role },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/appointments");
  return { ok: true };
}

export async function markArrivedAction(id: string): Promise<ApptResult> {
  return transitionAction(id, "arrived");
}

export async function markNoShowAction(id: string): Promise<ApptResult> {
  return transitionAction(id, "no_show");
}

export async function cancelByStaffAction(id: string): Promise<ApptResult> {
  return transitionAction(id, "cancelled");
}

export async function revertToConfirmedAction(
  id: string,
): Promise<ApptResult> {
  return transitionAction(id, "confirmed");
}

export async function deleteAppointmentAction(
  appointmentId: string,
): Promise<ApptResult> {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    return { ok: false, error: "Admin only." };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("appointments")
    .select("id, patient_id, status, scheduled_at")
    .eq("id", appointmentId)
    .maybeSingle();
  if (!existing) {
    return { ok: false, error: "Appointment not found." };
  }

  const { error } = await supabase
    .from("appointments")
    .delete()
    .eq("id", appointmentId);
  if (error) return { ok: false, error: error.message };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: existing.patient_id,
    action: "appointment.deleted",
    resource_type: "appointment",
    resource_id: appointmentId,
    metadata: {
      previous_status: existing.status,
      scheduled_at: existing.scheduled_at,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/appointments");
  return { ok: true };
}
