"use server";

import { headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";
import {
  BookingSchema,
  ExistingPatientBookingSchema,
  PatientLookupSchema,
  manilaSlotFor,
  type BookingInput,
  type ExistingPatientBookingInput,
} from "@/lib/validations/booking";
import { notifyAppointmentBooked } from "@/lib/notifications/notify-appointment-booked";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import {
  dayWindowFor,
  minutesOfDay,
} from "@/lib/physicians/availability";

export type BookingResult =
  | {
      ok: true;
      drm_id: string;
      service_summary: string;
      scheduled_at: string | null;
      pending_callback: boolean;
      booking_group_id: string;
    }
  | { ok: false; error: string };

const HONEYPOT_OK: BookingResult = {
  ok: true,
  drm_id: "",
  service_summary: "",
  scheduled_at: null,
  pending_callback: false,
  booking_group_id: "",
};

// Allowed `services.kind` per branch. Mirror this on the form so the
// catalog filter and the server agree.
const KINDS_PER_BRANCH: Record<string, ReadonlyArray<string>> = {
  diagnostic_package: ["lab_package"],
  lab_request: ["lab_test"],
  doctor_appointment: ["doctor_consultation"],
  home_service: ["lab_test", "lab_package"],
};

interface AdminClient {
  rpc: ReturnType<typeof createAdminClient>["rpc"];
  from: ReturnType<typeof createAdminClient>["from"];
}

interface ServiceRow {
  id: string;
  name: string;
  kind: string;
  is_active: boolean;
  fasting_required: boolean;
  requires_time_slot: boolean;
  allow_concurrent: boolean;
}

async function loadServices(
  admin: AdminClient,
  ids: ReadonlyArray<string>,
): Promise<{ ok: true; rows: ServiceRow[] } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: false, error: "Pick at least one service." };
  const { data, error } = await admin
    .from("services")
    .select(
      "id, name, kind, is_active, fasting_required, requires_time_slot, allow_concurrent",
    )
    .in("id", ids);
  if (error) return { ok: false, error: error.message };
  if (!data || data.length !== ids.length) {
    return { ok: false, error: "One or more services are no longer available." };
  }
  for (const r of data) {
    if (!r.is_active) {
      return {
        ok: false,
        error: "One of the selected services is no longer active.",
      };
    }
  }
  return { ok: true, rows: data };
}

export type LookupPatientResult =
  | {
      ok: true;
      patient: {
        id: string;
        drm_id: string;
        first_name: string;
        last_name: string;
      };
    }
  | { ok: false; error: string };

// Sanitised lookup used by the "Are you an existing patient?" flow on
// /schedule. Returns enough to display "Booking as <First> <Last> ·
// DRM-XXXX" but no contact info — the booking action looks up the rest
// server-side from the patient_id, so a leaked patient_id from this
// response can't be enriched into a PII payload.
export async function lookupPatientAction(
  _prev: LookupPatientResult | null,
  formData: FormData,
): Promise<LookupPatientResult> {
  const headerStore = await headers();
  const requestIp =
    headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headerStore.get("user-agent");

  if (requestIp) {
    const limit = await checkRateLimit({
      bucket: "patient_lookup",
      identifier: requestIp,
      ...RATE_LIMITS.patient_lookup,
    });
    if (!limit.allowed) {
      return {
        ok: false,
        error: `Too many lookups. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes, or call reception.`,
      };
    }
  }

  const parsed = PatientLookupSchema.safeParse({
    drm_id: formData.get("drm_id"),
    last_name: formData.get("last_name"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Please check the fields.",
    };
  }

  const drmId = parsed.data.drm_id.toUpperCase();
  const admin = createAdminClient();
  const { data: row } = await admin
    .from("patients")
    .select("id, drm_id, first_name, last_name")
    .eq("drm_id", drmId)
    .ilike("last_name", parsed.data.last_name)
    .maybeSingle();

  // Audit every attempt — successful or not — so abuse can be reviewed.
  await audit({
    actor_id: null,
    actor_type: "anonymous",
    patient_id: row?.id ?? null,
    action: row ? "patient.lookup.matched" : "patient.lookup.no_match",
    resource_type: "patient",
    resource_id: row?.id ?? null,
    metadata: {
      drm_id_attempted: drmId,
      last_name_attempted: parsed.data.last_name,
    },
    ip_address: requestIp,
    user_agent: userAgent,
  });

  if (!row) {
    return {
      ok: false,
      error:
        "We couldn't find a patient with that DRM-ID and last name. Double-check the receipt, or book as a new patient.",
    };
  }
  return {
    ok: true,
    patient: {
      id: row.id,
      drm_id: row.drm_id,
      first_name: row.first_name,
      last_name: row.last_name,
    },
  };
}

async function resolvePatient(
  admin: AdminClient,
  data: {
    first_name: string;
    last_name: string;
    middle_name: string | null;
    birthdate: string;
    sex: "male" | "female" | null;
    phone: string;
    email: string;
    address: string | null;
  },
): Promise<
  | { ok: true; id: string; drm_id: string; reused: boolean }
  | { ok: false; error: string }
> {
  // Silent dedup: if a patient already exists with the same
  // (lower(email), last_name, birthdate), reuse them instead of
  // creating another row. Match is intentionally strict — these three
  // together rarely collide for unrelated people and a family member
  // would differ on at least last_name or birthdate. We do NOT
  // overwrite the existing row's contact fields; whatever reception
  // verified in person stays authoritative.
  // Trigger trg_patients_normalise_email keeps stored emails lowercase
  // so equality lookup hits idx_patients_dedup_lookup directly.
  const lowerEmail = data.email.trim().toLowerCase();
  const { data: existing } = await admin
    .from("patients")
    .select("id, drm_id")
    .eq("email", lowerEmail)
    .eq("last_name", data.last_name)
    .eq("birthdate", data.birthdate)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      ok: true,
      id: existing.id,
      drm_id: existing.drm_id,
      reused: true,
    };
  }

  const { data: patient, error } = await admin
    .from("patients")
    .insert({ ...data, pre_registered: true })
    .select("id, drm_id")
    .single();
  if (error || !patient) {
    return { ok: false, error: error?.message ?? "Could not save your details." };
  }
  return { ok: true, id: patient.id, drm_id: patient.drm_id, reused: false };
}

