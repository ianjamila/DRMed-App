"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import {
  BookingSchema,
  manilaSlotFor,
} from "@/lib/validations/booking";
import { notifyAppointmentBooked } from "@/lib/notifications/notify-appointment-booked";

const ALLOWED_KINDS = new Set([
  "lab_test",
  "lab_package",
  "doctor_consultation",
]);

export type BookingResult =
  | {
      ok: true;
      appointment_id: string;
      drm_id: string;
      scheduled_at: string;
      service_name: string;
    }
  | { ok: false; error: string };

// Public booking — accepts unauthenticated submissions. Anti-abuse:
// - Honeypot field "website": silent drop on fill
// - Server-side date sanity (must be future, within Mon-Sat 8-5)
// - Rate limit by IP comes in Phase 8 hardening
export async function submitBookingAction(
  _prev: BookingResult | null,
  formData: FormData,
): Promise<BookingResult> {
  if ((formData.get("website") ?? "") !== "") {
    // Silent honeypot drop — pretend success so bots stop trying.
    return {
      ok: true,
      appointment_id: "",
      drm_id: "",
      scheduled_at: "",
      service_name: "",
    };
  }

  const parsed = BookingSchema.safeParse({
    first_name: formData.get("first_name"),
    last_name: formData.get("last_name"),
    middle_name: formData.get("middle_name") ?? "",
    birthdate: formData.get("birthdate"),
    sex: formData.get("sex") ?? "",
    phone: formData.get("phone"),
    email: formData.get("email"),
    address: formData.get("address") ?? "",
    service_id: formData.get("service_id"),
    physician_id: formData.get("physician_id") ?? "",
    scheduled_at: formData.get("scheduled_at"),
    notes: formData.get("notes") ?? "",
  });

  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the form.",
    };
  }

  const admin = createAdminClient();

  const { data: service, error: svcErr } = await admin
    .from("services")
    .select("id, name, is_active, kind")
    .eq("id", parsed.data.service_id)
    .maybeSingle();
  if (svcErr || !service || !service.is_active) {
    return { ok: false, error: "Selected service is no longer available." };
  }
  if (!ALLOWED_KINDS.has(service.kind)) {
    return { ok: false, error: "Selected service cannot be booked online." };
  }

  // Re-check closures + operating-hour bounds at submit time so closures added
  // between page load and submit are caught. The Zod schema validated the
  // weekday + 30-min slot already; here we only need to consult the DB.
  const slot = manilaSlotFor(new Date(parsed.data.scheduled_at));
  const { data: closure } = await admin
    .from("clinic_closures")
    .select("closed_on")
    .eq("closed_on", slot.dateISO)
    .maybeSingle();
  if (closure) {
    return { ok: false, error: "That day is closed. Please pick another." };
  }

  // Create the patient as pre-registered. Reception verifies on arrival.
  const { data: patient, error: patientErr } = await admin
    .from("patients")
    .insert({
      first_name: parsed.data.first_name,
      last_name: parsed.data.last_name,
      middle_name: parsed.data.middle_name,
      birthdate: parsed.data.birthdate,
      sex: parsed.data.sex,
      phone: parsed.data.phone,
      email: parsed.data.email,
      address: parsed.data.address,
      pre_registered: true,
    })
    .select("id, drm_id")
    .single();

  if (patientErr || !patient) {
    return {
      ok: false,
      error: patientErr?.message ?? "Could not save your details.",
    };
  }

  const { data: appointment, error: apptErr } = await admin
    .from("appointments")
    .insert({
      patient_id: patient.id,
      service_id: parsed.data.service_id,
      physician_id: parsed.data.physician_id,
      scheduled_at: parsed.data.scheduled_at,
      notes: parsed.data.notes,
      status: "confirmed",
    })
    .select("id")
    .single();

  if (apptErr || !appointment) {
    return {
      ok: false,
      error: apptErr?.message ?? "Could not save your appointment.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: null,
    actor_type: "anonymous",
    patient_id: patient.id,
    action: "appointment.booked",
    resource_type: "appointment",
    resource_id: appointment.id,
    metadata: {
      drm_id: patient.drm_id,
      service_id: parsed.data.service_id,
      service_name: service.name,
      scheduled_at: parsed.data.scheduled_at,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  // Fire-and-forget. Failures are audit-logged inside.
  try {
    await notifyAppointmentBooked({
      appointmentId: appointment.id,
      patientId: patient.id,
    });
  } catch (err) {
    console.error("notifyAppointmentBooked threw", err);
  }

  return {
    ok: true,
    appointment_id: appointment.id,
    drm_id: patient.drm_id,
    scheduled_at: parsed.data.scheduled_at,
    service_name: service.name,
  };
}
