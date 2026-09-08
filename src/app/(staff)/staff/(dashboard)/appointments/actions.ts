"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";

type Transition =
  | "arrived"
  | "no_show"
  | "cancelled"
  | "confirmed"
  | "completed";

const ALLOWED_FROM: Record<Transition, string[]> = {
  arrived: ["confirmed"],
  no_show: ["confirmed"],
  cancelled: ["confirmed", "arrived", "pending_callback"],
  // Revert: bounce any non-completed status back to confirmed for
  // accidental presses.
  confirmed: ["arrived", "no_show", "cancelled", "pending_callback"],
  // Reached only via completeAppointmentFromVisitAction below, fired when
  // reception starts a visit from this appointment (see
  // visits/new/actions.ts) — never through a manual button, so an
  // "arrived" appointment left untouched just stays arrived.
  completed: ["arrived"],
};

export type ApptResult = { ok: true } | { ok: false; error: string };

async function transitionGroup(
  appointmentIds: ReadonlyArray<string>,
  to: Transition,
  extraMetadata?: Record<string, unknown>,
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
          ...extraMetadata,
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

// Completes the appointment(s) a visit was started from. Called from
// visits/new/actions.ts right after a visit is created — never from a
// manual button. The caller treats any {ok:false} result or thrown error as
// non-fatal: the visit already exists by the time this runs, so reception
// must never see it fail or lose the visit over it.
//
// `leadAppointmentId` is the group lead the "+ Start visit" link carried.
// When it belongs to a multi-service booking (non-null booking_group_id),
// every sibling row is resolved and completed together; otherwise just the
// lead row moves. Reusing transitionGroup means the reception/admin role
// gate, the `.in("status", allowed)` guard (only "arrived" appointments
// move — see ALLOWED_FROM), and the per-row `appointment.completed` audit
// rows all come for free.
//
// Every export of a "use server" file is a callable endpoint whether or not
// any client code references it, so this cannot assume its arguments came
// from createVisitAction. It therefore proves the pairing itself: the visit
// must exist, be live, and belong to the same patient as the appointment.
// Without that check any reception session could complete an unrelated
// patient's appointment and stamp the audit row with a visit id that never
// existed — precisely the "tied to a real visit" invariant this transition
// is supposed to uphold.
export async function completeAppointmentFromVisitAction(
  leadAppointmentId: string,
  visitId: string,
  // A split doctor/lab order creates two visits sharing one group id.
  // `visitId` is the first of them, so carry the group id as well or the
  // trail would only ever name half of what the appointment produced.
  visitGroupId: string | null = null,
): Promise<ApptResult> {
  const supabase = await createClient();
  const { data: lead, error: leadErr } = await supabase
    .from("appointments")
    .select("id, booking_group_id, patient_id")
    .eq("id", leadAppointmentId)
    .maybeSingle();
  if (leadErr || !lead) {
    return { ok: false, error: "Appointment not found." };
  }

  const { data: visit, error: visitErr } = await supabase
    .from("visits")
    .select("id, patient_id")
    .eq("id", visitId)
    .is("deleted_at", null)
    .maybeSingle();
  if (visitErr || !visit) {
    return { ok: false, error: "Visit not found." };
  }
  if (!lead.patient_id || lead.patient_id !== visit.patient_id) {
    return {
      ok: false,
      error: "That appointment belongs to a different patient.",
    };
  }

  let ids: ReadonlyArray<string> = [lead.id];
  if (lead.booking_group_id) {
    const { data: siblings, error: sibErr } = await supabase
      .from("appointments")
      .select("id")
      .eq("booking_group_id", lead.booking_group_id);
    if (sibErr) return { ok: false, error: sibErr.message };
    if (siblings && siblings.length > 0) ids = siblings.map((r) => r.id);
  }

  return transitionGroup(ids, "completed", {
    via: "visit_created",
    visit_id: visitId,
    visit_group_id: visitGroupId,
  });
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
