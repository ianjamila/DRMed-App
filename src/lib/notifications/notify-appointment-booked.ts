import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { SITE } from "@/lib/marketing/site";
import { sendEmail } from "./email";
import { sendSms } from "./sms";

interface Input {
  appointmentId: string;
  patientId: string | null;
}

// Sends the booking confirmation. Failures are audit-logged but never thrown
// — the appointment row is the source of truth, not the SMS/email delivery.
export async function notifyAppointmentBooked({
  appointmentId,
  patientId,
}: Input): Promise<void> {
  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select(
      `
        id, scheduled_at, status, walk_in_name, walk_in_phone,
        services ( name ),
        patients ( first_name, phone, email )
      `,
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (!appt) return;
  const svc = Array.isArray(appt.services) ? appt.services[0] : appt.services;
  const patient = Array.isArray(appt.patients)
    ? appt.patients[0]
    : appt.patients;

  const greeting = patient?.first_name ?? appt.walk_in_name ?? "there";
  const phone = patient?.phone ?? appt.walk_in_phone ?? null;
  const email = patient?.email ?? null;
  const serviceName = svc?.name ?? "your appointment";
  const cancelUrl = `${SITE.url.replace(/\/$/, "")}/appointments/cancel/${appt.id}`;

  // pending_callback bookings (diagnostic packages, home service, by-appointment
  // doctors) have no scheduled_at and aren't confirmed yet. Reception calls
  // the patient to confirm — the email/SMS should match that flow rather
  // than claim the booking is confirmed.
  const isPendingCallback = appt.status === "pending_callback";

  let smsBody: string;
  let emailSubject: string;
  let emailText: string;

  if (isPendingCallback) {
    smsBody =
      `Hi ${greeting}, we got your DRMed request for ${serviceName}. ` +
      `Reception will call within one working day to confirm. ` +
      `Cancel: ${cancelUrl} — DRMED`;
    emailSubject = `Request received — ${serviceName}`;
    emailText = [
      `Hi ${greeting},`,
      "",
      `Thanks for your request with DRMed Clinic and Laboratory.`,
      "",
      `Service: ${serviceName}`,
      `Status: Reception will call within one working day to confirm a date and time.`,
      "",
      `Need to cancel? Open this link:`,
      `  ${cancelUrl}`,
      "",
      `Bring a valid ID on the day of your visit. For HMO, please bring your card.`,
      "",
      "— DRMed Clinic and Laboratory",
    ].join("\n");
  } else {
    const when = appt.scheduled_at
      ? new Date(appt.scheduled_at).toLocaleString("en-PH", {
          dateStyle: "long",
          timeStyle: "short",
        })
      : "your selected time";
    smsBody =
      `Hi ${greeting}, your DRMed booking for ${serviceName} on ${when} is confirmed. ` +
      `Cancel: ${cancelUrl} — DRMED`;
    emailSubject = `Booking confirmed — ${serviceName} on ${when}`;
    emailText = [
      `Hi ${greeting},`,
      "",
      `Your DRMed Clinic and Laboratory booking is confirmed.`,
      "",
      `Service: ${serviceName}`,
      `Date / time: ${when}`,
      "",
      `Need to cancel or reschedule? Open this link:`,
      `  ${cancelUrl}`,
      "",
      `Bring a valid ID. For HMO, please bring your card.`,
      "",
      "— DRMed Clinic and Laboratory",
    ].join("\n");
  }

  const [smsResult, emailResult] = await Promise.all([
    phone
      ? sendSms({ to: phone, message: smsBody })
      : Promise.resolve({
          ok: false as const,
          kind: "skipped" as const,
          reason: "no phone on appointment",
        }),
    email
      ? sendEmail({ to: email, subject: emailSubject, text: emailText })
      : Promise.resolve({
          ok: false as const,
          kind: "skipped" as const,
          reason: "no email on appointment",
        }),
  ]);

  await audit({
    actor_id: null,
    actor_type: "system",
    patient_id: patientId,
    action: "appointment.booked.notified",
    resource_type: "appointment",
    resource_id: appointmentId,
    metadata: {
      sms: smsResult.ok
        ? { ok: true, id: smsResult.id }
        : smsResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: smsResult.reason }
          : { ok: false, error: smsResult.error },
      email: emailResult.ok
        ? { ok: true, id: emailResult.id }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error },
    },
  });
}
