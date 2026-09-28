"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { resolvePatient } from "@/lib/patients/resolve";
import { activePatients } from "@/lib/patients/active";
import { assertAppointmentsPatientsActive } from "@/lib/patients/require-active";
import { AttachPatientSchema, type AttachPatientInput } from "@/lib/appointments/attach-patient";
import { matchArrivedAppointmentsForServices } from "@/lib/appointments/match-arrived";
import {
  BulkBookingIdsSchema,
  STALE_UNTIMED_AFTER_DAYS,
  staleCutoffIso,
  splitBookingsByActivePatient,
  type BulkBookingIds,
} from "@/lib/appointments/stale";
import { todayManilaISODate } from "@/lib/dates/manila";

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

  // Moving to arrived or back to confirmed puts work back on the record;
  // cancelling or marking no-show does not, so those stay unguarded.
  // Walk-in appointments (patient_id NULL) pass.
  if (to === "arrived" || to === "confirmed") {
    const active = await assertAppointmentsPatientsActive(createAdminClient(), [...appointmentIds]);
    if (!active.ok) return { ok: false, error: active.error };
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

// A9 part 2 / Finding 9: completeAppointmentFromVisitAction above only fires
// when the visit was started via the appointment's own "+ Start visit" link
// (it carries appointment_id). Reception's documented workaround for a
// walk-in that vanished from every section (the bug this batch fixes) was to
// start the visit straight from the patient's page instead — a path that
// never threads an appointment_id, so the appointment used to dangle at
// "arrived" forever even after the visit existed. This is the same
// completion mechanism (transitionGroup, same ALLOWED_FROM.completed =
// ["arrived"] guard, same per-row audit trail) reached by patient_id instead
// of a lead appointment id, so any visit-creation path — not just the
// appointment list's own link — can close out a dangling arrived
// appointment.
//
// Finding 9 fix: the original version completed EVERY arrived appointment
// for the patient regardless of which services the new visit covers, and
// never proved `visitId` actually belonged to `patientId` (unlike its
// sibling above, which re-proves the pairing because — same reasoning as
// there — every export of a "use server" file is a callable endpoint
// whether or not any client code references it). A patient arrived for both
// a separate lab visit and a doctor consultation would have BOTH
// appointments swept by creating just the lab visit, silently dropping the
// consultation from the queue while the patient was still waiting for it.
// Now: (1) the visit is fetched and its patient_id checked against
// `patientId` before anything is touched, exactly like
// completeAppointmentFromVisitAction; (2) only arrived appointments whose
// own `service_id` is one of `serviceIds` (the services THIS visit was
// actually created for) are completed — see
// `matchArrivedAppointmentsForServices` (src/lib/appointments/match-arrived.ts)
// for the pure matching rule and its "leave it open, never guess" default
// on an unmatched or null service_id.
//
// Best-effort by design, exactly like completeAppointmentFromVisitAction:
// the caller must treat {ok:false} or a thrown error as non-fatal, since the
// visit already exists by the time this runs. Returns {ok:false} (not an
// error) when nothing matched — that's the common case (a true walk-in with
// no prior appointment, or arrived appointments for services this visit
// doesn't cover), not a failure.
//
// Wired in at visits/new/actions.ts (createVisitAction), on the branch where
// no appointment_id was threaded. It is deliberately an `else` rather than an
// unconditional extra call: when an appointment_id IS supplied,
// completeAppointmentFromVisitAction has already completed that whole booking
// group, and running this as well would also sweep up any UNRELATED arrived
// appointment the patient happens to have — recording it as completed by a
// visit that was not it, under this action's own
// via: "visit_created_from_patient_page" metadata, which would then be false.
export async function completeArrivedAppointmentsForPatientAction(
  patientId: string,
  visitId: string,
  serviceIds: ReadonlyArray<string>,
  visitGroupId: string | null = null,
): Promise<ApptResult> {
  const supabase = await createClient();

  // Prove the pairing before touching any appointment — this action is
  // exported and independently callable, and (unlike
  // completeAppointmentFromVisitAction, which proves the same thing via the
  // appointment row) previously had nothing pinning visitId to patientId.
  const { data: visit, error: visitErr } = await supabase
    .from("visits")
    .select("id, patient_id")
    .eq("id", visitId)
    .is("deleted_at", null)
    .maybeSingle();
  if (visitErr || !visit) {
    return { ok: false, error: "Visit not found." };
  }
  if (visit.patient_id !== patientId) {
    return { ok: false, error: "That visit belongs to a different patient." };
  }

  if (serviceIds.length === 0) {
    return { ok: false, error: "No arrived appointment for this patient." };
  }

  const { data: arrived, error: arrivedErr } = await supabase
    .from("appointments")
    .select("id, service_id")
    .eq("patient_id", patientId)
    .eq("status", "arrived");
  if (arrivedErr) return { ok: false, error: arrivedErr.message };
  if (!arrived || arrived.length === 0) {
    return { ok: false, error: "No arrived appointment for this patient." };
  }

  const ids = matchArrivedAppointmentsForServices(arrived, serviceIds);
  if (ids.length === 0) {
    // Arrived appointments exist, but none is for a service this visit
    // covers — e.g. the patient is still waiting on an unrelated
    // consultation. Leave them all open rather than guessing.
    return { ok: false, error: "No arrived appointment for this patient." };
  }

  return transitionGroup(ids, "completed", {
    via: "visit_created_from_patient_page",
    visit_id: visitId,
    visit_group_id: visitGroupId,
    matched_service_ids: Array.from(
      new Set(arrived.filter((a) => ids.includes(a.id)).map((a) => a.service_id)),
    ),
  });
}

// H2: attach a real patient to a walk-in-mode appointment (patient_id =
// null, created via new-appointment-sheet's "Walk-in" mode, including a
// booking made from a website message) so it stops being a dead end. Once patient_id is set, the
// existing "+ Start visit" link (transition-buttons.tsx, gated on status ===
// "arrived" && patientId) becomes reachable and the normal
// completeAppointmentFromVisitAction path finishes the job — this action
// does not itself transition the appointment's status.
export async function attachPatientToAppointmentAction(
  appointmentId: string,
  patientInput: AttachPatientInput,
): Promise<ApptResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Reception or admin only." };
  }

  const parsed = AttachPatientSchema.safeParse(patientInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the patient details.",
    };
  }

  const supabase = await createClient();
  const { data: appt, error: apptErr } = await supabase
    .from("appointments")
    .select("id, patient_id, status, booking_group_id, walk_in_name, walk_in_phone")
    .eq("id", appointmentId)
    .maybeSingle();
  if (apptErr || !appt) return { ok: false, error: "Appointment not found." };
  if (appt.patient_id) {
    return { ok: false, error: "This appointment already has a patient attached." };
  }
  if (appt.status !== "confirmed" && appt.status !== "arrived") {
    return { ok: false, error: "This appointment can't have a patient attached right now." };
  }

  const admin = createAdminClient();
  let patientId: string;
  let drmId: string | null;
  let resolution: "existing" | "reused" | "created";
  if (parsed.data.mode === "existing") {
    const { data: row } = await activePatients(admin.from("patients").select("id, drm_id"))
      .eq("id", parsed.data.patient_id)
      .maybeSingle();
    if (!row) return { ok: false, error: "We couldn't find that patient. Search again." };
    patientId = row.id;
    drmId = row.drm_id;
    resolution = "existing";
  } else {
    const r = await resolvePatient(admin, {
      first_name: parsed.data.first_name,
      last_name: parsed.data.last_name,
      middle_name: parsed.data.middle_name,
      birthdate: parsed.data.birthdate,
      sex: parsed.data.sex,
      phone: parsed.data.phone,
      email: parsed.data.email,
      address: parsed.data.address,
    });
    if (!r.ok) return { ok: false, error: r.error };
    patientId = r.id;
    drmId = r.drm_id;
    resolution = r.reused ? "reused" : "created";
  }

  // Attach across the whole booking group (a multi-service walk-in) so every
  // sibling row moves together, not just the one the reception clicked.
  let ids: string[] = [appt.id];
  if (appt.booking_group_id) {
    const { data: siblings } = await supabase
      .from("appointments")
      .select("id")
      .eq("booking_group_id", appt.booking_group_id)
      .is("patient_id", null);
    if (siblings && siblings.length > 0) ids = siblings.map((r) => r.id);
  }

  const { data: updated, error: updErr } = await supabase
    .from("appointments")
    .update({ patient_id: patientId })
    .in("id", ids)
    .select("id");
  if (updErr) return { ok: false, error: updErr.message };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  const updatedIds = (updated ?? []).map((r) => r.id);
  await Promise.all(
    updatedIds.map((id) =>
      audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: patientId,
        action: "appointment.patient_attached",
        resource_type: "appointment",
        resource_id: id,
        metadata: {
          actor_role: session.role,
          patient_resolution: resolution,
          drm_id: drmId,
          previous_walk_in_name: appt.walk_in_name,
          previous_walk_in_phone: appt.walk_in_phone,
          group_appointment_ids: updatedIds,
        },
        ip_address: ip,
        user_agent: ua,
      }),
    ),
  );

  revalidatePath("/staff/appointments");
  return { ok: true };
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

