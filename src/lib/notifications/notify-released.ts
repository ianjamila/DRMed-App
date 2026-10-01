import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { renderSingleNotice } from "./release-notice-content";
import { patientAlreadyAskedForReview } from "./review-cta";
import { isDoctorKind } from "@/lib/visits/order-lines";
import { checkPatientRecipient } from "./active-patient-recipient";
import { auditSkippedInactiveRecipient } from "./inactive-recipient-audit";
import { SAMPLE_SKIP_REASON } from "@/lib/visits/sample";
import { noticeFromChannels, noticeSkipped, type ReleaseNoticeOutcome } from "./release-notice-outcome";

interface Input {
  testRequestId: string;
  visitId: string;
  // How the result was handed over. A physical/pickup hand-off means the
  // patient collected the printout in person — no message is sent (M7).
  releaseMedium: string;
  // Undo (owner 2026-09-28): when the caller is releaseSelectedAction, this
  // is that call's bulk_batch_id — stamped onto this function's own
  // `result.notified` audit row so loadOwnBatchRows' `changedSince` guard
  // recognises it as belonging to the SAME release, not an independent later
  // change. Without it, this row (written moments after the release rows, by
  // "system") would make the batch's own Undo permanently refuse the test it
  // is attached to.
  bulkBatchId?: string;
}

// Fired by reception's release action. Pulls the patient + test name, then
// emails via Resend and texts via Semaphore in parallel — but SMS is skipped
// unless Semaphore is configured, and it never has been in prod, so in practice
// only email goes out. Each outcome is audit-logged. Failures never throw —
// release is the source of truth.
export async function notifyResultReleased({
  testRequestId,
  visitId,
  releaseMedium,
  bulkBatchId,
}: Input): Promise<ReleaseNoticeOutcome> {
  const admin = createAdminClient();

  const { data: row } = await admin
    .from("test_requests")
    .select(
      `
        id, visit_id,
        services!inner ( name, kind ),
        visits!inner (
          id,
          is_sample,
          patients!inner ( id, drm_id, first_name, phone, email )
        )
      `,
    )
    .eq("id", testRequestId)
    // A patient must never be told "your lab result is ready" for a deleted
    // line or a line on a deleted visit (0125).
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .maybeSingle();

  if (!row) return noticeSkipped("test not found");
  const visit = Array.isArray(row.visits) ? row.visits[0] : row.visits;
  if (!visit) return noticeSkipped("visit not found");
  const patient = Array.isArray(visit.patients)
    ? visit.patients[0]
    : visit.patients;
  const svc = Array.isArray(row.services) ? row.services[0] : row.services;
  if (!patient || !svc) return noticeSkipped("patient or test not found");

  // A doctor line has no result to collect, so there is nothing to announce:
  // this message says "Your DRMed lab result is ready" and links the portal,
  // where a consultation shows no document. The visit page routes doctor work
  // to "Mark done" (which never calls here), but this is the last line of
  // defence — every release path in the app funnels through this function,
  // and one of them reached it with a consultation before (undo a released
  // consult → it parks at ready_for_release → the generic Release button).
  // Cheaper to refuse by kind here than to re-audit every caller.
  if (isDoctorKind(svc.kind)) return noticeSkipped("consultation — nothing to announce");

  // M7: physical hand-off (printout collected in person) — record the notified
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
      resource_id: testRequestId,
      metadata: {
        visit_id: visitId,
        test_name: svc.name,
        release_medium: releaseMedium,
        sms: skipped,
        email: skipped,
        review_cta: { shown: false },
        ...(bulkBatchId ? { bulk_batch_id: bulkBatchId } : {}),
      },
    });
    return noticeSkipped(skipReason);
  }

  const testName = svc.name;

  // Review CTA: only on a patient's FIRST delivered result email, and only if
  // they have an email on file. Suppressed thereafter via the audit flag.
  const hasEmail = Boolean(patient.email);
  const alreadyAsked = hasEmail
    ? await patientAlreadyAskedForReview(admin, patient.id)
    : false;
  const includeReviewCta = hasEmail && !alreadyAsked;

  const { smsBody, emailSubject, emailText, emailHtml } = renderSingleNotice({
    patient,
    testName,
    includeReviewCta,
  });

  const recipient = await checkPatientRecipient(admin, patient.id);
  if (recipient.kind !== "active") {
    await auditSkippedInactiveRecipient({
      sender: "notify-released",
      patientId: patient.id,
      reason: recipient.kind === "inactive" ? recipient.reason : "walk_in",
      resourceType: "test_request",
      resourceId: testRequestId,
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
      scope: "notify/result-released:sms",
      error: new Error(smsResult.error),
      metadata: { test_request_id: testRequestId, visit_id: visitId },
    });
  }
  if (!emailResult.ok && emailResult.kind === "error") {
    await reportError({
      scope: "notify/result-released:email",
      error: new Error(emailResult.error),
      metadata: { test_request_id: testRequestId, visit_id: visitId },
    });
  }

  await audit({
    actor_id: null,
    actor_type: "system",
    patient_id: patient.id,
    action: "result.notified",
    resource_type: "test_request",
    resource_id: testRequestId,
    metadata: {
      visit_id: visitId,
      test_name: testName,
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
      ...(bulkBatchId ? { bulk_batch_id: bulkBatchId } : {}),
    },
  });
  return noticeFromChannels(smsResult, emailResult);
}
