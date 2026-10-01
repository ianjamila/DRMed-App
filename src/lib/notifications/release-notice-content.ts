import { SITE } from "@/lib/marketing/site";
import { reviewLinkAbsolute } from "@/lib/seo/review";
import { STATEMENT_NOTE } from "./statement-note";
import { PORTAL_URL } from "./portal-url";
import {
  renderEmailShell, emailParagraph, emailDetailBox, emailButton, emailFinePrint, escapeHtml, emailReviewCta,
} from "./branded-email";

// The "your result is ready" message bodies, shared by the legacy one-shot
// senders (notify-released.ts, notify-released-bulk.ts) and the outbox sender
// (release-notice-sender.ts) so the wording lives in ONE place. Pure: no
// database, no provider call.

export const MAX_LISTED = 6;

export interface NoticeRecipient {
  drm_id: string;
  first_name: string | null;
}

export interface RenderedNotice {
  smsBody: string;
  emailSubject: string;
  emailText: string;
  emailHtml: string;
}

const PIN_NOTE = "Your PIN is valid for 60 days. Keep it private — anyone with your PIN can view your lab results.";

/** One test announced on its own. */
export function renderSingleNotice(args: {
  patient: NoticeRecipient;
  testName: string;
  includeReviewCta: boolean;
}): RenderedNotice {
  const { patient, testName, includeReviewCta } = args;
  const portalUrl = PORTAL_URL;
  const greeting = patient.first_name || "there";
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
    PIN_NOTE,
    "",
    STATEMENT_NOTE,
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
      emailFinePrint(PIN_NOTE) +
      emailFinePrint(escapeHtml(STATEMENT_NOTE)) +
      (includeReviewCta ? emailReviewCta(reviewUrl) : ""),
    receivedNote: "You received this because a result was released for your DRMed visit.",
  });

  return { smsBody, emailSubject, emailText, emailHtml };
}

/** Several tests announced in one consolidated message. */
export function renderBulkNotice(args: {
  patient: NoticeRecipient;
  testNames: readonly string[];
  includeReviewCta: boolean;
}): RenderedNotice {
  const { patient, testNames, includeReviewCta } = args;
  const portalUrl = PORTAL_URL;
  const greeting = patient.first_name || "there";
  const reviewUrl = reviewLinkAbsolute(SITE.url, "email");
  const count = testNames.length;

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
    PIN_NOTE,
    "",
    STATEMENT_NOTE,
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
      emailFinePrint(PIN_NOTE) +
      emailFinePrint(escapeHtml(STATEMENT_NOTE)) +
      (includeReviewCta ? emailReviewCta(reviewUrl) : ""),
    receivedNote: "You received this because results were released for your DRMed visit.",
  });

  return { smsBody, emailSubject, emailText, emailHtml };
}