// ---------------------------------------------------------------------------
// Bulk "Mark as no-show" for bookings with no set time that have sat open for
// STALE_UNTIMED_AFTER_DAYS or more (src/lib/appointments/stale.ts). Nothing
// closes these automatically, so an online booking the patient never came in
// for stays on the Appointments page for months.
//
// The page sends the bookings it showed as likely no-shows, but this is a
// callable endpoint, so the database re-checks the SAME rule on every row
// inside the update itself — still confirmed, still no set time, still older
// than the cutoff. A booking reception marked arrived after the page rendered,
// or any id that was never stale, is silently left alone rather than trusted.
// ---------------------------------------------------------------------------

// `heldBack` (Undo only): bookings that stay no-show because a patient on
// them was merged or deleted after the bulk mark — the single ↶ Revert
// refuses those too.
export type BulkNoShowResult =
  | { ok: true; data: { marked: string[][]; heldBack?: number } }
  | { ok: false; error: string };

// PostgREST puts `.in()` ids in the URL; keep each request comfortably short.
const BULK_ID_CHUNK = 150;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Regroups the rows an update actually touched back into the bookings they
// came from, so the audit trail and the Undo name exactly what moved.
function regroup(bookings: readonly (readonly string[])[], movedIds: ReadonlySet<string>): string[][] {
  return bookings
    .map((ids) => ids.filter((id) => movedIds.has(id)))
    .filter((ids) => ids.length > 0);
}

