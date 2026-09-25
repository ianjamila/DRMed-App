"use server";

import { z } from "zod";
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
import { MAX_BULK_RECORDS } from "@/lib/ui/bulk-selection";
import { BULK_DELETABLE_STATUSES } from "@/lib/appointments/bulk-eligibility";

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

export type ApptResult =
  | { ok: true; changedIds: string[] }
  | { ok: false; error: string };

// One booking as the operator saw it: its appointment ids and the status on
// screen when they ticked it. `from: null` = no expected status (the single-row
// buttons, whose job includes a deliberate revert).
interface BatchEntry {
  ids: ReadonlyArray<string>;
  from: string | null;
}

function flattenBatch(batch: ReadonlyArray<BatchEntry>): {
  ids: string[];
  idsByFrom: Map<string | null, string[]>;
} {
  const seen = new Set<string>();
  const idsByFrom = new Map<string | null, string[]>();
  for (const entry of batch) {
    for (const id of entry.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const list = idsByFrom.get(entry.from) ?? [];
      list.push(id);
      idsByFrom.set(entry.from, list);
    }
  }
  return { ids: [...seen], idsByFrom };
}

// Sibling ids per appointment WITHIN this batch, derived from booking_group_id
// on the server — the client's grouping is never what the audit trail records.
async function bookingSiblings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<Map<string, string[]>> {
  const { data } = await supabase
    .from("appointments")
    .select("id, booking_group_id")
    .in("id", ids);
  const byGroup = new Map<string, string[]>();
  for (const row of data ?? []) {
    if (!row.booking_group_id) continue;
    const list = byGroup.get(row.booking_group_id) ?? [];
    list.push(row.id);
    byGroup.set(row.booking_group_id, list);
  }
  const out = new Map<string, string[]>();
  for (const row of data ?? []) {
    out.set(row.id, row.booking_group_id ? byGroup.get(row.booking_group_id)! : [row.id]);
  }
  return out;
}

const TOO_MANY = `Too many appointments in one go — the limit is ${MAX_BULK_RECORDS}. Select fewer bookings.`;

async function transitionGroups(
  batch: ReadonlyArray<BatchEntry>,
  to: Transition,
  extraMetadata?: Record<string, unknown>,
): Promise<ApptResult> {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false, error: "Reception or admin only." };
  }
  const { ids, idsByFrom } = flattenBatch(batch);
  if (ids.length === 0) {
    return { ok: false, error: "No appointments to update." };
  }
  if (ids.length > MAX_BULK_RECORDS) {
    return { ok: false, error: TOO_MANY };
  }
  const allowed = ALLOWED_FROM[to];
  const notInState = `Appointment is not in a state we can mark "${to.replace(/_/g, " ")}".`;
  for (const from of idsByFrom.keys()) {
    if (from !== null && !allowed.includes(from)) return { ok: false, error: notInState };
  }

  // Moving to arrived or back to confirmed puts work back on the record;
  // cancelling or marking no-show does not, so those stay unguarded.
  // Walk-in appointments (patient_id NULL) pass. All-or-nothing on purpose:
  // one inactive patient refuses the whole batch and nothing is written.
  if (to === "arrived" || to === "confirmed") {
    const active = await assertAppointmentsPatientsActive(createAdminClient(), ids);
    if (!active.ok) return { ok: false, error: active.error };
  }

  const supabase = await createClient();
  const siblings = await bookingSiblings(supabase, ids);

  // One UPDATE per expected status. `eq("status", from)` is the stale-click
  // guard: ALLOWED_FROM alone would let a "Confirm" prepared on a pending
  // callback un-cancel a booking a colleague cancelled a second earlier.
  const writes = await Promise.all(
    [...idsByFrom].map(([from, groupIds]) =>
      supabase
        .from("appointments")
        .update({ status: to })
        .in("id", groupIds)
        .in("status", from === null ? allowed : [from])
        .select("id, patient_id"),
    ),
  );
  const failed = writes.find((w) => w.error);
  const data = writes.flatMap((w) => w.data ?? []);

  // Audit and revalidate whatever the writes actually committed BEFORE
  // deciding whether to report an error — with a multi-status bulk, write A
  // can commit while write B errors, and A's rows must not go unaudited or
  // leave the page stale just because B failed.
  if (data.length > 0) {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const ua = h.get("user-agent");

    // One audit row per appointment so the trail per-row stays grep-able;
    // group_appointment_ids is the BOOKING's own siblings (server-derived),
    // bulk_batch_size is how many ids this call carried — a sweep is batch > group.
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
            group_appointment_ids: siblings.get(row.id) ?? [row.id],
            bulk_batch_size: ids.length,
            ...extraMetadata,
          },
          ip_address: ip,
          user_agent: ua,
        }),
      ),
    );
    revalidatePath("/staff/appointments");
  }

  if (failed?.error) {
    const n = data.length;
    return {
      ok: false,
      error:
        n > 0
          ? `${failed.error.message} — ${n} appointment${n === 1 ? " was" : "s were"} already updated; refresh to see the current list.`
          : failed.error.message,
    };
  }

  if (data.length === 0) {
    // Nothing matched and nothing errored. `from: null` (the legacy
    // single-row callers) keeps today's "not in that state" error; a bulk
    // call (every entry carries a non-null `from`) means every booking
    // changed since selection, which the bar reports as "already changed"
    // through its normal ok outcome — still refresh so the list catches up.
    if (idsByFrom.has(null)) return { ok: false, error: notInState };
    revalidatePath("/staff/appointments");
    return { ok: true, changedIds: [] };
  }

  return { ok: true, changedIds: data.map((row) => row.id) };
}

