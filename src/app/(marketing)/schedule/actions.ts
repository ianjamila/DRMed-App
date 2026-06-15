"use server";

import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { getPatientSession } from "@/lib/auth/patient-session-cookies";
import {
  BookingSchema,
  ExistingPatientBookingSchema,
  PatientLookupSchema,
  type BookingInput,
  type ExistingPatientBookingInput,
} from "@/lib/validations/booking";
import { notifyAppointmentBooked } from "@/lib/notifications/notify-appointment-booked";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import { resolvePatient } from "@/lib/patients/resolve";
import { createAppointmentGroup, createLabRequestOnlyBooking, type PatientResolution } from "@/lib/appointments/create";
import type { ServiceRow } from "@/lib/appointments/timing";
import { validateLabRequestGate, parseIntakePreference } from "@/lib/appointments/lab-request";

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

type AdminClient = ReturnType<typeof createAdminClient>;

const LAB_REQUEST_BUCKET = "lab-request-forms";
const LAB_REQUEST_MAX_FILES = 5;
const LAB_REQUEST_MAX_BYTES = 10 * 1024 * 1024;
const LAB_REQUEST_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

type LabRequestFile = { file: File; bytes: Uint8Array };

// Pull + validate uploaded request-form files from the FormData. Metadata
// checks only (count/size/mime) — bytes are read for the later upload.
async function collectLabRequestFiles(
  formData: FormData,
): Promise<{ ok: true; files: LabRequestFile[] } | { ok: false; error: string }> {
  const raw = formData.getAll("lab_request_files").filter((v): v is File => v instanceof File && v.size > 0);
  if (raw.length === 0) return { ok: true, files: [] };
  if (raw.length > LAB_REQUEST_MAX_FILES) {
    return { ok: false, error: `Please attach at most ${LAB_REQUEST_MAX_FILES} files.` };
  }
  const files: LabRequestFile[] = [];
  for (const file of raw) {
    if (file.size > LAB_REQUEST_MAX_BYTES) {
      return { ok: false, error: "Each file must be 10 MB or smaller." };
    }
    if (!LAB_REQUEST_MIME.has(file.type)) {
      return { ok: false, error: "Upload a photo (JPG/PNG/HEIC) or PDF of your request form." };
    }
    files.push({ file, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return { ok: true, files };
}

// Best-effort upload + record. Booking already succeeded; never throw.
async function storeLabRequestFiles(
  admin: AdminClient,
  files: LabRequestFile[],
  bookingGroupId: string,
  patientId: string | null,
): Promise<void> {
  for (const { file, bytes } of files) {
    const path = `lab_requests/${bookingGroupId}/${crypto.randomUUID()}-${sanitizeFilename(file.name)}`;
    const { error: upErr } = await admin.storage
      .from(LAB_REQUEST_BUCKET)
      .upload(path, bytes, { contentType: file.type, upsert: false });
    if (upErr) {
      console.error("lab-request upload failed", upErr);
      continue;
    }
    const { error: insErr } = await admin.from("appointment_attachments").insert({
      booking_group_id: bookingGroupId,
      patient_id: patientId,
      storage_path: path,
      filename: sanitizeFilename(file.name),
      mime_type: file.type,
      size_bytes: file.size,
      kind: "lab_request",
    });
    if (insErr) {
      console.error("lab-request attachment insert failed", insErr);
      await admin.storage.from(LAB_REQUEST_BUCKET).remove([path]);
    }
  }
}

export type LookupPatientResult =
  | { ok: true; patient: { id: string; drm_id: string; first_name: string; last_name: string } }
  | { ok: false; error: string };

// Sanitised lookup for the "Are you an existing patient?" flow — returns enough
// to display "Booking as <First> <Last> · DRM-XXXX" but no contact info. The
// booking action re-derives the rest server-side from the patient_id, so a
// leaked patient_id from this response can't be enriched into a PII payload.
export async function lookupPatientAction(
  _prev: LookupPatientResult | null,
  formData: FormData,
): Promise<LookupPatientResult> {
  const headerStore = await headers();
  const requestIp = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headerStore.get("user-agent");

  if (requestIp) {
    const limit = await checkRateLimit({ bucket: "patient_lookup", identifier: requestIp, ...RATE_LIMITS.patient_lookup });
    if (!limit.allowed) {
      return { ok: false, error: `Too many lookups. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes, or call reception.` };
    }
  }

  const parsed = PatientLookupSchema.safeParse({ drm_id: formData.get("drm_id"), last_name: formData.get("last_name") });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the fields." };
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
    metadata: { drm_id_attempted: drmId, last_name_attempted: parsed.data.last_name },
    ip_address: requestIp,
    user_agent: userAgent,
  });

  if (!row) {
    return {
      ok: false,
      error: "We couldn't find a patient with that DRM-ID and last name. Double-check the receipt, or book as a new patient.",
    };
  }
  return { ok: true, patient: { id: row.id, drm_id: row.drm_id, first_name: row.first_name, last_name: row.last_name } };
}

async function maybeSubscribe(admin: AdminClient, email: string, ipAddress: string | null): Promise<void> {
  const lower = email.trim().toLowerCase();
  if (!lower) return;
  const { data: existing } = await admin.from("subscribers").select("id, unsubscribed_at").eq("email", lower).maybeSingle();
  if (existing) {
    if (existing.unsubscribed_at !== null) {
      // Re-subscribe: refresh consent but preserve original `source` so
      // first-touch attribution survives (don't flip it to schedule_form).
      await admin
        .from("subscribers")
        .update({ unsubscribed_at: null, consent_at: new Date().toISOString(), consent_ip: ipAddress })
        .eq("id", existing.id);
    }
    return;
  }
  await admin.from("subscribers").insert({ email: lower, source: "schedule_form", consent_ip: ipAddress });
}

export async function submitBookingAction(_prev: BookingResult | null, formData: FormData): Promise<BookingResult> {
  if ((formData.get("website") ?? "") !== "") {
    return HONEYPOT_OK;
  }

  const headerStore = await headers();
  const requestIp = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = headerStore.get("user-agent");

  const branch = formData.get("branch");
  const sourceInput = formData.get("source");
  const isPortalSource = sourceInput === "portal";

  // Portal submissions ignore any client-supplied patient_id and re-derive it
  // from the session cookie — a logged-in patient can't book against another.
  // Resolved before rate-limiting so the limit can be keyed per-patient.
  let resolvedPatientIdFromSession: string | null = null;
  if (isPortalSource) {
    const session = await getPatientSession();
    if (!session) return { ok: false, error: "Your session expired. Please sign in again." };
    resolvedPatientIdFromSession = session.patient_id;
  }

  // Identity-aware rate limiting. Authenticated portal patients are throttled
  // per-PATIENT (generous; abuse is bounded to their own record) so they're
  // never blocked by anonymous traffic sharing their IP. Anonymous /schedule
  // bookings keep the per-IP guard against bot mass-booking.
  const rateLimit = isPortalSource
    ? { bucket: "portal_booking" as const, identifier: resolvedPatientIdFromSession!, ...RATE_LIMITS.portal_booking }
    : requestIp
      ? { bucket: "public_booking" as const, identifier: requestIp, ...RATE_LIMITS.public_booking }
      : null;
  if (rateLimit) {
    const limit = await checkRateLimit(rateLimit);
    if (!limit.allowed) {
      return { ok: false, error: `Too many booking attempts. Try again in ${Math.ceil(limit.retryAfterSec / 60)} minutes, or call reception.` };
    }
  }

  const patientIdInput = isPortalSource ? resolvedPatientIdFromSession : (formData.get("patient_id") as string | null);
  const isExistingPatient = typeof patientIdInput === "string" && patientIdInput.length > 0;

  let data: (BookingInput & { mode: "new" }) | (ExistingPatientBookingInput & { mode: "existing" });
  if (isExistingPatient) {
    const parsed = ExistingPatientBookingSchema.safeParse({
      branch,
      patient_id: patientIdInput,
      // Portal patients accepted the service agreement at intake; the form omits
      // the checkbox so we synthesise consent for validation. Marketing consent
      // stays optional and is read from the form when present.
      notes: formData.get("notes") ?? "",
      marketing_consent: formData.get("marketing_consent") ?? "off",
      service_agreement: isPortalSource ? "on" : (formData.get("service_agreement") ?? "off"),
      service_id: formData.get("service_id"),
      service_ids: formData.getAll("service_ids"),
      physician_id: formData.get("physician_id") ?? "",
      scheduled_at: formData.get("scheduled_at") ?? "",
    });
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
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
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
    data = { ...parsed.data, mode: "new" };
  }

  // Doctor's request-form upload (non-doctor branches only). Validate file
  // metadata before any DB work so a bad file never creates a booking.
  const isNonDoctor = data.branch !== "doctor_appointment";
  const collected: { ok: true; files: LabRequestFile[] } | { ok: false; error: string } = isNonDoctor
    ? await collectLabRequestFiles(formData)
    : { ok: true, files: [] };
  if (!collected.ok) return { ok: false, error: collected.error };
  const labRequestFiles = collected.files;
  const intakePreference = parseIntakePreference(formData.get("intake_preference"));

  if (isNonDoctor) {
    const serviceCount = "service_ids" in data ? data.service_ids.length : 0;
    const gate = validateLabRequestGate({
      serviceCount,
      hasForm: labRequestFiles.length > 0,
      preference: intakePreference,
    });
    if (!gate.ok) return { ok: false, error: gate.error };
  }

  const admin = createAdminClient();
  const scheduledAt = "scheduled_at" in data ? (data.scheduled_at ?? null) : null;
  const serviceIds = data.branch === "doctor_appointment" ? [data.service_id] : data.service_ids;
  const physicianId = data.branch === "doctor_appointment" ? data.physician_id : null;

  // Patient resolution deferred so a failed timing/conflict check never creates a patient.
  const resolveThunk = async (): Promise<{ ok: true; patient: PatientResolution } | { ok: false; error: string }> => {
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
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, patient: { patientId: res.id, drmId: res.drm_id, email: data.email, resolution: res.reused ? "reused" : "created" } };
    }
    const { data: row } = await admin.from("patients").select("id, drm_id, email").eq("id", data.patient_id).maybeSingle();
    if (!row) return { ok: false, error: "We couldn't find that patient. Please look up again." };
    return { ok: true, patient: { patientId: row.id, drmId: row.drm_id, email: row.email, resolution: "existing" } };
  };

  const isFormOnly =
    isNonDoctor && serviceIds.filter((id): id is string => !!id).length === 0;

  const result = isFormOnly
    ? await createLabRequestOnlyBooking(admin, {
        branch: data.branch,
        intakePreference: intakePreference ?? "callback",
        notes: data.notes,
        createdBy: null,
        resolvePatient: resolveThunk,
      })
    : await createAppointmentGroup(admin, {
        branch: data.branch,
        serviceIds,
        physicianId,
        scheduledAt,
        notes: data.notes,
        createdBy: null,
        mode: "strict",
        override: false,
        resolvePatient: resolveThunk,
      });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  // Upload the form(s) now that we have a booking_group_id + resolved patient.
  if (labRequestFiles.length > 0) {
    await storeLabRequestFiles(
      admin,
      labRequestFiles,
      result.bookingGroupId,
      result.patient.patientId,
    );
  }

  const resultServices: ServiceRow[] = "services" in result ? (result.services as ServiceRow[]) : [];
  const scheduledAtIso: string | null = "scheduledAtIso" in result ? (result.scheduledAtIso as string | null) : null;
  const serviceSummary =
    resultServices.length > 0
      ? resultServices.map((s) => s.name).join(", ")
      : "Tests from your uploaded request form";

  // Audit once at the booking-group level so the trail isn't noisy.
  await audit({
    actor_id: null,
    actor_type: isPortalSource ? "patient" : "anonymous",
    patient_id: result.patient.patientId,
    action: "appointment.booked",
    resource_type: "appointment_group",
    resource_id: result.bookingGroupId,
    metadata: {
      drm_id: result.patient.drmId,
      branch: data.branch,
      service_ids: resultServices.map((s) => s.id),
      service_names: resultServices.map((s) => s.name),
      pending_callback: result.pendingCallback,
      scheduled_at: scheduledAtIso,
      home_service_requested: data.branch === "home_service",
      physician_id: physicianId,
      patient_resolution: result.patient.resolution,
      via: isPortalSource ? "portal" : "schedule",
      lab_request_attached: labRequestFiles.length > 0,
      lab_request_count: labRequestFiles.length,
      intake_preference: intakePreference,
    },
    ip_address: requestIp,
    user_agent: userAgent,
  });

  if (data.marketing_consent && result.patient.email) {
    await maybeSubscribe(admin, result.patient.email, requestIp);
  }

  // Fire-and-forget notification on the first appointment row only.
  try {
    await notifyAppointmentBooked({ appointmentId: result.appointmentIds[0]!, patientId: result.patient.patientId });
  } catch (err) {
    console.error("notifyAppointmentBooked threw", err);
  }

  return {
    ok: true,
    drm_id: result.patient.drmId ?? "",
    service_summary: serviceSummary,
    scheduled_at: scheduledAtIso,
    pending_callback: result.pendingCallback,
    booking_group_id: result.bookingGroupId,
  };
}
