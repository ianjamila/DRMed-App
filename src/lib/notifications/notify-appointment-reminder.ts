import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { SITE } from "@/lib/marketing/site";
import { sendEmail } from "./email";
import { buildReminderEmail } from "./reminder-email";

interface Input {
  appointmentId: string;
  patientId: string | null;
}

export interface ReminderResult {
  emailed: boolean;
  reason?: string;
}

// Sends the day-before reminder. Email-only (per the email-only notifications
// decision). Failures are audit-logged but never thrown — the appointment row
// is the source of truth, not delivery.
export async function notifyAppointmentReminder({
  appointmentId,
  patientId,
}: Input): Promise<ReminderResult> {
  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select(
      `
        id, scheduled_at, status, booking_group_id, walk_in_name,
        services ( name ),
        patients ( first_name, email )
      `,
    )
    .eq("id", appointmentId)
    .maybeSingle();

  if (!appt) return { emailed: false, reason: "appointment not found" };

  const svc = Array.isArray(appt.services) ? appt.services[0] : appt.services;
  const patient = Array.isArray(appt.patients)
    ? appt.patients[0]
    : appt.patients;

  const greeting = patient?.first_name ?? appt.walk_in_name ?? "there";
  const email = patient?.email ?? null;
  const serviceName = svc?.name ?? "your appointment";
  const when = appt.scheduled_at
    ? new Date(appt.scheduled_at).toLocaleString("en-PH", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "Asia/Manila",
      })
    : "your scheduled time";
  const cancelUrl = `${SITE.url.replace(/\/$/, "")}/appointments/cancel/${appt.id}`;

  // Does this booking group carry an uploaded request form?
  let hasForm = false;
  if (appt.booking_group_id) {
    const { count } = await admin
      .from("appointment_attachments")
      .select("id", { count: "exact", head: true })
      .eq("booking_group_id", appt.booking_group_id);
    hasForm = (count ?? 0) > 0;
  }

  if (!email) {
    await audit({
      actor_id: null,
      actor_type: "system",
      patient_id: patientId,
      action: "appointment.reminder.sent",
      resource_type: "appointment",
      resource_id: appointmentId,
      metadata: { email: { ok: false, skipped: true, reason: "no email" }, has_form: hasForm },
    });
    return { emailed: false, reason: "no email" };
  }

  const { subject, text, html } = buildReminderEmail({
    greeting,
    serviceName,
    when,
    cancelUrl,
    hasForm,
  });
  const emailResult = await sendEmail({ to: email, subject, text, html });

  await audit({
    actor_id: null,
    actor_type: "system",
    patient_id: patientId,
    action: "appointment.reminder.sent",
    resource_type: "appointment",
    resource_id: appointmentId,
    metadata: {
      email: emailResult.ok
        ? { ok: true, id: emailResult.id, to: email }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error, to: email },
      has_form: hasForm,
    },
  });

  return { emailed: emailResult.ok, reason: emailResult.ok ? undefined : "send failed" };
}
