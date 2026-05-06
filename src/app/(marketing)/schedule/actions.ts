"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import {
  BookingSchema,
  manilaSlotFor,
} from "@/lib/validations/booking";
import { notifyAppointmentBooked } from "@/lib/notifications/notify-appointment-booked";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import {
  dayWindowFor,
  minutesOfDay,
} from "@/lib/physicians/availability";

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
// - Per-IP rate limit (Phase 8)
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

  const headerStore = await headers();
  const requestIp =
    headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  if (requestIp) {
    const limit = await checkRateLimit({
      bucket: "public_booking",
      identifier: requestIp,
      ...RATE_LIMITS.public_booking,
    });
    if (!limit.allowed) {
      return {
        ok: false,
        error: `Too many booking attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes, or call reception.`,
      };
    }
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

  // Physician-specific guard: the slot picker filters client-side, but a
  // determined caller could submit any time, so re-validate against the
  // physician's recurring schedule + per-day overrides + concurrent
  // bookings. Only runs when a physician was picked (lab branch leaves
  // physician_id null and skips this).
  if (parsed.data.physician_id) {
    const [
      { data: blocks },
      { data: overrides },
      { data: existingBookings },
    ] = await Promise.all([
      admin
        .from("physician_schedules")
        .select("day_of_week, start_time, end_time")
        .eq("physician_id", parsed.data.physician_id),
      admin
        .from("physician_schedule_overrides")
        .select("override_on, start_time, end_time")
        .eq("physician_id", parsed.data.physician_id)
        .eq("override_on", slot.dateISO),
      admin
        .from("appointments")
        .select("id")
        .eq("physician_id", parsed.data.physician_id)
        .eq("scheduled_at", parsed.data.scheduled_at)
        .not("status", "in", "(cancelled,no_show)"),
    ]);

    const window = dayWindowFor(slot.dateISO, slot.dayOfWeek, {
      blocks: blocks ?? [],
      overrides: overrides ?? [],
    });
    if (!window.available) {
      return {
        ok: false,
        error:
          window.reason === "full_day_override"
            ? "The doctor is unavailable that day. Please pick another slot."
            : "The doctor isn't scheduled that day. Please pick another slot.",
      };
    }
    const slotMinutes = slot.hour * 60 + slot.minute;
    const startMin = window.start_time
      ? minutesOfDay(window.start_time)
      : 8 * 60;
    const endMin = window.end_time
      ? minutesOfDay(window.end_time)
      : 16 * 60 + 30;
    if (slotMinutes < startMin || slotMinutes >= endMin) {
      return {
        ok: false,
        error: "That time is outside the doctor's hours. Please pick another.",
      };
    }
    if (existingBookings && existingBookings.length > 0) {
      return {
        ok: false,
        error: "That slot was just taken. Please pick another time.",
      };
    }
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
    ip_address: requestIp,
    user_agent: headerStore.get("user-agent"),
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
