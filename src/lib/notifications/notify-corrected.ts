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
import { shouldOfferNotify } from "@/lib/results/copy-followups";
import { fetchCopyStateAdmin } from "@/lib/results/copy-followups.server";
import { allLinksReleased, fetchLinkedTestRequestStatusesStrict } from "@/lib/results/release-eligibility";

export type NotifyOutcome =
  | "sent"
  | "sent_unrecorded"
  | "failed"
  | "not_set_up"
  | "already"
  | "inactive"
  | "not_released";

/** Every outcome an edit form's "let the patient know" checkbox can settle
 * on, including the two that are decided before notifyResultCorrected is
 * even called. */
export type CorrectedNotifyOutcome = NotifyOutcome | "not_offered" | "check_failed";

// The two skip reasons this file produces for a missing contact. Every other
// "skipped" comes from the provider itself (sendSms / sendEmail): its keys are
// not configured, or NOTIFICATIONS_LIVE is off.
const NO_PHONE = "patient has no phone on file";
const NO_EMAIL = "patient has no email on file";

type ChannelResult = { ok: true } | { ok: false; kind: "skipped"; reason: string } | { ok: false; kind: "error"; error: string };

/**
 * Why a send reached nobody, for result_amendments.patient_notify_error.
 * "no contact on file" only when the patient genuinely has neither a phone
 * nor an email; when every channel was skipped and at least one only because
 * notices aren't set up here, say so (notSetUp) rather than blame the
 * patient's record.
 */
export function describeSendFailure(sms: ChannelResult, email: ChannelResult): { error: string; notSetUp: boolean } {
  const failed = [sms, email].filter((r): r is Exclude<ChannelResult, { ok: true }> => !r.ok);
  const reasons = failed.map((r) => (r.kind === "skipped" ? r.reason : r.error));
  const allSkipped = failed.every((r) => r.kind === "skipped");
  if (allSkipped && reasons.every((r) => r === NO_PHONE || r === NO_EMAIL)) {
    return { error: "no contact on file", notSetUp: false };
  }
  if (allSkipped) {
    return { error: `notices not set up: ${reasons.join("; ")}`, notSetUp: true };
  }
  return { error: reasons.join("; "), notSetUp: false };
}

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
  /** 0188: a reception/admin "Retry notice" from Result Follow-ups — claims
   * through result_retry_patient_notify, which only re-opens a slot whose
   * earlier attempt reached nobody because of a send error. */
  retry?: boolean;
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
  retry = false,
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

  // R1 (revised by X1): the portal only serves a shared PDF when EVERY test
  // linked to the result is released, deleted siblings included — the same
  // rule isResultDownloadEligible uses for the download itself
  // (release-eligibility.ts). Reusing that rule here, rather than a
  // "live members only" variant, means a deleted-but-unreleased sibling
  // can't make this check pass while the portal still refuses the download.
  // True/false decide whether to send; null means the check itself failed,
  // which the caller treats as "failed" rather than guessing either way.
  const linkedStatuses = await fetchLinkedTestRequestStatusesStrict(admin, resultId);
  if (linkedStatuses === null) {
    await reportError({
      scope: "notify/result-corrected:release-check",
      error: new Error("could not verify release status before notify"),
      metadata: { amendment_id: amendmentId, result_id: resultId },
    });
    return "failed";
  }
  if (!allLinksReleased(linkedStatuses)) {
    return "not_released";
  }

  let claim: ClaimRow | undefined;
  try {
    const { data: claimed, error: claimErr } = await admin.rpc(
      retry ? "result_retry_patient_notify" : "result_claim_patient_notify",
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
  let notSetUp = false;
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
            reason: NO_PHONE,
          }),
      patient?.email
        ? sendEmail({ to: patient.email, subject: msg.emailSubject, text: msg.sms, html: msg.emailHtml })
        : Promise.resolve({
            ok: false as const,
            kind: "skipped" as const,
            reason: NO_EMAIL,
          }),
    ]);

    // 0188: record what was DELIVERED before anything else can throw — a
    // failure in the reporting below must never erase a real delivery, or
    // the row would read as a send error and "Retry notice" would message a
    // patient who already got it.
    if (smsResult.ok) channels.push("sms");
    if (emailResult.ok) channels.push("email");

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

    if (channels.length === 0) {
      ({ error, notSetUp } = describeSendFailure(smsResult, emailResult));
    }
  } catch (e) {
    await reportError({
      scope: "notify/result-corrected:send",
      error: e,
      metadata: { amendment_id: amendmentId },
    });
    // Keep any channel that already delivered (see above): only a throw
    // before anything was sent is a failure a retry may repeat.
    notSetUp = false;
    error = channels.length === 0 ? "internal error while sending" : null;
  }

  // The claim already succeeded, so this amendment will never be retried by
  // result_claim_patient_notify — best-effort record the outcome even after
  // a throw above, so the row shows "Send failed" instead of no record at
  // all (which staff would read as "status unknown").
  // X3: a real send whose outcome could not be recorded is told to the
  // editor ("sent_unrecorded") — reception would otherwise see "Send status
  // unknown" with nobody knowing why. Never resent, never fails the edit.
  let recorded = true;
  try {
    const { error: recErr } = await admin.rpc("result_record_patient_notify", {
      p_amendment_id: amendmentId,
      p_channels: channels,
      p_error: error as unknown as string,
    });
    if (recErr) throw new Error(recErr.message);
  } catch (e) {
    recorded = false;
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
        ...(retry ? { retry: true } : {}),
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

  if (channels.length === 0) return notSetUp ? "not_set_up" : "failed";
  return recorded ? "sent" : "sent_unrecorded";
}

// R6: the single place every edit action calls to decide-and-send the opt-in
// "let the patient know" notice, so the three call sites (single-test
// PDF-replace, single-test structured, consolidated report) can't drift or
// diverge on how a failed copy-state read is worded. Re-reads the copy state
// itself (admin client, the service-role internal RPC — the client's
// checkbox offer is never trusted on its own) and never throws.
//
// A failed read (RPC error, or no row — itself anomalous right after a
// commit) is its own outcome, "check_failed": telling staff "no copy or no
// contact on file" there would be false, since the read never got that far.
export async function resolveCorrectedNotifyOutcome({
  wantsNotify,
  resultId,
  amendmentId,
  testName,
  actorId,
  patientId,
}: {
  wantsNotify: boolean;
  resultId: string;
  amendmentId: string | null;
  testName: string;
  actorId: string;
  patientId: string;
}): Promise<CorrectedNotifyOutcome | undefined> {
  if (!wantsNotify) return undefined;

  const read = await fetchCopyStateAdmin(resultId);
  if (!read.ok) {
    await reportError({
      scope: "notify/result-corrected:check",
      error: new Error("copy-state read failed before notify"),
      metadata: { result_id: resultId },
    });
    return "check_failed";
  }

  const offer = shouldOfferNotify(read.state);
  if (!offer.offered) return "not_offered";

  return notifyResultCorrected({ amendmentId, resultId, testName, actorId, patientId });
}
