import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/observability/report-error";
import { isDoctorKind } from "@/lib/visits/order-lines";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { checkPatientRecipient } from "./active-patient-recipient";
import { patientAlreadyAskedForReview } from "./review-cta";
import { renderBulkNotice, renderSingleNotice } from "./release-notice-content";
import { auditTerminalNotice, type ChannelView } from "./release-notice-audit";
import {
  CANCEL_REASON, SKIP_DOCTOR, SKIP_PHYSICAL, SKIP_SAMPLE, SKIP_WALK_IN, SUPPRESS_REASON,
  inactiveSkipReason, outcomeReasonOf,
} from "./release-notice-reasons";
import { noticeRetrying, noticeSkipped, type ReleaseNoticeOutcome } from "./release-notice-outcome";
import type { ReleaseNoticeRow } from "./release-notice-types";

type Admin = ReturnType<typeof createAdminClient>;

// Sends ONE claimed release notice (0210/0212) and records how it ended. The
// caller — the release's fast path or the sweeper route — has already leased the
// row through claim_release_notice; everything here is fenced on that lease.
//
// The re-check at send time, the one owner of the policy: the notice carries ids
// only, so what it announces is decided NOW from the live rows (tests still
// released with this exact released_at, the visit live and not a sample, the
// medium, the patient active with contact details, no identical notice sent in
// the last 24 h). The message wording is release-notice-content.ts, shared with
// the legacy one-shot senders.
//
// At-most-once SMS (owner decision 4): the row is fenced to sms_state='unknown'
// BEFORE the SMS leaves, and an SMS is never sent from 'unknown' / 'failed' /
// 'sent'. Email carries Idempotency-Key result-notice:<id>:email, so a retry of
// an ambiguous email attempt cannot double-mail inside Resend's 24 h window.
//
// Never throws: any failure leaves the row for the sweeper (the lease expires)
// and is reported to the error log.

export type NoticeFinalStatus = "sent" | "skipped" | "suppressed" | "cancelled" | "retry" | "abandoned";

export interface SendNoticeResult {
  /** What the fast path tells the operator. */
  outcome: ReleaseNoticeOutcome;
  /** The status the database ended in, "fenced" (the lease was lost — nothing was written), or "error". */
  finalStatus: NoticeFinalStatus | "fenced" | "error";
}

const ALREADY_ANNOUNCED_WINDOW_MS = 24 * 60 * 60 * 1000;
const NO_PHONE = "patient has no phone on file";
const NO_EMAIL = "patient has no email on file";
const SMS_NOT_RESENT = "text message not resent after an unknown outcome";

const FENCED: SendNoticeResult = { outcome: noticeRetrying(), finalStatus: "fenced" };

interface LoadedTest {
  id: string;
  name: string;
  kind: string;
  isSample: boolean;
  patientId: string;
}

interface FinishArgs {
  status: "sent" | "skipped" | "suppressed" | "cancelled" | "retry";
  emailState?: ChannelView["state"];
  smsState?: ChannelView["state"];
  emailId?: string;
  smsId?: string;
  error?: string;
  skipReason?: string;
}

/**
 * Tests the notice announces: still released with THIS released_at, on a live
 * visit. `lab` is `loaded` without doctor lines — a consultation has no
 * document behind "your lab result is ready" (isDoctorKind, the same split the
 * legacy senders make).
 */
async function loadReleasedTests(
  admin: Admin,
  row: ReleaseNoticeRow,
): Promise<{ loaded: LoadedTest[]; lab: LoadedTest[] } | null> {
  const { data, error } = await admin
    .from("test_requests")
    .select("id, services!inner ( name, kind ), visits!inner ( id, is_sample, patient_id )")
    .in("id", row.test_request_ids)
    .eq("visit_id", row.visit_id)
    .eq("status", "released")
    // The EXACT stamp, as the string the database gave us: a JS Date would cut
    // the microseconds and match nothing (or, worse, another release).
    .eq("released_at", row.released_at)
    .is("deleted_at", null)
    .is("visits.deleted_at", null);
  if (error) return null;
  const byId = new Map<string, LoadedTest>();
  for (const r of data ?? []) {
    const svc = Array.isArray(r.services) ? r.services[0] : r.services;
    const visit = Array.isArray(r.visits) ? r.visits[0] : r.visits;
    if (!svc || !visit) continue;
    byId.set(r.id, { id: r.id, name: svc.name, kind: svc.kind, isSample: visit.is_sample, patientId: visit.patient_id });
  }
  // Keep the order the release recorded.
  const loaded = row.test_request_ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  return { loaded, lab: loaded.filter((t) => !isDoctorKind(t.kind)) };
}