async function auditBulk(
  session: { user_id: string; role: string },
  rows: ReadonlyArray<{ id: string; patient_id: string | null }>,
  groups: string[][],
  action: string,
  via: string,
) {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  const groupOf = new Map<string, string[]>();
  for (const g of groups) for (const id of g) groupOf.set(id, g);
  await Promise.all(
    rows.map((row) =>
      audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: row.patient_id,
        action,
        resource_type: "appointment",
        resource_id: row.id,
        metadata: {
          actor_role: session.role,
          group_appointment_ids: groupOf.get(row.id) ?? [row.id],
          via,
          stale_after_days: STALE_UNTIMED_AFTER_DAYS,
          bulk_booking_count: groups.length,
        },
        ip_address: ip,
        user_agent: ua,
      }),
    ),
  );
}

export async function markLikelyNoShowsAction(bookings: BulkBookingIds): Promise<BulkNoShowResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Reception or admin only." };
  }
  const parsed = BulkBookingIdsSchema.safeParse(bookings);
  if (!parsed.success) return { ok: false, error: "Nothing to mark — refresh the page and try again." };

  const cutoffIso = staleCutoffIso(todayManilaISODate());
  const supabase = await createClient();
  const moved: { id: string; patient_id: string | null }[] = [];
  for (const ids of chunk(parsed.data.flat(), BULK_ID_CHUNK)) {
    const { data, error } = await supabase
      .from("appointments")
      .update({ status: "no_show" })
      .in("id", ids)
      .eq("status", "confirmed")
      .is("scheduled_at", null)
      .lt("created_at", cutoffIso)
      .select("id, patient_id");
    if (error) {
      // Earlier chunks may already have moved; still audit them and let
      // reception see what happened rather than hiding a partial run.
      if (moved.length > 0) {
        const groups = regroup(parsed.data, new Set(moved.map((r) => r.id)));
        await auditBulk(session, moved, groups, "appointment.no_show", "bulk_likely_no_show");
        revalidatePath("/staff/appointments");
      }
      return { ok: false, error: "Could not mark all of them — refresh the page to see which are left." };
    }
    moved.push(...(data ?? []));
  }

  if (moved.length === 0) {
    return { ok: false, error: "None of those bookings can be marked any more — refresh the page." };
  }
  const groups = regroup(parsed.data, new Set(moved.map((r) => r.id)));
  await auditBulk(session, moved, groups, "appointment.no_show", "bulk_likely_no_show");
  revalidatePath("/staff/appointments");
  return { ok: true, data: { marked: groups } };
}

