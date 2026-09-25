import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { reportError } from "@/lib/observability/report-error";
import { sendEmail } from "@/lib/notifications/email";
import type { StatementData } from "@/lib/visits/statement-data";
import { renderStatementEmail } from "@/lib/visits/statement-email";
import { SAMPLE_NO_CONTACT_MESSAGE } from "@/lib/visits/sample";

export type SendStatementResult = { ok: true; data: { to: string } } | { ok: false; error: string };

export type StatementEmailActor =
  | { type: "staff"; userId: string }
  | { type: "patient"; drmId: string };

// A second send of the same statement to the same address inside this
// window is a duplicate (double-click, second tab, second receptionist, or
// the patient pressing "Email it to me" twice).
export const RESEND_GUARD_MINUTES = 2;

/**
 * Email a loaded statement of account to the address on the patient's record.
 *
 * The one send path for both doors — reception/admin on the staff statement
 * (src/lib/actions/visits/email-statement.ts) and the patient in the portal
 * (…/portal/…/statement/email-action.ts). Each caller authorises and loads
 * `data` through its own RLS-scoped client first; this only ever sends to
 * `data.patient.email`, so there is no recipient to tamper with.
 *
 * Service-role use, and why: `claim_statement_email` (0177) and
 * `rate_limit_attempts` are service-role only, as is the audit writer. The
 * claim is advisory-locked and keyed on visit + recipient — whoever sends —
 * so exactly one send goes out per window; a send that does not go out
 * releases ITS OWN claim by id, so the sender can retry at once.
 *
 * A delivered email leaves `statement.emailed`, a skipped or failed one
 * `statement.email_failed`, both with the address used.
 */
export async function sendStatementEmail(
  data: StatementData,
  actor: StatementEmailActor,
): Promise<SendStatementResult> {
  const visitId = data.visit.id;
  // A sample visit (0181) never contacts the patient — checked before the
  // claim, so nothing is reserved, sent or rate-limited.
  if (data.visit.is_sample) {
    return {
      ok: false,
      error:
        actor.type === "staff"
          ? SAMPLE_NO_CONTACT_MESSAGE
          : "This statement can't be emailed. Ask reception for a printed copy.",
    };
  }
  const to = data.patient.email?.trim();
  if (!to) {
    return {
      ok: false,
      error:
        actor.type === "staff"
          ? "This patient has no email on file. Add one on the patient's page first."
          : "We don't have an email address for you. Ask reception to add one.",
    };
  }

  const admin = createAdminClient();
  const { data: claimId, error: claimErr } = await admin.rpc("claim_statement_email", {
    p_visit_id: visitId,
    p_recipient: to,
    p_window_seconds: RESEND_GUARD_MINUTES * 60,
  });
  if (claimErr) {
    await reportError({ scope: "statement/email:claim", error: claimErr, metadata: { visit_id: visitId } });
    return { ok: false, error: "Couldn't start the email. Try again." };
  }
  if (claimId == null) {
    return {
      ok: false,
      error:
        actor.type === "staff"
          ? `This statement was just emailed (or is sending) — wait ${RESEND_GUARD_MINUTES} minutes and check the patient's inbox and spam before sending again.`
          : `This statement was just emailed to you. Check your inbox and spam folder; you can send it again in ${RESEND_GUARD_MINUTES} minutes.`,
    };
  }

  const email = renderStatementEmail({
    patient: data.patient,
    visit: data.visit,
    hmoName: data.hmo?.name ?? null,
    lines: data.lines,
    subtotal: data.subtotal,
    totalDiscount: data.totalDiscount,
    total: data.total,
    payments: data.payments,
    summary: data.summary,
    issuedAt: new Date(),
    requestedBy: actor.type,
  });
  const result = await sendEmail({ to, subject: email.subject, text: email.text, html: email.html });

  if (!result.ok && result.kind === "error") {
    await reportError({
      scope: "statement/email:send",
      error: new Error(result.error),
      metadata: { visit_id: visitId },
    });
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: actor.type === "staff" ? actor.userId : null,
    actor_type: actor.type,
    patient_id: data.patient.id,
    action: result.ok ? "statement.emailed" : "statement.email_failed",
    resource_type: "visit",
    resource_id: visitId,
    metadata: {
      visit_number: data.visit.visit_number,
      to,
      ...(actor.type === "patient" ? { drm_id: actor.drmId, via: "portal" } : {}),
      line_count: data.lines.length,
      payment_count: data.payments.length,
      balance_php: data.summary.balance,
      email: result.ok
        ? { ok: true, id: result.id }
        : result.kind === "skipped"
          ? { ok: false, skipped: true, reason: result.reason }
          : { ok: false, error: result.error },
    },
    ip_address: ip,
    user_agent: ua,
  });

  if (result.ok) return { ok: true, data: { to } };
  // Nothing went out: release this request's own claim so the sender can retry now.
  await admin.from("rate_limit_attempts").delete().eq("id", claimId);
  return {
    ok: false,
    error:
      result.kind === "skipped"
        ? "Email isn't switched on for this server, so nothing was sent."
        : actor.type === "staff"
          ? "The email couldn't be sent. Try again in a minute, or print the statement instead."
          : "The email couldn't be sent. Try again in a minute, or print the statement and save it as a PDF.",
  };
}