/** Were these tests all announced in a `sent` notice in the last 24 h? null = could not tell. */
async function alreadyAnnounced(admin: Admin, row: ReleaseNoticeRow, ids: string[]): Promise<boolean | null> {
  const since = new Date(Date.now() - ALREADY_ANNOUNCED_WINDOW_MS).toISOString();
  const { data, error } = await admin
    .from("release_notices")
    .select("test_request_ids")
    .eq("visit_id", row.visit_id)
    .eq("status", "sent")
    .neq("id", row.id)
    .gte("sent_at", since);
  if (error) return null;
  const announced = new Set((data ?? []).flatMap((n) => n.test_request_ids));
  return ids.every((id) => announced.has(id));
}

async function callFinish(admin: Admin, row: ReleaseNoticeRow, f: FinishArgs): Promise<ReleaseNoticeRow | null | "error"> {
  const { data, error } = await admin.rpc("finish_release_notice", {
    p_id: row.id,
    p_lease_token: row.lease_token!,
    p_final_status: f.status,
    p_email_state: f.emailState,
    p_sms_state: f.smsState,
    p_email_provider_id: f.emailId,
    p_sms_provider_id: f.smsId,
    p_error: f.error,
    p_skip_reason: f.skipReason,
  });
  if (error) {
    await reportError({
      scope: "notify/release-notice:finish",
      error: new Error(error.message),
      metadata: { notice_id: row.id, visit_id: row.visit_id },
    });
    return "error";
  }
  return data && data.length > 0 ? (data[0] as ReleaseNoticeRow) : null;
}

function outcomeFromFinished(done: ReleaseNoticeRow): ReleaseNoticeOutcome {
  switch (done.status) {
    case "sent": {
      const channels: Array<"email" | "sms"> = [];
      if (done.email_state === "sent") channels.push("email");
      if (done.sms_state === "sent") channels.push("sms");
      return { status: "sent", channels, reason: null };
    }
    case "skipped":
      return noticeSkipped(outcomeReasonOf(done.skip_reason));
    case "suppressed":
      return noticeSkipped(SUPPRESS_REASON);
    case "cancelled":
      return noticeSkipped(CANCEL_REASON);
    case "retry":
      return noticeRetrying();
    default:
      // abandoned: the retries ran out — the operator sees it on Result Follow-ups.
      return { status: "failed", channels: [], reason: "sending failed" };
  }
}

/** Finish the row, audit it when terminal, and say what happened. */
async function conclude(
  admin: Admin,
  row: ReleaseNoticeRow,
  f: FinishArgs,
  live?: Parameters<typeof auditTerminalNotice>[2],
): Promise<SendNoticeResult> {
  const done = await callFinish(admin, row, f);
  if (done === "error") return { outcome: noticeRetrying(), finalStatus: "error" };
  if (done === null) return FENCED; // a newer attempt owns the row: write nothing
  if (done.resolved_at !== null) await auditTerminalNotice(admin, done, live);
  return { outcome: outcomeFromFinished(done), finalStatus: done.status as NoticeFinalStatus };
}

const retryLater = (admin: Admin, row: ReleaseNoticeRow, error: string) => conclude(admin, row, { status: "retry", error });

