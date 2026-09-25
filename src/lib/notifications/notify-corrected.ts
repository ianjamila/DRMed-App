import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import type { Json } from "@/types/database";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { buildCorrectedResultMessages } from "./corrected-result-message";
import { PORTAL_URL } from "./portal-url";
import { checkPatientRecipient } from "./active-patient-recipient";
import { auditSkippedInactiveRecipient } from "./inactive-recipient-audit";

export type NotifyOutcome = "sent" | "failed" | "already" | "inactive" | "not_released";

interface Args {
  /**
   * The result_amendments row this notice is filed under; claims the send
   * slot. Null when the caller committed the edit but could not learn the
   * amendment id (neither the RPC response nor the probe yielded one) — the
   * notice is skipped rather than filed under the wrong row.
   */
  amendmentId: string | null;
  /** The result this amendment belongs to — used to re-check every linked
   * test's release status right before the claim (R1). */
  resultId: string;
  testName: string;
  actorId: string;
  /** The visit's patient (0167) — checked BEFORE the claim so a deleted or
   * merged record never consumes the once-only send slot. */
  patientId: string;
}

// R1: the portal only serves RELEASED results — result_edit_commit allows
// edits on result_uploaded / ready_for_release / released (undo-release can
// walk a released test back to ready_for_release, then a correction with
// "notify patient" ticked would promise a portal copy the patient can't yet
// open). True/false decide whether to send; null means the check itself
// failed, which the caller treats as "failed" rather than guessing either
// way. Every LIVE test linked to the result must be released — a withdrawn
// or deleted sibling doesn't count.
async function everyLiveTestReleased(
  admin: ReturnType<typeof createAdminClient>,
  resultId: string,
): Promise<boolean | null> {
  type LiveTestRow = { test_requests: { status: string } | { status: string }[] };
  const { data, error } = await admin
    .from("result_test_requests")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select("test_requests!inner(status, deleted_at, visits!inner(deleted_at))" as any)
    .eq("result_id", resultId)
    .is("test_requests.deleted_at", null)
    .is("test_requests.visits.deleted_at", null)
    .returns<LiveTestRow[]>();
  if (error) return null;
  const rows = data ?? [];
  if (rows.length === 0) return false;
  return rows.every((row) => {
    const tr = Array.isArray(row.test_requests) ? row.test_requests[0] : row.test_requests;
    return tr?.status === "released";
  });
}

type ClaimRow = {
  amendment_seq: number;
  anchor_test_request_id: string;
  patient_id: string;
  result_id: string;
};

// The opt-in "updated copy ready" patient notice (0179): staff can check a box
// on a single-test or consolidated edit to tell the patient their portal copy
// changed. No reason, no values — owner decision 2026-09-25. Sent at most once
// per correction: result_claim_patient_notify returns a row only the first
// time it is called for this amendment, so a retried or racing call is a
// no-op. Never throws — a notify failure must not fail the edit that
// triggered it. Every step after the claim succeeds (RPC or supabase-js
// throwing on a network failure, or the audit call) is caught individually
// so a failure there still lets a later best-effort step run — in
// particular, the outcome is recorded even if sending or auditing blew up,
// so the row reads "Send failed" rather than leaving "status unknown".
//
// 0167: the active-patient rule is checked BEFORE the claim, so a deleted or
// merged record's send slot is never consumed — a retried call (after the
// record is restored, or by mistake) still gets a fair first attempt. An
// inactive or lookup-failed recipient gets NOTHING on any channel.
export async function notifyResultCorrected({
  amendmentId,
  resultId,
  testName,
  actorId,
  patientId,
}: Args): Promise<NotifyOutcome> {
  if (amendmentId === null) {
    await reportError({
      scope: "notify/result-corrected:no-amendment-id",
      error: new Error(
        "edit committed but amendment id unknown — patient notice skipped",
      ),
      metadata: { test_name: testName },
    });
    return "failed";
  }

  const admin = createAdminClient();

  const recipient = await checkPatientRecipient(admin, patientId);
  if (recipient.kind !== "active") {
    await auditSkippedInactiveRecipient({
      sender: "notify-corrected",
      patientId,
      reason: recipient.kind === "inactive" ? recipient.reason : "walk_in",
      resourceType: "result_amendment",
      resourceId: amendmentId,
    });
    return "inactive";
  }

  const released = await everyLiveTestReleased(admin, resultId);
  if (released === null) {
    await reportError({
      scope: "notify/result-corrected:release-check",
      error: new Error("could not verify release status before notify"),
      metadata: { amendment_id: amendmentId, result_id: resultId },
    });
    return "failed";
  }
  if (!released) {
    return "not_released";
  }

  let claim: ClaimRow | undefined;
  try {
    const { data: claimed, error: claimErr } = await admin.rpc(
      "result_claim_patient_notify",
      { p_amendment_id: amendmentId },
    );
    if (claimErr) throw new Error(claimErr.message);
    claim = claimed?.[0];
  } catch (e) {
    await reportError({
      scope: "notify/result-corrected:claim",
      error: e,
      metadata: { amendment_id: amendmentId },
    });
    return "failed";
  }
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

  // The claim already succeeded, so this amendment will never be retried by
  // result_claim_patient_notify — best-effort record the outcome even after
  // a throw above, so the row shows "Send failed" instead of no record at
  // all (which staff would read as "status unknown").
  try {
    await admin.rpc("result_record_patient_notify", {
      p_amendment_id: amendmentId,
      p_channels: channels,
      p_error: error as unknown as string,
    });
  } catch (e) {
    await reportError({
      scope: "notify/result-corrected:record",
      error: e,
      metadata: { amendment_id: amendmentId },
    });
  }

  try {
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
  } catch (e) {
    await reportError({
      scope: "notify/result-corrected:audit",
      error: e,
      metadata: { amendment_id: amendmentId },
    });
  }

  return channels.length > 0 ? "sent" : "failed";
}
