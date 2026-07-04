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
  visitId: string;
  testRequestIds: string[];
  testNames: string[];
}

const MAX_LISTED = 6;

// Fired by the bulk-release server action (releaseAllReadyComponentsAction).
// Sends ONE consolidated SMS + email covering every component released in
// that action, instead of one message per component. Pulls the patient off
// the visit, sends via Semaphore/Resend in parallel, audit-logs the outcome.
// Failures never throw — release is the source of truth.
export async function notifyResultsReleasedBulk({
  visitId,
  testRequestIds,
  testNames,
}: Input): Promise<void> {
  if (testRequestIds.length === 0) return;
  const admin = createAdminClient();

  const { data: visit } = await admin
    .from("visits")
    .select(
      `
        id,
        patients!inner ( id, drm_id, first_name, phone, email )
      `,
    )
    .eq("id", visitId)
    .maybeSingle();

  if (!visit) return;
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) return;

  const count = testNames.length;
  const portalUrl = `${SITE.url.replace(/\/$/, "")}/portal`;
  const greeting = patient.first_name || "there";

  // Review CTA: only on a patient's FIRST delivered result email, and only if
  // they have an email on file. Suppressed thereafter via the audit flag.
  const hasEmail = Boolean(patient.email);
  const alreadyAsked = hasEmail
    ? await patientAlreadyAskedForReview(admin, patient.id)
    : false;
  const includeReviewCta = hasEmail && !alreadyAsked;
  const reviewUrl = reviewLinkAbsolute(SITE.url, "email");

  const smsBody =
    `Hi ${greeting}, ${count} result${count === 1 ? "" : "s"} from your DRMed visit ${count === 1 ? "is" : "are"} ready. ` +
    `Sign in at ${portalUrl} with DRM-ID ${patient.drm_id} and your Secure PIN. — DRMED`;

  const listedNames = testNames.slice(0, MAX_LISTED);
  const extraCount = testNames.length - listedNames.length;

  const emailSubject = `${count} lab result${count === 1 ? "" : "s"} ready — DRMed`;
  const emailText = [
    `Hi ${greeting},`,
    "",
    `${count} result${count === 1 ? "" : "s"} from your visit have been released:`,
    ...listedNames.map((n) => `  - ${n}`),
    ...(extraCount > 0 ? [`  + ${extraCount} more`] : []),
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

  const testNameRows = [
    ...listedNames.map((n) => ({ label: "Result", value: n })),
    ...(extraCount > 0 ? [{ label: "", value: `+${extraCount} more` }] : []),
  ];

  const emailHtml = renderEmailShell({
    heading: "Your lab results are ready",
    contentHtml:
      emailParagraph(`Hi <b>${escapeHtml(greeting)}</b>,`) +
      emailParagraph(`<b>${count} result${count === 1 ? "" : "s"}</b> from your visit have been released. You can view and download them securely in the patient portal.`) +
      emailDetailBox(testNameRows) +
      emailDetailBox([
        { label: "DRM-ID", value: patient.drm_id },
        { label: "Secure PIN", value: "printed on your receipt" },
      ]) +
      emailButton("Sign in to view your results", portalUrl, "cyan") +
      emailFinePrint("Your PIN is valid for 60 days. Keep it private — anyone with your PIN can view your lab results.") +
      (includeReviewCta ? emailReviewCta(reviewUrl) : ""),
    receivedNote: "You received this because results were released for your DRMed visit.",
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
        ? { ok: true, id: emailResult.id, to: patient.email }
        : emailResult.kind === "skipped"
          ? { ok: false, skipped: true, reason: emailResult.reason }
          : { ok: false, error: emailResult.error, to: patient.email },
      review_cta: { shown: includeReviewCta && emailResult.ok },
      bulk: true,
      count,
      test_names: testNames,
      test_request_ids: testRequestIds,
    },
  });
}