async function sendInner(row: ReleaseNoticeRow): Promise<SendNoticeResult> {
  if (row.status !== "sending" || !row.lease_token) return FENCED;
  const admin = createAdminClient();

  // 1. What is still released with this exact stamp.
  const found = await loadReleasedTests(admin, row);
  if (found === null) return retryLater(admin, row, "could not re-check the released tests");
  if (found.loaded.length === 0) {
    return conclude(admin, row, { status: "cancelled", skipReason: CANCEL_REASON });
  }
  // A doctor line has no result to collect: "your lab result is ready" would
  // link a portal that shows nothing for it (the last line of defence the
  // legacy senders also keep).
  const tests = found.lab;
  if (tests.length === 0) return conclude(admin, row, { status: "skipped", skipReason: SKIP_DOCTOR });

  // 2. The hand-over rules: a sample visit and a physical / pickup hand-off are
  // never messaged. Both channels are recorded as skipped.
  const skipAll = (reason: string) =>
    conclude(admin, row, { status: "skipped", emailState: "skipped", smsState: "skipped", skipReason: reason }, {
      patientId: tests[0].patientId,
      testNames: tests.map((t) => t.name),
      testIds: tests.map((t) => t.id),
      includeReviewCta: false,
      sms: { state: "skipped", reason },
      email: { state: "skipped", reason },
    });
  if (tests[0].isSample) return skipAll(SKIP_SAMPLE);
  if (row.release_medium === "physical" || row.release_medium === "pickup") return skipAll(SKIP_PHYSICAL);

  // 3. The patient, read fresh (0167): deleted / merged gets nothing on any channel.
  const patientId = tests[0].patientId;
  const recipient = await checkPatientRecipient(admin, patientId);
  if (recipient.kind === "inactive" && recipient.reason === "lookup_failed") {
    // An outage, not a deleted patient: keep the notice and try again.
    await reportError({
      scope: "notifications.recipient_lookup",
      error: new Error("patient recipient lookup failed (release-notice-sender)"),
      metadata: { notice_id: row.id, patient_id: patientId },
    });
    return retryLater(admin, row, "could not check the patient record");
  }
  if (recipient.kind !== "active") {
    const reason = recipient.kind === "inactive" ? inactiveSkipReason(recipient.reason) : SKIP_WALK_IN;
    return conclude(admin, row, { status: "skipped", skipReason: reason }, {
      patientId,
      testNames: tests.map((t) => t.name),
      testIds: tests.map((t) => t.id),
      includeReviewCta: false,
      sms: { state: "skipped", reason },
      email: { state: "skipped", reason },
    });
  }
  const to = recipient.patient;

  // 4. Owner decision 1: the same tests already announced in the last 24 h.
  const dup = await alreadyAnnounced(admin, row, tests.map((t) => t.id));
  if (dup === null) return retryLater(admin, row, "could not check earlier notices");
  if (dup) return conclude(admin, row, { status: "suppressed", skipReason: SUPPRESS_REASON });

  // 5. Render (single or consolidated, by how many tests survived).
  const testNames = tests.map((t) => t.name);
  const emailSendable = row.email_state !== "sent" && Boolean(to.email);
  const hasEmail = Boolean(to.email);
  const includeReviewCta = hasEmail && !(await patientAlreadyAskedForReview(admin, to.id));
  const rendered = tests.length === 1
    ? renderSingleNotice({ patient: to, testName: testNames[0], includeReviewCta })
    : renderBulkNotice({ patient: to, testNames, includeReviewCta });

  // 6. SMS: at most once. Fence the row to 'unknown' BEFORE the text leaves.
  let sms: ChannelView;
  let smsAttempted = false;
  if (row.sms_state === "sent") {
    sms = { state: "sent", id: row.sms_provider_id };
  } else if (row.sms_state === "unknown" || row.sms_state === "failed") {
    sms = { state: row.sms_state, reason: SMS_NOT_RESENT, error: row.last_error };
  } else if (!to.phone) {
    sms = { state: "skipped", reason: NO_PHONE };
  } else {
    const { data: fenced, error: fenceError } = await admin
      .from("release_notices")
      .update({ sms_state: "unknown" })
      .eq("id", row.id)
      .eq("lease_token", row.lease_token)
      .eq("status", "sending")
      .select("id");
    if (fenceError) {
      // Cannot prove the attempt is recorded, so the text does not go out; the
      // email half still can. The state stays as it was.
      await reportError({
        scope: "notify/release-notice:sms-fence",
        error: new Error(fenceError.message),
        metadata: { notice_id: row.id },
      });
      sms = { state: row.sms_state as ChannelView["state"], reason: "could not record the text attempt" };
    } else if (!fenced || fenced.length === 0) {
      return FENCED; // lost the lease: nothing has been sent, nothing is written
    } else {
      smsAttempted = true;
      sms = { state: "unknown" }; // until the provider answers
    }
  }

  // 7. Send. Email and SMS are independent; each result is kept as it is.
  const smsResultP = smsAttempted
    ? sendSms({ to: to.phone!, message: rendered.smsBody })
    : Promise.resolve(null);
  const emailResultP = emailSendable
    ? sendEmail({
        to: to.email!,
        subject: rendered.emailSubject,
        text: rendered.emailText,
        html: rendered.emailHtml,
        idempotencyKey: `result-notice:${row.id}:email`,
      })
    : Promise.resolve(null);
  const [smsResult, emailResult] = await Promise.all([smsResultP, emailResultP]);

  let email: ChannelView;
  if (row.email_state === "sent") email = { state: "sent", id: row.email_provider_id, to: to.email };
  else if (!to.email) email = { state: "skipped", reason: NO_EMAIL };
  else if (emailResult === null) email = { state: "failed", error: "email not sent" }; // unreachable: emailSendable
  else if (emailResult.ok) email = { state: "sent", id: emailResult.id, to: to.email };
  else if (emailResult.kind === "skipped") email = { state: "skipped", reason: emailResult.reason, to: to.email };
  else email = { state: "failed", error: emailResult.error, to: to.email };

  if (smsResult) {
    if (smsResult.ok) sms = { state: "sent", id: smsResult.id };
    else if (smsResult.kind === "skipped") sms = { state: "skipped", reason: smsResult.reason };
    // Any error leaves it 'unknown': the provider may have taken the message.
    else sms = { state: "unknown", error: smsResult.error };
  }

  if (smsResult && !smsResult.ok && smsResult.kind === "error") {
    await reportError({
      scope: "notify/result-released:sms",
      error: new Error(smsResult.error),
      metadata: { notice_id: row.id, visit_id: row.visit_id },
    });
  }
  if (emailResult && !emailResult.ok && emailResult.kind === "error") {
    await reportError({
      scope: "notify/result-released:email",
      error: new Error(emailResult.error),
      metadata: { notice_id: row.id, visit_id: row.visit_id },
    });
  }

  // 8. The verdict. Delivered on ANY channel = sent (today's rule). Nothing
  // delivered and a channel errored = retry (the SMS half never repeats, the
  // email half does). Nothing delivered, nothing errored = skipped.
  const delivered = email.state === "sent" || sms.state === "sent";
  const errored = email.state === "failed" || Boolean(smsResult && !smsResult.ok && smsResult.kind === "error");
  const errors = [email.state === "failed" ? email.error : null, smsResult && !smsResult.ok && smsResult.kind === "error" ? smsResult.error : null]
    .filter(Boolean)
    .join(" | ");
  const skipReasons = [sms, email].filter((c) => c.state === "skipped" && c.reason).map((c) => c.reason!);
  const status: FinishArgs["status"] = delivered ? "sent" : errored ? "retry" : "skipped";

  return conclude(
    admin,
    row,
    {
      status,
      emailState: email.state,
      smsState: sms.state,
      emailId: email.state === "sent" && emailResult?.ok ? emailResult.id : undefined,
      smsId: smsResult?.ok ? String(smsResult.id) : undefined,
      error: errors || undefined,
      skipReason: status === "skipped" ? [...new Set(skipReasons)].join("; ") || undefined : undefined,
    },
    {
      patientId,
      testNames,
      testIds: tests.map((t) => t.id),
      includeReviewCta,
      sms,
      email,
    },
  );
}

/** Sends one claimed notice. Never throws. */
export async function sendReleaseNotice(row: ReleaseNoticeRow): Promise<SendNoticeResult> {
  try {
    return await sendInner(row);
  } catch (err) {
    try {
      await reportError({
        scope: "notify/release-notice:unexpected",
        error: err,
        metadata: { notice_id: row.id, visit_id: row.visit_id },
      });
    } catch {
      // reporting must not mask the result
    }
    // Hand the row back for a retry while the lease is still ours; if this
    // fails too, the lease expires and the sweeper reclaims it.
    try {
      if (row.lease_token) {
        await callFinish(createAdminClient(), row, { status: "retry", error: "unexpected error while sending" });
      }
    } catch {
      // the lease will expire
    }
    return { outcome: noticeRetrying(), finalStatus: "error" };
  }
}
