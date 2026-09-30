import "server-only";

// Tells reception the lab released results (Admin Tools › Email Alerts, alert
// key `result_released`, 0192) so the counter can print them for a waiting
// patient. Scheduled from releaseVisitSelection (queue + visit-page releases)
// and from finalise-consolidated when it releases a whole report itself.
// Runs via after(), so it never delays a release and can never fail one.
// Sends only in production (or NOTIFICATIONS_LIVE=true); that gate lives in
// sendEmail.
//
// Audited once per release action as test_request.released.staff_alert_sent —
// recipient counts only, never addresses. See release-staff-alert-content.ts
// for what the email may and may not say.

import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "./email";
import { resolveStaffAlertRecipients } from "./staff-alert-recipients";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { SITE } from "@/lib/marketing/site";
import { buildReleaseAlertEmail } from "./release-staff-alert-content";

/**
 * Queue the reception "Results released" email for one release action on one
 * visit. Runs after the response (never delays the release), never throws.
 * `count` = rows actually announced (verified released: plain rows, or a
 * combined report confirmed complete) — callers pass releaseVisitSelection's
 * `announced.length`, never the selection size.
 */
export function scheduleReleaseStaffAlert(visitId: string, count: number): void {
  if (count <= 0) return;
  after(() => sendReleaseStaffAlert(visitId, count));
}

const SENT_ACTION = "test_request.released.staff_alert_sent";

async function auditSkipped(visitId: string, count: number, skipped: string): Promise<void> {
  await audit({
    actor_id: null,
    actor_type: "system",
    action: SENT_ACTION,
    resource_type: "visit",
    resource_id: visitId,
    metadata: { recipients: 0, sent: 0, failed: 0, count, skipped },
  });
}

/** Never throws — an alert failure must not surface anywhere near the release. */
async function sendReleaseStaffAlert(visitId: string, count: number): Promise<void> {
  try {
    const admin = createAdminClient();
    // LIVE read at query level: this runs after the response, so the caller's
    // earlier check that the visit was live is not enough.
    const { data: visit, error } = await admin
      .from("visits")
      .select("id, visit_number, is_sample, patients ( first_name, last_name )")
      .eq("id", visitId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) {
      await reportError({ scope: "notify/result-released-staff-alert", error, metadata: { visitId } });
      return;
    }
    if (!visit) {
      await auditSkipped(visitId, count, "visit deleted or missing");
      return;
    }
    if (visit.is_sample) {
      await auditSkipped(visitId, count, "sample visit");
      return;
    }

    const recipients = await resolveStaffAlertRecipients("result_released", admin);
    const content = buildReleaseAlertEmail({
      firstName: visit.patients?.first_name ?? null,
      lastName: visit.patients?.last_name ?? null,
      visitNumber: visit.visit_number,
      count,
      visitUrl: `${SITE.url.replace(/\/$/, "")}/staff/visits/${visitId}`,
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
      action: SENT_ACTION,
      resource_type: "visit",
      resource_id: visitId,
      metadata: { recipients: recipients.emails.length, sent, failed, count, ...(skipped ? { skipped } : {}) },
    });
  } catch (error) {
    try {
      await reportError({ scope: "notify/result-released-staff-alert", error, metadata: { visitId } });
    } catch {
      // Reporting itself failed — nothing further to do.
    }
  }
}