async function maybeSubscribe(
  admin: AdminClient,
  email: string,
  ipAddress: string | null,
): Promise<void> {
  const lower = email.trim().toLowerCase();
  if (!lower) return;
  const { data: existing } = await admin
    .from("subscribers")
    .select("id, unsubscribed_at")
    .eq("email", lower)
    .maybeSingle();
  if (existing) {
    if (existing.unsubscribed_at !== null) {
      // Re-subscribe: refresh consent but preserve the original `source`
      // so first-touch attribution survives. Overwriting it would flip
      // e.g. a homepage_footer subscriber to schedule_form on every
      // re-subscribe, masking how they originally found us.
      await admin
        .from("subscribers")
        .update({
          unsubscribed_at: null,
          consent_at: new Date().toISOString(),
          consent_ip: ipAddress,
        })
        .eq("id", existing.id);
    }
    return;
  }
  await admin
    .from("subscribers")
    .insert({ email: lower, source: "schedule_form", consent_ip: ipAddress });
}

export async function submitBookingAction(
  _prev: BookingResult | null,
  formData: FormData,
): Promise<BookingResult> {
  if ((formData.get("website") ?? "") !== "") {
    return HONEYPOT_OK;
  }

  const headerStore = await headers();
  const requestIp =
    headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headerStore.get("user-agent");

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

  const branch = formData.get("branch");
  const sourceInput = formData.get("source");
  const isPortalSource = sourceInput === "portal";

  // Portal-sourced submissions ignore any client-supplied patient_id and
  // re-derive it from the patient session cookie. A logged-in patient
  // can't book against another patient by tampering with the form, even
  // if they bypass the UI.
  let resolvedPatientIdFromSession: string | null = null;
  if (isPortalSource) {
    const session = await getPatientSession();
    if (!session) {
      return {
        ok: false,
        error: "Your session expired. Please sign in again.",
      };
    }
    resolvedPatientIdFromSession = session.patient_id;
  }

  const patientIdInput = isPortalSource
    ? resolvedPatientIdFromSession
    : (formData.get("patient_id") as string | null);
  const isExistingPatient =
    typeof patientIdInput === "string" && patientIdInput.length > 0;

  // Two parsing paths share most fields. New-patient parse pulls every
  // personal-info field; existing-patient parse just needs patient_id +
  // booking payload + consent — the patient row supplies the rest.
  let data:
    | (BookingInput & { mode: "new" })
    | (ExistingPatientBookingInput & { mode: "existing" });
  if (isExistingPatient) {
    const parsed = ExistingPatientBookingSchema.safeParse({
      branch,
      patient_id: patientIdInput,
      // Portal patients have already accepted the service agreement at
      // intake; the form omits the checkbox so we synthesise consent
      // for validation. Marketing consent is still optional and read
      // from the form when present.
      notes: formData.get("notes") ?? "",
      marketing_consent: formData.get("marketing_consent") ?? "off",
      service_agreement: isPortalSource
        ? "on"
        : (formData.get("service_agreement") ?? "off"),
      service_id: formData.get("service_id"),
      service_ids: formData.getAll("service_ids"),
      physician_id: formData.get("physician_id") ?? "",
      scheduled_at: formData.get("scheduled_at") ?? "",
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Please check the form.",
      };
    }
    data = { ...parsed.data, mode: "existing" };
  } else {
    const parsed = BookingSchema.safeParse({
      branch,
      first_name: formData.get("first_name"),
      last_name: formData.get("last_name"),
      middle_name: formData.get("middle_name") ?? "",
      birthdate: formData.get("birthdate"),
      sex: formData.get("sex") ?? "",
      phone: formData.get("phone"),
      email: formData.get("email"),
      address: formData.get("address") ?? "",
      notes: formData.get("notes") ?? "",
      marketing_consent: formData.get("marketing_consent") ?? "off",
      service_agreement: formData.get("service_agreement") ?? "off",
      service_id: formData.get("service_id"),
      service_ids: formData.getAll("service_ids"),
      physician_id: formData.get("physician_id") ?? "",
      scheduled_at: formData.get("scheduled_at") ?? "",
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Please check the form.",
      };
    }
    data = { ...parsed.data, mode: "new" };
  }
  const admin = createAdminClient();

  // Resolve services for the branch.
  const allowedKinds = new Set(KINDS_PER_BRANCH[data.branch] ?? []);
  let services: ServiceRow[];
  if (data.branch === "doctor_appointment") {
    const res = await loadServices(admin, [data.service_id]);
    if (!res.ok) return res;
    services = res.rows;
  } else {
    const res = await loadServices(admin, data.service_ids);
    if (!res.ok) return res;
    services = res.rows;
  }
  for (const s of services) {
    if (!allowedKinds.has(s.kind)) {
      return {
        ok: false,
        error:
          "One of the selected services doesn't match this booking type. Reload and try again.",
      };
    }
  }

  // Decide whether this booking has a real time or is pending callback.
  // Rule per branch:
  //   diagnostic_package — always pending_callback (no slot required)
  //   home_service       — always pending_callback
  //   lab_request        — pending_callback unless any picked service has
  //                        requires_time_slot=true (then a slot is required)
  //   doctor_appointment — depends on the picked physician (resolved below)
  let pendingCallback: boolean;
  let scheduledAtIso: string | null;

  if (data.branch === "diagnostic_package" || data.branch === "home_service") {
    pendingCallback = true;
    scheduledAtIso = null;
  } else if (data.branch === "lab_request") {
    const slotRequired = services.some((s) => s.requires_time_slot);
    if (slotRequired) {
      if (!data.scheduled_at) {
        return {
          ok: false,
          error:
            "One of the selected tests needs a specific time slot. Please pick a date and time.",
        };
      }
      scheduledAtIso = data.scheduled_at;
      pendingCallback = false;
    } else {
      // Walk-in lab — confirmed without a specific time. Patients show
      // up during operating hours; reception sees the row in today's
      // queue and handles intake on arrival.
      pendingCallback = false;
      scheduledAtIso = null;
    }
  } else {
    // doctor_appointment — physician availability decides.
    const { data: physician } = await admin
      .from("physicians")
      .select("id, full_name, is_active")
      .eq("id", data.physician_id)
      .maybeSingle();
    if (!physician || !physician.is_active) {
      return { ok: false, error: "Selected physician is no longer available." };
    }
    const { data: blocks } = await admin
      .from("physician_schedules")
      .select("day_of_week, start_time, end_time")
      .eq("physician_id", data.physician_id);
    const isByAppointment = (blocks ?? []).length === 0;
    if (isByAppointment) {
      pendingCallback = true;
      scheduledAtIso = null;
    } else {
      if (!data.scheduled_at) {
        return { ok: false, error: "Please pick a date and time." };
      }
      // Server-side intersection with the doctor's schedule + overrides +
      // closures + concurrent bookings (if the service doesn't allow it).
      const slot = manilaSlotFor(new Date(data.scheduled_at));
      const [
        { data: closure },
        { data: overrides },
        { data: existingBookings },
      ] = await Promise.all([
        admin
          .from("clinic_closures")
          .select("closed_on")
          .eq("closed_on", slot.dateISO)
          .maybeSingle(),
        admin
          .from("physician_schedule_overrides")
          .select("override_on, start_time, end_time")
          .eq("physician_id", data.physician_id)
          .eq("override_on", slot.dateISO),
        admin
          .from("appointments")
          .select("id")
          .eq("physician_id", data.physician_id)
          .eq("scheduled_at", data.scheduled_at)
          .not("status", "in", "(cancelled,no_show)"),
      ]);
      if (closure) {
        return {
          ok: false,
          error: "That day is closed. Please pick another.",
        };
      }
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
          error:
            "That time is outside the doctor's hours. Please pick another.",
        };
      }
      const allowConcurrent = services[0]?.allow_concurrent ?? true;
      if (
        !allowConcurrent &&
        existingBookings &&
        existingBookings.length > 0
      ) {
        return {
          ok: false,
          error: "That slot was just taken. Please pick another time.",
        };
      }
      pendingCallback = false;
      scheduledAtIso = data.scheduled_at;
    }
  }

  // Resolve the patient. New-patient flow does silent dedup or insert.
  // Existing-patient flow trusts the patient_id (already proven via the
  // lookup action) but re-fetches the row to confirm it still exists
  // and to use the patient's authoritative email for notifications.
  let patientRes:
    | { ok: true; id: string; drm_id: string; email: string | null; resolution: "reused" | "created" | "existing" }
    | { ok: false; error: string };
  if (data.mode === "new") {
    const res = await resolvePatient(admin, {
      first_name: data.first_name,
      last_name: data.last_name,
      middle_name: data.middle_name,
      birthdate: data.birthdate,
      sex: data.sex,
      phone: data.phone,
      email: data.email,
      address: data.address,
    });
    if (!res.ok) {
      patientRes = res;
    } else {
      patientRes = {
        ok: true,
        id: res.id,
        drm_id: res.drm_id,
        email: data.email,
        resolution: res.reused ? "reused" : "created",
      };
    }
  } else {
    const { data: row } = await admin
      .from("patients")
      .select("id, drm_id, email")
      .eq("id", data.patient_id)
      .maybeSingle();
    if (!row) {
      patientRes = {
        ok: false,
        error: "We couldn't find that patient. Please look up again.",
      };
    } else {
      patientRes = {
        ok: true,
        id: row.id,
        drm_id: row.drm_id,
        email: row.email,
        resolution: "existing",
      };
    }
  }
  if (!patientRes.ok) return patientRes;

  // Insert one appointment per service, sharing a booking_group_id so
  // reception sees the multi-service request as one logical booking.
  const bookingGroupId = randomUUID();
  const status = pendingCallback ? "pending_callback" : "confirmed";
  const physicianId =
    data.branch === "doctor_appointment" ? data.physician_id : null;
  const homeServiceRequested = data.branch === "home_service";

  const apptRows = services.map((s) => ({
    patient_id: patientRes.id,
    service_id: s.id,
    physician_id: physicianId,
    scheduled_at: scheduledAtIso,
    notes: data.notes,
    status,
    booking_group_id: bookingGroupId,
    home_service_requested: homeServiceRequested,
  }));

  const { data: created, error: apptErr } = await admin
    .from("appointments")
    .insert(apptRows)
    .select("id");
  if (apptErr || !created || created.length !== apptRows.length) {
    return {
      ok: false,
      error: apptErr?.message ?? "Could not save your appointment.",
    };
  }

  // Audit-log once at the booking-group level so the trail isn't noisy.
  await audit({
    actor_id: null,
    actor_type: isPortalSource ? "patient" : "anonymous",
    patient_id: patientRes.id,
    action: "appointment.booked",
    resource_type: "appointment_group",
    resource_id: bookingGroupId,
    metadata: {
      drm_id: patientRes.drm_id,
      branch: data.branch,
      service_ids: services.map((s) => s.id),
      service_names: services.map((s) => s.name),
      pending_callback: pendingCallback,
      scheduled_at: scheduledAtIso,
      home_service_requested: homeServiceRequested,
      physician_id: physicianId,
      patient_resolution: patientRes.resolution,
      via: isPortalSource ? "portal" : "schedule",
    },
    ip_address: requestIp,
    user_agent: userAgent,
  });

  if (data.marketing_consent && patientRes.email) {
    await maybeSubscribe(admin, patientRes.email, requestIp);
  }

  // Fire-and-forget notification on the first appointment row only — one
  // email per booking is enough for the patient.
  try {
    await notifyAppointmentBooked({
      appointmentId: created[0]!.id,
      patientId: patientRes.id,
    });
  } catch (err) {
    console.error("notifyAppointmentBooked threw", err);
  }

  return {
    ok: true,
    drm_id: patientRes.drm_id,
    service_summary: services.map((s) => s.name).join(", "),
    scheduled_at: scheduledAtIso,
    pending_callback: pendingCallback,
    booking_group_id: bookingGroupId,
  };
}
