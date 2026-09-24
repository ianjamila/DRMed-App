import "server-only";

// Tells staff a patient booked online (Admin Tools › Email Alerts, alert key
// `online_booking`, 0157). Called from submitBookingAction via after(), so it
// runs once the patient already has their confirmation and can never slow or
// fail the booking. Recipients come from resolveStaffAlertRecipients() —
// reception + admin by default. Sends only in production (or
// NOTIFICATIONS_LIVE=true); that gate lives in sendEmail.
//
// Audited once per booking group as appointment.booked.staff_alert_sent —
// recipient counts only, never addresses. See booking-alert-content.ts for
// what the email may and may not say.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/notifications/email";
import { resolveStaffAlertRecipients } from "@/lib/notifications/staff-alert-recipients";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { SITE } from "@/lib/marketing/site";
import type { BookingBranch } from "@/lib/validations/booking";
import { buildBookingAlertEmail } from "./booking-alert-content";

export interface NewBookingAlertInput {
  bookingGroupId: string;
  /** Used to look up the first name when the form did not carry one (an existing patient). */
  patientId: string | null;
  firstName: string | null;
  branch: BookingBranch;
  scheduledAtIso: string | null;
  pendingCallback: boolean;
  serviceCount: number;
  via: "website" | "portal";
}

/** Never throws — an alert failure must not surface anywhere near the patient. */
export async function sendNewBookingAlert(input: NewBookingAlertInput): Promise<void> {
  try {
    const admin = createAdminClient();
    let firstName = input.firstName;
    if (!firstName && input.patientId) {
      const { data } = await admin.from("patients").select("first_name").eq("id", input.patientId).maybeSingle();
      firstName = data?.first_name ?? null;
    }

    const recipients = await resolveStaffAlertRecipients("online_booking", admin);
    const content = buildBookingAlertEmail({
      firstName,
      branch: input.branch,
      scheduledAtIso: input.scheduledAtIso,
      pendingCallback: input.pendingCallback,
      serviceCount: input.serviceCount,
      via: input.via,
      appointmentsUrl: `${SITE.url.replace(/\/$/, "")}/staff/appointments`,
    });

    let sent = 0;
    let failed = 0;
    let skipped: string | null = null;
    if (recipients.emails.length === 0) {
      skipped = recipients.enabled
        ? "nobody is switched on for this alert in Email Alerts"
        : "turned off in Email Alerts";
    } else {
      for (const to of recipients.emails) {
        const result = await sendEmail({ to, subject: content.subject, text: content.text, html: content.html });
        if (result.ok) sent += 1;
        else if (result.kind === "skipped") skipped = skipped ?? result.reason;
        else failed += 1;
      }
    }

    await audit({
      actor_id: null,
      actor_type: "system",
      action: "appointment.booked.staff_alert_sent",
      resource_type: "appointment_group",
      resource_id: input.bookingGroupId,
      metadata: {
        recipients: recipients.emails.length,
        sent,
        failed,
        via: input.via,
        pending_callback: input.pendingCallback,
        ...(skipped ? { skipped } : {}),
      },
    });
  } catch (error) {
    try {
      await reportError({ scope: "appointments/booking-alert", error, metadata: { bookingGroupId: input.bookingGroupId } });
    } catch {
      // Reporting itself failed — nothing further to do.
    }
  }
}
