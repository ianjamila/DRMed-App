import { randomUUID } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import { manilaSlotFor, KINDS_PER_BRANCH, type BookingBranch } from "@/lib/validations/booking";
import { dayWindowFor } from "@/lib/physicians/availability";
import { decideAppointmentTiming, type BookingConflict, type ServiceRow } from "@/lib/appointments/timing";

// Server-side orchestration. Receives the admin client as a param (no service-
// role import here), so it must only be called from server actions / route handlers.

type AdminClient = ReturnType<typeof createAdminClient>;

// The doctor-availability context shape expected by decideAppointmentTiming.
type DoctorCtx = NonNullable<Parameters<typeof decideAppointmentTiming>[0]["doctor"]>;

export interface PatientResolution {
  patientId: string | null;
  drmId: string | null;
  email: string | null;
  walkInName?: string | null;
  walkInPhone?: string | null;
  resolution: "existing" | "reused" | "created" | "walk_in";
}

export interface CreateAppointmentInput {
  branch: BookingBranch;
  // For doctor branch, a single-element array holding the consultation id.
  serviceIds: string[];
  physicianId: string | null;
  scheduledAt: string | null; // validated ISO or null
  notes: string | null;
  createdBy: string | null; // auth.users id (staff) or null (public)
  mode: "strict" | "relaxed"; // strict = hard-block conflicts (public); relaxed = warn (staff)
  override: boolean; // relaxed only: proceed despite conflicts
  // Resolve the patient ONLY after timing/conflicts pass, to avoid orphan rows on failure.
  resolvePatient: () => Promise<{ ok: true; patient: PatientResolution } | { ok: false; error: string }>;
}

export type CreateAppointmentResult =
  | {
      ok: true;
      bookingGroupId: string;
      appointmentIds: string[];
      scheduledAtIso: string | null;
      pendingCallback: boolean;
      conflicts: BookingConflict[];
      patient: PatientResolution;
      services: ServiceRow[];
    }
  | { ok: false; error: string }
  | { ok: false; code: "conflict"; error: string; conflicts: BookingConflict[] };

export async function loadServices(
  admin: AdminClient,
  ids: ReadonlyArray<string>,
): Promise<{ ok: true; rows: ServiceRow[] } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: false, error: "Pick at least one service." };
  const { data, error } = await admin
    .from("services")
    .select("id, name, kind, is_active, fasting_required, requires_time_slot, allow_concurrent")
    .in("id", ids);
  if (error) return { ok: false, error: error.message };
  if (!data || data.length !== ids.length) {
    return { ok: false, error: "One or more services are no longer available." };
  }
  for (const r of data) {
    if (!r.is_active) return { ok: false, error: "One of the selected services is no longer active." };
  }
  return { ok: true, rows: data };
}

export async function createAppointmentGroup(
  admin: AdminClient,
  input: CreateAppointmentInput,
): Promise<CreateAppointmentResult> {
  // 1. Load + validate services for the branch.
  const svc = await loadServices(admin, input.serviceIds);
  if (!svc.ok) return { ok: false, error: svc.error };
  const services = svc.rows;
  const allowedKinds = new Set(KINDS_PER_BRANCH[input.branch]);
  for (const s of services) {
    if (!allowedKinds.has(s.kind)) {
      return { ok: false, error: "One of the selected services doesn't match this booking type. Reload and try again." };
    }
  }

  // 2. For the doctor branch, resolve availability context (DB).
  let doctorCtx: DoctorCtx | undefined;
  if (input.branch === "doctor_appointment") {
    if (!input.physicianId) return { ok: false, error: "Pick a physician." };
    const { data: physician } = await admin
      .from("physicians")
      .select("id, is_active")
      .eq("id", input.physicianId)
      .maybeSingle();
    if (!physician || !physician.is_active) {
      return { ok: false, error: "Selected physician is no longer available." };
    }
    const { data: blocks } = await admin
      .from("physician_schedules")
      .select("day_of_week, start_time, end_time")
      .eq("physician_id", input.physicianId);
    const allowConcurrent = services[0]?.allow_concurrent ?? true;
    const byAppointment = (blocks ?? []).length === 0;
    if (byAppointment) {
      doctorCtx = { byAppointment: true, dayClosed: false, window: { available: false }, existingBookingCount: 0, allowConcurrent };
    } else if (input.scheduledAt) {
      const slot = manilaSlotFor(new Date(input.scheduledAt));
      const [{ data: closure }, { data: overrides }, { data: existing }] = await Promise.all([
        admin.from("clinic_closures").select("closed_on").eq("closed_on", slot.dateISO).maybeSingle(),
        admin.from("physician_schedule_overrides").select("override_on, start_time, end_time").eq("physician_id", input.physicianId).eq("override_on", slot.dateISO),
        admin.from("appointments").select("id").eq("physician_id", input.physicianId).eq("scheduled_at", input.scheduledAt).not("status", "in", "(cancelled,no_show)"),
      ]);
      const window = dayWindowFor(slot.dateISO, slot.dayOfWeek, { blocks: blocks ?? [], overrides: overrides ?? [] });
      doctorCtx = { byAppointment: false, dayClosed: !!closure, window, existingBookingCount: existing?.length ?? 0, allowConcurrent };
    } else {
      doctorCtx = { byAppointment: false, dayClosed: false, window: { available: true }, existingBookingCount: 0, allowConcurrent };
    }
  }

  // 3. Pure timing + conflict decision.
  const timing = decideAppointmentTiming({ branch: input.branch, services, scheduledAt: input.scheduledAt, doctor: doctorCtx });
  if (!timing.ok) return { ok: false, error: timing.error };

  // 4. Conflict handling differs by mode.
  if (timing.conflicts.length > 0) {
    if (input.mode === "strict") {
      return { ok: false, error: timing.conflicts[0]!.message };
    }
    if (!input.override) {
      return { ok: false, code: "conflict", error: "This time has a scheduling conflict.", conflicts: timing.conflicts };
    }
  }

  // 5. Resolve the patient only now that timing/conflicts have passed.
  const patientRes = await input.resolvePatient();
  if (!patientRes.ok) return { ok: false, error: patientRes.error };
  const patient = patientRes.patient;

  // 6. Insert one row per service sharing a booking_group_id.
  const bookingGroupId = randomUUID();
  const status = timing.pendingCallback ? "pending_callback" : "confirmed";
  const physicianId = input.branch === "doctor_appointment" ? input.physicianId : null;
  const homeServiceRequested = input.branch === "home_service";
  const rows = services.map((s) => ({
    patient_id: patient.patientId,
    service_id: s.id,
    physician_id: physicianId,
    scheduled_at: timing.scheduledAtIso,
    notes: input.notes,
    status,
    booking_group_id: bookingGroupId,
    home_service_requested: homeServiceRequested,
    walk_in_name: patient.walkInName ?? null,
    walk_in_phone: patient.walkInPhone ?? null,
    created_by: input.createdBy,
  }));
  const { data: created, error } = await admin.from("appointments").insert(rows).select("id");
  if (error || !created || created.length !== rows.length) {
    return { ok: false, error: error?.message ?? "Could not save the appointment." };
  }

  return {
    ok: true,
    bookingGroupId,
    appointmentIds: created.map((r) => r.id),
    scheduledAtIso: timing.scheduledAtIso,
    pendingCallback: timing.pendingCallback,
    conflicts: timing.conflicts,
    patient,
    services,
  };
}
