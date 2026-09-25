import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import type { Json } from "@/types/database";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { buildCorrectedResultMessages } from "./corrected-result-message";
import { PORTAL_URL } from "./portal-url";

export type NotifyOutcome = "sent" | "failed" | "already";

interface Args {
  /** The result_amendments row this notice is filed under; claims the send slot. */
  amendmentId: string;
  testName: string;
  actorId: string;
}

// The opt-in "updated copy ready" patient notice (0179): staff can check a box
// on a single-test or consolidated edit to tell the patient their portal copy
// changed. No reason, no values — owner decision 2026-09-25. Sent at most once
// per correction: result_claim_patient_notify returns a row only the first
// time it is called for this amendment, so a retried or racing call is a
// no-op. Never throws — a notify failure must not fail the edit that
// triggered it.
export async function notifyResultCorrected({
  amendmentId,
  testName,
  actorId,
}: Args): Promise<NotifyOutcome> {
  const admin = createAdminClient();

  const { data: claimed, error: claimErr } = await admin.rpc(
    "result_claim_patient_notify",
    { p_amendment_id: amendmentId },
  );
  if (claimErr) {
    await reportError({
      scope: "notify/result-corrected:claim",
      error: new Error(claimErr.message),
      metadata: { amendment_id: amendmentId },
    });
    return "failed";
  }
  const claim = claimed?.[0];
  if (!claim) return "already";

  let channels: string[] = [];
  let error: string | null = null;
  let smsMeta: unknown = null;
  let emailMeta: unknown = null;

  try {
    const { data: patient } = await admin
      .from("patients")
      .select("id, first_name, phone, email")
      .eq("id", claim.patient_id)
      .maybeSingle();

    const msg = buildCorrectedResultMessages({
      firstName: patient?.first_name ?? null,
      testName,
      portalUrl: PORTAL_URL,
    });

    const [smsResult, emailResult] = await Promise.all([
      patient?.phone
        ? sendSms({ to: patient.phone, message: msg.sms })
        : Promise.resolve({
            ok: false as const,
            kind: "skipped" as const,
            reason: "patient has no phone on file",
          }),
      patient?.email
        ? sendEmail({ to: patient.email, subject: msg.emailSubject, text: msg.sms, html: msg.emailHtml })
        : Promise.resolve({
            ok: false as const,
            kind: "skipped" as const,
            reason: "patient has no email on file",
          }),
    ]);

    if (!smsResult.ok && smsResult.kind === "error") {
      await reportError({
        scope: "notify/result-corrected:sms",
        error: new Error(smsResult.error),
        metadata: { amendment_id: amendmentId },
      });
    }
    if (!emailResult.ok && emailResult.kind === "error") {
      await reportError({
        scope: "notify/result-corrected:email",
        error: new Error(emailResult.error),
        metadata: { amendment_id: amendmentId },
      });
    }

    smsMeta = smsResult.ok
      ? { ok: true, id: smsResult.id }
      : smsResult.kind === "skipped"
        ? { ok: false, skipped: true, reason: smsResult.reason }
        : { ok: false, error: smsResult.error };
    emailMeta = emailResult.ok
      ? { ok: true, id: emailResult.id, to: patient?.email }
      : emailResult.kind === "skipped"
        ? { ok: false, skipped: true, reason: emailResult.reason }
        : { ok: false, error: emailResult.error, to: patient?.email };

    if (smsResult.ok) channels.push("sms");
    if (emailResult.ok) channels.push("email");
    if (channels.length === 0) {
      error =
        !smsResult.ok && smsResult.kind === "skipped" && !emailResult.ok && emailResult.kind === "skipped"
          ? "no contact on file"
          : [
              !smsResult.ok ? (smsResult.kind === "skipped" ? smsResult.reason : smsResult.error) : null,
              !emailResult.ok ? (emailResult.kind === "skipped" ? emailResult.reason : emailResult.error) : null,
            ]
              .filter(Boolean)
              .join("; ");
    }
  } catch (e) {
    await reportError({
      scope: "notify/result-corrected:send",
      error: e,
      metadata: { amendment_id: amendmentId },
    });
    channels = [];
    error = "internal error while sending";
  }

  await admin.rpc("result_record_patient_notify", {
    p_amendment_id: amendmentId,
    p_channels: channels,
    p_error: error as unknown as string,
  });

  await audit({
    actor_id: actorId,
    actor_type: "staff",
    patient_id: claim.patient_id,
    action: "result.notified",
    resource_type: "test_request",
    resource_id: claim.anchor_test_request_id,
    metadata: {
      kind: "corrected",
      result_id: claim.result_id,
      amendment_id: amendmentId,
      amendment_seq: claim.amendment_seq,
      sms: smsMeta,
      email: emailMeta,
    } as unknown as Json,
  });

  return channels.length > 0 ? "sent" : "failed";
}
