import {
  emailButton,
  emailFinePrint,
  emailParagraph,
  escapeHtml,
  renderEmailShell,
} from "./branded-email";

export interface CorrectedResultMessageInput {
  firstName: string | null;
  testName: string;
  portalUrl: string;
}

export interface CorrectedResultMessages {
  sms: string;
  emailSubject: string;
  emailHtml: string;
}

/** Patient notice for a corrected result. No reason and no values — owner decision 2026-09-25. */
export function buildCorrectedResultMessages(
  i: CorrectedResultMessageInput,
): CorrectedResultMessages {
  const greeting = i.firstName ? `Hi ${i.firstName}, ` : "";
  const sms =
    `${greeting}an updated copy of your ${i.testName} result from DRMed is ready. ` +
    `Please view and download the latest version in the patient portal: ${i.portalUrl}`;

  const emailHtml = renderEmailShell({
    heading: "An updated copy of your result is ready",
    contentHtml:
      emailParagraph(
        `${i.firstName ? `Hi <b>${escapeHtml(i.firstName)}</b>, ` : ""}an updated copy of your <b>${escapeHtml(i.testName)}</b> result is ready. Please view and download the latest version securely in the patient portal.`,
      ) +
      emailButton("Open the patient portal", i.portalUrl, "cyan") +
      emailFinePrint("If you printed or saved an earlier copy, please use this updated one instead."),
    receivedNote: "You received this because a result from your DRMed visit was updated.",
  });

  return {
    sms,
    emailSubject: "An updated copy of your DRMed result is ready",
    emailHtml,
  };
}
