import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { reportError } from "@/lib/observability/report-error";
import { SITE } from "@/lib/marketing/site";
import { reviewLinkAbsolute } from "@/lib/seo/review";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import {
  renderEmailShell, emailParagraph, emailDetailBox, emailButton, emailFinePrint, escapeHtml, emailReviewCta,
} from "./branded-email";
import { patientAlreadyAskedForReview } from "./review-cta";

interface Input {
  testRequestId: string;
  visitId: string;
  // How the result was handed over. A physical/pickup hand-off means the
  // patient collected the printout in person — no message is sent (M7).
  releaseMedium: string;
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
}: Input): Promise<void> {
  const admin = createAdminClient();

  const { data: row } = await admin
    .from("test_requests")
    .select(
      `
        id, visit_id,
        services!inner ( name ),
        visits!inner (
          id,
          patients!inner ( id, drm_id, first_name, phone, email )
        )
      `,
    )
    .eq("id", testRequestId)
    .maybeSingle();

  if (!row) return;
  const visit = Array.isArray(row.visits) ? row.visits[0] : row.visits;
  if (!visit) return;
  const patient = Array.isArray(visit.patients)
    ? visit.patients[0]
    : visit.patients;
  const svc = Array.isArray(row.services) ? row.services[0] : row.services;
  if (!patient || !svc) return;

  // M7: physical hand-off (printout collected in person) — record the notified
  // audit row as skipped on both channels and send nothing.
  if (releaseMedium === "physical" || releaseMedium === "pickup") {
    const skipped = {
      ok: false as const,
      skipped: true as const,
      reason: "physical hand-off — no message sent",
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
      },
    });
    return;
  }

  const portalUrl = `${SITE.url.replace(/\/$/, "")}/portal`;
  const greeting = patient.first_name || "there";
  const testName = svc.name;

  // Review CTA: only on a patient's FIRST delivered result email, and only if
  // they have an email on file. Suppressed thereafter via the audit flag.
  const hasEmail = Boolean(patient.email);
  const alreadyAsked = hasEmail
    ? await patientAlreadyAskedForReview(admin, patient.id)
    : false;
  const includeReviewCta = hasEmail && !alreadyAsked;
  const reviewUrl = reviewLinkAbsolute(SITE.url, "email");

  const smsBody =
    `Hi ${greeting}, your DRMed lab result for ${testName} is ready. ` +
    `Sign in at ${portalUrl} with DRM-ID ${patient.drm_id} and your Secure PIN. — DRMED`;

  const emailSubject = `Your DRMed lab result is ready (${testName})`;
  const emailText = [
    `Hi ${greeting},`,
    "",
    `Your laboratory result for ${testName} has been released.`,
    "",
    `Sign in at ${portalUrl} with:`,
    `  DRM-ID: ${patient.drm_id}`,
    `  Secure PIN: (printed on your receipt)`,
    "",
    "Your PIN is valid for 60 days. Keep it private — anyone with your PIN can view your lab results.",
    ...(includeReviewCta
      ? [
          "",
          "How was your visit? A quick Google review helps other families find us:",
          reviewUrl,
        ]
      : []),
    "",
    "— DRMed Clinic and Laboratory",
  ].join("\n");

  const emailHtml = renderEmailShell({
    heading: "Your lab result is ready",
    contentHtml:
      emailParagraph(`Hi <b>${escapeHtml(greeting)}</b>,`) +
      emailParagraph(`Your laboratory result for <b>${escapeHtml(testName)}</b> has been released. You can view and download it securely in the patient portal.`) +
      emailDetailBox([
        { label: "DRM-ID", value: patient.drm_id },
        { label: "Secure PIN", value: "printed on your receipt" },
      ]) +
      emailButton("Sign in to view your result", portalUrl, "cyan") +
      emailFinePrint("Your PIN is valid for 60 days. Keep it private — anyone with your PIN can view your lab results.") +
      (includeReviewCta ? emailReviewCta(reviewUrl) : ""),
    receivedNote: "You received this because a result was released for your DRMed visit.",
  });

  const [smsResult, emailResult] = await Promise.all([
    patient.phone
      ? sendSms({ to: patient.phone, message: smsBody })
      : Promise.resolve({
          ok: false as const,
          kind: "skipped" as const,
          reason: "patient has no phone on file",
        }),
    patient.email
      ? sendEmail({
          to: patient.email,
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
        ? { ok: true, id: emailResult.id, to: patient.email }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error, to: patient.email },
      review_cta: { shown: includeReviewCta && emailResult.ok },
    },
  });
}
