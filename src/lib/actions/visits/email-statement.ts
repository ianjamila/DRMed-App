"use server";

import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit/check";
import { reportError } from "@/lib/observability/report-error";
import { sendEmail } from "@/lib/notifications/email";
import { STATEMENT_ROLES } from "@/lib/visits/statement";
import { fetchStatement } from "@/lib/visits/statement-data";
import { renderStatementEmail } from "@/lib/visits/statement-email";

type Result = { ok: true; data: { to: string } } | { ok: false; error: string };

const RESEND_GUARD_MINUTES = RATE_LIMITS.statement_email.windowSec / 60;

/**
 * Email a visit's statement of account to the patient.
 *
 * Only ever to the address on the patient's record — there is no free-text
 * recipient, so a mistyped address cannot send someone's bill lines to a
 * stranger (RA 10173); a wrong address is fixed on the patient page first.
 * The content is rebuilt here from the database, never taken from the
 * client, through the same loader the printed page uses.
 *
 * A delivered email leaves `statement.emailed`; a skipped or failed one
 * leaves `statement.email_failed`, so the log shows every attempt. The resend
 * guard is the `statement_email` rate-limit bucket, keyed on visit +
 * recipient (not on who clicks), reserved before sending and released when
 * the send does not go out, so a failure can be retried at once.
 */
export async function emailStatementAction(visitId: string): Promise<Result> {
  const session = await requireActiveStaff();
  if (!STATEMENT_ROLES.has(session.role)) {
    return { ok: false, error: "Only reception and admin can email a statement." };
  }

  let data;
  try {
    data = await fetchStatement(await createClient(), visitId);
  } catch (err) {
    await reportError({ scope: "statement/email:load", error: err, metadata: { visit_id: visitId } });
    return { ok: false, error: "Couldn't load the statement. Try again." };
  }
  if (!data) return { ok: false, error: "This visit no longer exists." };

  const to = data.patient.email?.trim();
  if (!to) {
    return {
      ok: false,
      error: "This patient has no email on file. Add one on the patient's page first.",
    };
  }

  const guardId = `${visitId}:${to.toLowerCase()}`;
  const reserved = await checkRateLimit({
    bucket: "statement_email",
    identifier: guardId,
    ...RATE_LIMITS.statement_email,
  });
  if (!reserved.allowed) {
    return {
      ok: false,
      error: `This statement was just emailed (or is sending) — wait ${RESEND_GUARD_MINUTES} minutes and check the patient's inbox and spam before sending again.`,
    };
  }
  const admin = createAdminClient();

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
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: data.patient.id,
    action: result.ok ? "statement.emailed" : "statement.email_failed",
    resource_type: "visit",
    resource_id: visitId,
    metadata: {
      visit_number: data.visit.visit_number,
      to,
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
  // Nothing went out: release the reservation so staff can retry now.
  await admin
    .from("rate_limit_attempts")
    .delete()
    .eq("bucket", "statement_email")
    .eq("identifier", guardId);
  return {
    ok: false,
    error:
      result.kind === "skipped"
        ? "Email isn't switched on for this server, so nothing was sent."
        : "The email couldn't be sent. Try again in a minute, or print the statement instead.",
  };
}