// Single-booking wrapper — every existing caller (the row buttons,
// completeAppointmentFromVisitAction, completeArrivedAppointmentsForPatientAction)
// keeps calling this and is unaffected: no expected status, ALLOWED_FROM only.
async function transitionGroup(
  appointmentIds: ReadonlyArray<string>,
  to: Transition,
  extraMetadata?: Record<string, unknown>,
): Promise<ApptResult> {
  return transitionGroups([{ ids: appointmentIds, from: null }], to, extraMetadata);
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

const BULK_TRANSITIONS = ["arrived", "no_show", "cancelled", "confirmed"] as const;
// Inputs from the client are untrusted: bookings as {ids, from}, and a target
// that can never be "completed" (only starting a visit completes a booking).
const BulkBatchSchema = z
  .array(z.object({ ids: z.array(z.string().uuid()).min(1), from: z.string().min(1) }))
  .min(1);

export async function bulkTransitionAction(batch: unknown, to: unknown): Promise<ApptResult> {
  const parsedBatch = BulkBatchSchema.safeParse(batch);
  const parsedTo = z.enum(BULK_TRANSITIONS).safeParse(to);
  if (!parsedBatch.success || !parsedTo.success) {
    return { ok: false, error: "Could not read the selection — refresh and try again." };
  }
  return transitionGroups(parsedBatch.data, parsedTo.data);
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
  return { ok: true, changedIds: updatedIds };
}

async function deleteGroups(batch: ReadonlyArray<BatchEntry>): Promise<ApptResult> {
  const session = await requireActiveStaff();
  if (session.role !== "admin") {
    return { ok: false, error: "Admin only." };
  }
  const { ids, idsByFrom } = flattenBatch(batch);
  if (ids.length === 0) {
    return { ok: false, error: "No appointments to delete." };
  }
  if (ids.length > MAX_BULK_RECORDS) {
    return { ok: false, error: TOO_MANY };
  }

  const supabase = await createClient();
  const siblings = await bookingSiblings(supabase, ids);
  // Audit from what the DELETE actually returned — never from a pre-read, so
  // two admins deleting overlapping selections cannot audit rows the other
  // one removed. With an expected status (bulk) a booking that changed since
  // selection is left alone and reported as unchanged.
  const writes = await Promise.all(
    [...idsByFrom].map(([from, groupIds]) => {
      let query = supabase.from("appointments").delete().in("id", groupIds);
      if (from !== null) query = query.eq("status", from);
      return query.select("id, patient_id, status, scheduled_at");
    }),
  );
  const failed = writes.find((w) => w.error);
  const deleted = writes.flatMap((w) => w.data ?? []);

  // Audit and revalidate whatever actually got deleted BEFORE deciding
  // whether to report an error — with a multi-status bulk, one DELETE can
  // commit while another errors, and the committed rows must not go
  // unaudited or leave the page stale just because the other one failed.
  if (deleted.length > 0) {
    const h = await headers();
    const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const ua = h.get("user-agent");
    await Promise.all(
      deleted.map((row) =>
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
            group_appointment_ids: siblings.get(row.id) ?? [row.id],
            bulk_batch_size: ids.length,
          },
          ip_address: ip,
          user_agent: ua,
        }),
      ),
    );
    revalidatePath("/staff/appointments");
  }

  if (failed?.error) {
    const n = deleted.length;
    return {
      ok: false,
      error:
        n > 0
          ? `${failed.error.message} — ${n} appointment${n === 1 ? " was" : "s were"} already deleted; refresh to see the current list.`
          : failed.error.message,
    };
  }

  if (deleted.length === 0) {
    // Nothing matched and nothing errored. `from: null` (the legacy
    // single-row callers) keeps today's "no matching appointments" error; a
    // bulk call (every entry carries a non-null `from`) means every booking
    // changed since selection, which the bar reports as "already changed"
    // through its normal ok outcome — still refresh so the list catches up.
    if (idsByFrom.has(null)) return { ok: false, error: "No matching appointments." };
    revalidatePath("/staff/appointments");
    return { ok: true, changedIds: [] };
  }

  return { ok: true, changedIds: deleted.map((row) => row.id) };
}

// Single booking, any status — today's row-button behaviour (now audited from
// the returned rows).
export async function deleteAppointmentAction(
  appointmentIds: ReadonlyArray<string>,
): Promise<ApptResult> {
  return deleteGroups([{ ids: appointmentIds, from: null }]);
}

// Bulk bar: every entry must carry a non-completed expected status, which the
// delete enforces in the write — a booking that completed since selection
// is not deleted.
export async function bulkDeleteAction(batch: unknown): Promise<ApptResult> {
  const parsed = BulkBatchSchema.safeParse(batch);
  if (!parsed.success) {
    return { ok: false, error: "Could not read the selection — refresh and try again." };
  }
  if (parsed.data.some((entry) => !BULK_DELETABLE_STATUSES.includes(entry.from))) {
    return { ok: false, error: "Completed bookings cannot be deleted from here." };
  }
  return deleteGroups(parsed.data);
}
