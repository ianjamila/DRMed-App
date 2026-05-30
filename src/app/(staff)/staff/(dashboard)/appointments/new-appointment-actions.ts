"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import { StaffBookingSchema, type StaffBookingInput } from "@/lib/validations/staff-booking";
import { createAppointmentGroup, type PatientResolution } from "@/lib/appointments/create";
import type { BookingConflict } from "@/lib/appointments/timing";
import { resolvePatient } from "@/lib/patients/resolve";
import { patientSearchOrClauses } from "@/lib/patients/search";
import { notifyAppointmentBooked } from "@/lib/notifications/notify-appointment-booked";

export type StaffAppointmentResult =
  | { ok: true; data: { booking_group_id: string } }
  | { ok: false; error: string }
  | { ok: false; code: "conflict"; error: string; data: { conflicts: BookingConflict[] } };

export interface PatientSearchRow {
  id: string;
  drm_id: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
  birthdate: string | null;
  pre_registered: boolean;
}

export interface UpcomingApptRow {
  id: string;
  scheduled_at: string | null;
  status: string;
  service_name: string | null;
  physician_name: string | null;
}

async function gateReceptionAdmin() {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    return { ok: false as const, error: "You don't have access to create appointments." };
  }
  return { ok: true as const, session };
}

export async function createStaffAppointmentAction(input: StaffBookingInput): Promise<StaffAppointmentResult> {
  const gate = await gateReceptionAdmin();
  if (!gate.ok) return { ok: false, error: gate.error };
  const { session } = gate;
  const { ip, ua } = await ipAndAgent();

  const parsed = StaffBookingSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;

  const admin = createAdminClient();

  const resolveThunk = async (): Promise<{ ok: true; patient: PatientResolution } | { ok: false; error: string }> => {
    if (data.patient.mode === "existing") {
      const { data: row } = await admin.from("patients").select("id, drm_id, email").eq("id", data.patient.patient_id).maybeSingle();
      if (!row) return { ok: false, error: "We couldn't find that patient. Search again." };
      return { ok: true, patient: { patientId: row.id, drmId: row.drm_id, email: row.email, resolution: "existing" } };
    }
    if (data.patient.mode === "new") {
      const r = await resolvePatient(admin, {
        first_name: data.patient.first_name,
        last_name: data.patient.last_name,
        middle_name: data.patient.middle_name,
        birthdate: data.patient.birthdate,
        sex: data.patient.sex,
        phone: data.patient.phone,
        email: data.patient.email,
        address: data.patient.address,
      });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, patient: { patientId: r.id, drmId: r.drm_id, email: data.patient.email, resolution: r.reused ? "reused" : "created" } };
    }
    // walk_in — no patient record
    return {
      ok: true,
      patient: { patientId: null, drmId: null, email: null, walkInName: data.patient.walk_in_name, walkInPhone: data.patient.walk_in_phone, resolution: "walk_in" },
    };
  };

  const result = await createAppointmentGroup(admin, {
    branch: data.branch,
    serviceIds: data.branch === "doctor_appointment" ? [data.service_id!] : data.service_ids!,
    physicianId: data.branch === "doctor_appointment" ? data.physician_id! : null,
    scheduledAt: data.scheduled_at,
    notes: data.notes,
    createdBy: session.user_id,
    mode: "relaxed",
    override: data.override,
    resolvePatient: resolveThunk,
  });

  if (!result.ok) {
    if ("code" in result && result.code === "conflict") {
      return { ok: false, code: "conflict", error: result.error, data: { conflicts: result.conflicts } };
    }
    return { ok: false, error: result.error };
  }

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: result.patient.patientId,
    action: "appointment.created_by_staff",
    resource_type: "appointment_group",
    resource_id: result.bookingGroupId,
    metadata: {
      via: "staff",
      actor_role: session.role,
      branch: data.branch,
      service_ids: result.services.map((s) => s.id),
      service_names: result.services.map((s) => s.name),
      scheduled_at: result.scheduledAtIso,
      pending_callback: result.pendingCallback,
      patient_resolution: result.patient.resolution,
      override_conflict: data.override && result.conflicts.length > 0,
      conflicts: result.conflicts.map((c) => c.kind),
      group_appointment_ids: result.appointmentIds,
      drm_id: result.patient.drmId,
    },
    ip_address: ip,
    user_agent: ua,
  });

  if (data.send_confirmation) {
    try {
      await notifyAppointmentBooked({ appointmentId: result.appointmentIds[0]!, patientId: result.patient.patientId });
    } catch (err) {
      console.error("notifyAppointmentBooked threw", err);
    }
  }

  revalidatePath("/staff/appointments");
  return { ok: true, data: { booking_group_id: result.bookingGroupId } };
}

// Staff-only patient search for the slide-over. RLS server client (reads are
// RLS-gated; we additionally gate by role). No audit — consistent with the
// existing inline searches on /staff/visits/new and /staff/patients.
export async function searchPatientsAction(q: string): Promise<{ ok: true; data: PatientSearchRow[] } | { ok: false; error: string }> {
  const gate = await gateReceptionAdmin();
  if (!gate.ok) return { ok: false, error: gate.error };
  const term = q.trim();
  if (term.length < 2) return { ok: true, data: [] };
  const supabase = await createClient();
  // Token-based: every word must match some field (any order), so "Jamila, Ian"
  // finds a patient stored as first_name="Ian", last_name="Jamila".
  let query = supabase
    .from("patients")
    .select("id, drm_id, first_name, last_name, phone, email, birthdate, pre_registered")
    .order("created_at", { ascending: false })
    .limit(25);
  for (const clause of patientSearchOrClauses(term)) {
    query = query.or(clause);
  }
  const { data, error } = await query;
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: data ?? [] };
}

export async function getPatientUpcomingAppointmentsAction(patientId: string): Promise<{ ok: true; data: UpcomingApptRow[] } | { ok: false; error: string }> {
  const gate = await gateReceptionAdmin();
  if (!gate.ok) return { ok: false, error: gate.error };
  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("appointments")
    .select("id, scheduled_at, status, services(name), physicians(full_name)")
    .eq("patient_id", patientId)
    .not("status", "in", "(cancelled,no_show,completed)")
    .or(`scheduled_at.gte.${nowIso},scheduled_at.is.null`)
    .order("scheduled_at", { ascending: true })
    .limit(10);
  if (error) return { ok: false, error: error.message };
  const rows: UpcomingApptRow[] = (data ?? []).map((a) => {
    const s = Array.isArray(a.services) ? a.services[0] : a.services;
    const ph = Array.isArray(a.physicians) ? a.physicians[0] : a.physicians;
    return { id: a.id, scheduled_at: a.scheduled_at, status: a.status, service_name: s?.name ?? null, physician_name: ph?.full_name ?? null };
  });
  return { ok: true, data: rows };
}
