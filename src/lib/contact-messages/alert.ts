import "server-only";

// Notifies staff a new website message arrived. Called from the /contact
// server action after a successful insert — wrapped there so a failure here
// can never fail the visitor's submission (see the call site).
//
// Recipients: whoever Admin Tools › Email Alerts has switched on for the
// "website_message" alert (0155) — by default every ACTIVE reception + admin
// account, plus any extra addresses an admin added — resolved by
// resolveStaffAlertRecipients(). An admin can also turn the alert off there.
// Sends only in production (or
// NOTIFICATIONS_LIVE=true), via the shared sendEmail() — that gate lives in
// sendEmail itself, so this module doesn't duplicate it.
//
// Audited once per message, regardless of outcome, as
// contact_message.alert_sent — recipient COUNTS only, never addresses.

import { resolveStaffAlertRecipients } from "@/lib/notifications/staff-alert-recipients";
import { sendEmail } from "@/lib/notifications/email";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { SITE } from "@/lib/marketing/site";
import type { Json } from "@/types/database";
import type { ContactFormLocation, ContactMessageKind } from "./labels";
import { buildAlertEmail } from "./alert-content";

export interface NewMessageAlertInput {
  id: string;
  name: string;
  subject: string | null;
  kind: ContactMessageKind;
  formLocation: ContactFormLocation | null;
  createdAt: string; // ISO timestamptz
}

/** Send the new-message alert and audit-log the outcome. Never throws — a
 * notification failure must not surface as a form-submission failure. */
export async function sendNewMessageAlert(input: NewMessageAlertInput): Promise<void> {
  try {
    const recipients = await resolveStaffAlertRecipients("website_message");
    const { emails } = recipients;
    const messageUrl = `${SITE.url.replace(/\/$/, "")}/staff/messages/${input.id}`;
    const content = buildAlertEmail({
      name: input.name,
      subject: input.subject,
      kind: input.kind,
      formLocation: input.formLocation,
      createdAt: input.createdAt,
      messageUrl,
    });

    let sent = 0;
    let failed = 0;
    let skipped: string | null = null;

    if (emails.length === 0) {
      skipped = recipients.enabled
        ? "nobody is switched on for this alert in Email Alerts"
        : "turned off in Email Alerts";
    } else {
      for (const to of emails) {
        const result = await sendEmail({ to, subject: content.subject, text: content.text, html: content.html });
        if (result.ok) {
          sent += 1;
        } else if (result.kind === "skipped") {
          // sendEmail no-ops outside production (or without NOTIFICATIONS_LIVE) —
          // record that once rather than per-recipient.
          skipped = skipped ?? result.reason;
        } else {
          failed += 1;
        }
      }
    }

    await audit({
      actor_id: null,
      actor_type: "system",
      action: "contact_message.alert_sent",
      resource_type: "contact_message",
      resource_id: input.id,
      metadata: {
        recipients: emails.length,
        sent,
        failed,
        ...(skipped ? { skipped } : {}),
      } as unknown as Json,
    });
  } catch (error) {
    // Documented as "never throws": it runs inside after(), where a rejection
    // would only surface as an unhandled error. Report it instead, so a broken
    // alert is visible rather than silently leaving messages unannounced.
    try {
      await reportError({ scope: "contact-message/alert", error, metadata: { messageId: input.id } });
    } catch {
      // Reporting itself failed — nothing further to do.
    }
  }
}
