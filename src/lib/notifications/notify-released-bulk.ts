import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { renderBulkNotice } from "./release-notice-content";
import { SAMPLE_SKIP_REASON } from "@/lib/visits/sample";
import { patientAlreadyAskedForReview } from "./review-cta";
import { checkPatientRecipient } from "./active-patient-recipient";
import { auditSkippedInactiveRecipient } from "./inactive-recipient-audit";
import { noticeFromChannels, noticeSkipped, type ReleaseNoticeOutcome } from "./release-notice-outcome";

interface Input {
  visitId: string;
  testRequestIds: string[];
  testNames: string[];
  // How the results were handed over. A physical/pickup hand-off means the
  // patient collected the printouts in person — no message is sent (M7).
  releaseMedium: string;
  // Undo (owner 2026-09-28): releaseSelectedAction's own bulk_batch_id —
  // stamped on this function's `result.notified` audit row (written only for
  // testRequestIds[0]) so loadOwnBatchRows' `changedSince` guard recognises
  // it as part of the SAME release, not an independent later change. Without
  // it, that row — written moments after the release rows, by "system" —
  // would make the batch's own Undo permanently refuse to restore its first
  // test.
  bulkBatchId?: string;
}

// Fired by the bulk-release server action (releaseAllReadyComponentsAction).
// Sends ONE consolidated SMS + email covering every component released in
// that action, instead of one message per component. Pulls the patient off
// the visit, sends via Semaphore/Resend in parallel, audit-logs the outcome.
// Failures never throw — release is the source of truth.
export async function notifyResultsReleasedBulk({
  visitId,
  testRequestIds,
  testNames,
  releaseMedium,
  bulkBatchId,
}: Input): Promise<ReleaseNoticeOutcome> {
  if (testRequestIds.length === 0) return noticeSkipped("nothing to announce");
  const admin = createAdminClient();

  const { data: visit } = await admin
    .from("visits")
    .select(
      `
        id, is_sample,
        patients!inner ( id, drm_id, first_name, phone, email )
      `,
    )
    .eq("id", visitId)
    // A patient must never be told their lab results are ready for a
    // deleted visit (0125).
    .is("deleted_at", null)
    .maybeSingle();

  if (!visit) return noticeSkipped("visit not found");
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) return noticeSkipped("patient not found");

  const count = testNames.length;

  // M7: physical hand-off (printouts collected in person) — record the notified
  // audit row as skipped on both channels and send nothing. A sample visit
  // (0181) is skipped the same way: the patient is never contacted about it.
  const skipReason = visit.is_sample
    ? SAMPLE_SKIP_REASON
    : releaseMedium === "physical" || releaseMedium === "pickup"
      ? "physical hand-off — no message sent"
      : null;
  if (skipReason) {
    const skipped = {
      ok: false as const,
      skipped: true as const,
      reason: skipReason,
    };
    await audit({
      actor_id: null,
      actor_type: "system",
      patient_id: patient.id,
      action: "result.notified",
      resource_type: "test_request",
      resource_id: testRequestIds[0],
      metadata: {
        visit_id: visitId,
        release_medium: releaseMedium,
        sms: skipped,
        email: skipped,
        review_cta: { shown: false },
        bulk: true,
        count,
        test_names: testNames,
        test_request_ids: testRequestIds,
        ...(bulkBatchId ? { bulk_batch_id: bulkBatchId } : {}),
      },
    });
    return noticeSkipped(skipReason);
  }


  // Review CTA: only on a patient's FIRST delivered result email, and only if
  // they have an email on file. Suppressed thereafter via the audit flag.
  const hasEmail = Boolean(patient.email);
  const alreadyAsked = hasEmail
    ? await patientAlreadyAskedForReview(admin, patient.id)
    : false;
  const includeReviewCta = hasEmail && !alreadyAsked;

  const { smsBody, emailSubject, emailText, emailHtml } = renderBulkNotice({
    patient,
    testNames,
    includeReviewCta,
  });

  const recipient = await checkPatientRecipient(admin, patient.id);
  if (recipient.kind !== "active") {
    await auditSkippedInactiveRecipient({
      sender: "notify-released-bulk",
      patientId: patient.id,
      reason: recipient.kind === "inactive" ? recipient.reason : "walk_in",
      resourceType: "visit",
      resourceId: visitId,
    });
    return noticeSkipped(
      recipient.kind === "inactive" ? "patient is not active" : "walk-in patient — no contact details",
    );
  }
  const to = recipient.patient;

  const [smsResult, emailResult] = await Promise.all([
    to.phone
      ? sendSms({ to: to.phone, message: smsBody })
      : Promise.resolve({
          ok: false as const,
          kind: "skipped" as const,
          reason: "patient has no phone on file",
        }),
    to.email
      ? sendEmail({
          to: to.email,
          subject: emailSubject,
          text: emailText,
          html: emailHtml,
        })
      : Promise.resolve({
          ok: false as const,
          kind: "skipped" as const,
          reason: "patient has no email on file",
        }),
  ]);

  if (!smsResult.ok && smsResult.kind === "error") {
    await reportError({
      scope: "notify/result-released-bulk:sms",
      error: new Error(smsResult.error),
      metadata: { visit_id: visitId, test_request_ids: testRequestIds },
    });
  }
  if (!emailResult.ok && emailResult.kind === "error") {
    await reportError({
      scope: "notify/result-released-bulk:email",
      error: new Error(emailResult.error),
      metadata: { visit_id: visitId, test_request_ids: testRequestIds },
    });
  }

  await audit({
    actor_id: null,
    actor_type: "system",
    patient_id: patient.id,
    action: "result.notified",
    resource_type: "test_request",
    resource_id: testRequestIds[0],
    metadata: {
      visit_id: visitId,
      sms: smsResult.ok
        ? { ok: true, id: smsResult.id }
        : smsResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: smsResult.reason }
          : { ok: false, error: smsResult.error },
      email: emailResult.ok
        ? { ok: true, id: emailResult.id, to: to.email }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error, to: to.email },
      review_cta: { shown: includeReviewCta && emailResult.ok },
      bulk: true,
      count,
      test_names: testNames,
      test_request_ids: testRequestIds,
      ...(bulkBatchId ? { bulk_batch_id: bulkBatchId } : {}),
    },
  });
  return noticeFromChannels(smsResult, emailResult);
}
