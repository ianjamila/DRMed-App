import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { SITE, CONTACT } from "@/lib/marketing/site";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { formatManilaDateTime } from "./format-manila-datetime";
import {
  renderEmailShell, emailParagraph, emailDetailBox, emailButton, emailFinePrint, escapeHtml,
} from "./branded-email";

interface Input {
  appointmentId: string;
  patientId: string | null;
}

// Sends the booking confirmation — email via Resend, plus SMS via Semaphore
// only if it's configured (it never has been in prod, so SMS is skipped in
// practice). Failures are audit-logged but never thrown — the appointment row
// is the source of truth, not delivery.
export async function notifyAppointmentBooked({
  appointmentId,
  patientId,
}: Input): Promise<void> {
  const admin = createAdminClient();
  const { data: appt } = await admin
    .from("appointments")
    .select(
      `
        id, scheduled_at, status, walk_in_name, walk_in_phone, booking_group_id,
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

  // Receipt note if the booking carried an uploaded doctor's request form.
  let formCount = 0;
  if (appt.booking_group_id) {
    const { count } = await admin
      .from("appointment_attachments")
      .select("id", { count: "exact", head: true })
      .eq("booking_group_id", appt.booking_group_id);
    formCount = count ?? 0;
  }
  const formNote =
    formCount > 0
      ? [
          "",
          `We received your doctor's request form (${formCount} file${formCount === 1 ? "" : "s"}).`,
        ]
      : [];

  // pending_callback bookings (diagnostic packages, home service, by-appointment
  // doctors) have no scheduled_at and aren't confirmed yet. Reception calls
  // the patient to confirm — the email/SMS should match that flow rather
  // than claim the booking is confirmed.
  const isPendingCallback = appt.status === "pending_callback";

  let smsBody: string;
  let emailSubject: string;
  let emailText: string;
  let emailHtml: string;

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
      ...formNote,
      "",
      `Need to cancel? Open this link:`,
      `  ${cancelUrl}`,
      "",
      `Bring a valid ID on the day of your visit. For HMO, please bring your card.`,
      "",
      "— DRMed Clinic and Laboratory",
    ].join("\n");
    emailHtml = renderEmailShell({
      heading: "Request received",
      contentHtml:
        emailParagraph(`Hi <b>${escapeHtml(greeting)}</b>,`) +
        emailParagraph("Thanks for your request with DRMed Clinic and Laboratory.") +
        emailDetailBox([
          { label: "Service", value: serviceName },
          { label: "Status", value: "Reception will call within one working day to confirm." },
        ]) +
        (formCount > 0 ? emailParagraph(`<span style="color:#0a7c44;">&#10003; We received your doctor's request form (${formCount} file${formCount === 1 ? "" : "s"}).</span>`) : "") +
        emailButton("Cancel this request", cancelUrl, "navy") +
        emailFinePrint("Bring a valid ID on the day of your visit. For HMO, please bring your card."),
    });
  } else {
    // scheduled_at is null for every walk-in lab booking (diagnostic
    // packages, and lab tests that don't require a slot) — that's the
    // NORMAL shape for this branch, not a missing value. L2: don't claim
    // the patient picked a time they never picked; tell them when the
    // clinic is actually open, from the one source of truth for hours
    // (CONTACT.hours), never a hardcoded copy of it.
    const when = appt.scheduled_at ? formatManilaDateTime(appt.scheduled_at) : null;
    const whenLine = when ?? `Walk in any time — ${CONTACT.hours}`;
    smsBody = when
      ? `Hi ${greeting}, your DRMed booking for ${serviceName} on ${when} is confirmed. ` +
        `Cancel: ${cancelUrl} — DRMED`
      : `Hi ${greeting}, your DRMed booking for ${serviceName} is confirmed. Walk in any time — ${CONTACT.hours}. ` +
        `Cancel: ${cancelUrl} — DRMED`;
    emailSubject = when
      ? `Booking confirmed — ${serviceName} on ${when}`
      : `Booking confirmed — ${serviceName}`;
    emailText = [
      `Hi ${greeting},`,
      "",
      `Your DRMed Clinic and Laboratory booking is confirmed.`,
      "",
      `Service: ${serviceName}`,
      `Date / time: ${whenLine}`,
      ...formNote,
      "",
      `Need to cancel or reschedule? Open this link:`,
      `  ${cancelUrl}`,
      "",
      `Bring a valid ID. For HMO, please bring your card.`,
      "",
      "— DRMed Clinic and Laboratory",
    ].join("\n");
    emailHtml = renderEmailShell({
      heading: "Your booking is confirmed",
      contentHtml:
        emailParagraph(`Hi <b>${escapeHtml(greeting)}</b>,`) +
        emailParagraph("Your DRMed Clinic and Laboratory booking is confirmed. Here are the details:") +
        emailDetailBox([
          { label: "Service", value: serviceName },
          { label: "Date / time", value: whenLine },
        ]) +
        (formCount > 0 ? emailParagraph(`<span style="color:#0a7c44;">&#10003; We received your doctor's request form (${formCount} file${formCount === 1 ? "" : "s"}).</span>`) : "") +
        emailButton("View or cancel booking", cancelUrl, "navy") +
        emailFinePrint("Bring a valid ID. For HMO, please bring your card."),
    });
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
      ? sendEmail({ to: email, subject: emailSubject, text: emailText, html: emailHtml })
      : Promise.resolve({
          ok: false as const,
          kind: "skipped" as const,
          reason: "no email on appointment",
        }),
  ]);

  if (!smsResult.ok && smsResult.kind === "error") {
    await reportError({
      scope: "notify/appointment-booked:sms",
      error: new Error(smsResult.error),
      metadata: { appointment_id: appointmentId },
    });
  }
  if (!emailResult.ok && emailResult.kind === "error") {
    await reportError({
      scope: "notify/appointment-booked:email",
      error: new Error(emailResult.error),
      metadata: { appointment_id: appointmentId },
    });
  }

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
        ? { ok: true, id: emailResult.id, to: email }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error, to: email },
    },
  });
}