// Undo for the action above: puts exactly the bookings it just marked back to
// confirmed. Same guard as the single ↶ Revert (transitionGroup → confirmed):
// moving a booking back into active work requires every linked patient to
// still be active.
export async function undoLikelyNoShowsAction(bookings: BulkBookingIds): Promise<BulkNoShowResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Reception or admin only." };
  }
  const parsed = BulkBookingIdsSchema.safeParse(bookings);
  if (!parsed.success) return { ok: false, error: "Nothing to undo." };

  // One merged or deleted patient must not block the whole Undo: split the
  // bookings first, restore only those whose every row is a walk-in or an
  // active patient, and report the rest as held back.
  const admin = createAdminClient();
  const patientOf = new Map<string, string | null>();
  for (const ids of chunk(parsed.data.flat(), BULK_ID_CHUNK)) {
    const { data, error } = await admin.from("appointments").select("id, patient_id").in("id", ids);
    if (error) return { ok: false, error: "Could not check the patient records — try again." };
    for (const row of data ?? []) patientOf.set(row.id, row.patient_id);
  }
  const patientIds = [...new Set([...patientOf.values()].filter((p): p is string => p !== null))];
  const activeIds = new Set<string>();
  for (const ids of chunk(patientIds, BULK_ID_CHUNK)) {
    const { data, error } = await activePatients(admin.from("patients").select("id")).in("id", ids);
    if (error) return { ok: false, error: "Could not check the patient records — try again." };
    for (const row of data ?? []) activeIds.add(row.id);
  }
  const { restorable, heldBack } = splitBookingsByActivePatient(parsed.data, patientOf, activeIds);
  if (restorable.length === 0) {
    return heldBack.length > 0
      ? { ok: true, data: { marked: [], heldBack: heldBack.length } }
      : { ok: false, error: "Nothing left to undo." };
  }

  const restorableIds = restorable.flat();
  const active = await assertAppointmentsPatientsActive(admin, restorableIds);
  if (!active.ok) return { ok: false, error: active.error };

  const supabase = await createClient();
  const moved: { id: string; patient_id: string | null }[] = [];
  for (const ids of chunk(restorableIds, BULK_ID_CHUNK)) {
    const { data, error } = await supabase
      .from("appointments")
      .update({ status: "confirmed" })
      .in("id", ids)
      .eq("status", "no_show")
      .select("id, patient_id");
    if (error) {
      if (moved.length > 0) {
        const groups = regroup(restorable, new Set(moved.map((r) => r.id)));
        await auditBulk(session, moved, groups, "appointment.confirmed", "bulk_likely_no_show_undo");
        revalidatePath("/staff/appointments");
      }
      return { ok: false, error: "Could not undo all of them — refresh the page to see which are back." };
    }
    moved.push(...(data ?? []));
  }

  if (moved.length === 0) {
    return heldBack.length > 0
      ? { ok: true, data: { marked: [], heldBack: heldBack.length } }
      : { ok: false, error: "Nothing left to undo." };
  }
  const groups = regroup(restorable, new Set(moved.map((r) => r.id)));
  await auditBulk(session, moved, groups, "appointment.confirmed", "bulk_likely_no_show_undo");
  revalidatePath("/staff/appointments");
  return { ok: true, data: { marked: groups, heldBack: heldBack.length } };
}
