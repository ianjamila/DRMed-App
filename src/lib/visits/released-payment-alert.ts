import "server-only";

// Tells staff that a Delete, an Edit (amount reduced) or a Move left a visit
// owing money after work on it was completed — results released, doctor
// lines marked done (Admin Tools › Email Alerts, alert key
// `released_payment_removed`, 0178). Called via after() from the Delete,
// Edit and Move actions once they have committed, so it can never slow or
// fail them.
// Recipients come from resolveStaffAlertRecipients() — admin by default.
// Sends only in production (or NOTIFICATIONS_LIVE=true); that gate lives in
// sendEmail.
//
// Audited once per change as payment.released_removed_alert_sent — recipient
// counts only, never addresses. See released-payment-alert-content.ts for
// what the email may and may not say.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/notifications/email";
import { resolveStaffAlertRecipients } from "@/lib/notifications/staff-alert-recipients";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { SITE } from "@/lib/marketing/site";
import { buildReleasedPaymentAlertEmail, type ReleasedPaymentChange } from "./released-payment-alert-content";
import { releasedTotal, type ReleasedCounts } from "./payment-edit";

export interface ReleasedPaymentRemovedInput {
  paymentId: string;
  change: ReleasedPaymentChange;
  /** The visit the payment LEFT (for an edit: the visit it is on). */
  visitId: string;
  /** The payment as it was — for an edit, BEFORE the edit. */
  amountPhp: number;
  methodLabel: string;
  reasonLabel: string | null;
  movedToVisitNumber: string | null;
  editedTo: { amountPhp: number; methodLabel: string } | null;
  actorId: string;
  /** Completed work on the visit after the change (loadCompletedWorkCounts). */
  completed: ReleasedCounts;
}

/** Never throws — an alert failure must not surface anywhere near the counter. */
export async function sendReleasedPaymentRemovedAlert(input: ReleasedPaymentRemovedInput): Promise<void> {
  try {
    const admin = createAdminClient();
    const [{ data: visit }, { data: actor }] = await Promise.all([
      admin
        .from("visits")
        .select("visit_number, total_php, paid_php")
        .eq("id", input.visitId)
        .is("deleted_at", null)
        .maybeSingle(),
      admin.from("staff_profiles").select("full_name").eq("id", input.actorId).maybeSingle(),
    ]);
    if (!visit) return;
    const owes = Math.max((Math.round(Number(visit.total_php) * 100) - Math.round(Number(visit.paid_php) * 100)) / 100, 0);

    const recipients = await resolveStaffAlertRecipients("released_payment_removed", admin);
    const content = buildReleasedPaymentAlertEmail({
      change: input.change,
      visitNumber: visit.visit_number,
      amountPhp: input.amountPhp,
      methodLabel: input.methodLabel,
      reasonLabel: input.reasonLabel,
      movedToVisitNumber: input.movedToVisitNumber,
      editedTo: input.editedTo,
      byName: actor?.full_name ?? null,
      completed: input.completed,
      owesPhp: owes,
      visitUrl: `${SITE.url.replace(/\/$/, "")}/staff/visits/${input.visitId}`,
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
      action: "payment.released_removed_alert_sent",
      resource_type: "payment",
      resource_id: input.paymentId,
      metadata: {
        visit_id: input.visitId,
        change: input.change,
        released_count: input.completed.results,
        completed_work: releasedTotal(input.completed),
        owes_php: owes,
        recipients: recipients.emails.length,
        sent,
        failed,
        ...(skipped ? { skipped } : {}),
      },
    });
  } catch (error) {
    try {
      await reportError({ scope: "visits/released-payment-alert", error, metadata: { paymentId: input.paymentId } });
    } catch {
      // Reporting itself failed — nothing further to do.
    }
  }
}
