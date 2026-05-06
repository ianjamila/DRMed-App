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
        id, scheduled_at, walk_in_name, walk_in_phone,
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

  // pending_callback bookings (diagnostic packages, home service, by-appointment
  // doctors) have no scheduled_at — show a friendly placeholder so the SMS
  // and email don't render "Invalid Date".
  const when = appt.scheduled_at
    ? new Date(appt.scheduled_at).toLocaleString("en-PH", {
        dateStyle: "long",
        timeStyle: "short",
      })
    : "to be confirmed by reception";
  const serviceName = svc?.name ?? "your appointment";
  const cancelUrl = `${SITE.url.replace(/\/$/, "")}/appointments/cancel/${appt.id}`;

  const smsBody =
    `Hi ${greeting}, your DRMed booking for ${serviceName} on ${when} is confirmed. ` +
    `Cancel: ${cancelUrl} — DRMED`;

  const emailSubject = `Booking confirmed — ${serviceName} on ${when}`;
  const emailText = [
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
