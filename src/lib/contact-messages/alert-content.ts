// Pure pieces of the new-website-message staff alert: recipient parsing and
// the email body itself. Split out of alert.ts (which is `server-only`) so
// this stays unit-testable — vitest can't import a `server-only` module.
//
// PRIVACY (RA 10173): the email must never carry the sender's message text,
// phone or email address — only their first name, subject, a corporate-lead
// flag, the received time, and a link to the message. Enforced structurally
// here: AlertEmailInput has no field for message/phone/email, so there is
// nothing for buildAlertEmail to leak.

import { manilaDateTime } from "@/lib/dates/manila";
import {
  renderEmailShell,
  emailParagraph,
  emailDetailBox,
  emailButton,
  escapeHtml,
} from "@/lib/notifications/branded-email";
import { firstNameOf } from "./first-name";
import { contactFormLocationLabel, oneLine } from "./labels";
import type { ContactFormLocation, ContactMessageKind } from "./labels";

export interface AlertEmailInput {
  name: string;
  subject: string | null;
  kind: ContactMessageKind;
  // Which page's form sent it (0156); null = not recorded.
  formLocation: ContactFormLocation | null;
  createdAt: string; // ISO timestamptz
  messageUrl: string;
}

export interface AlertEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** The subject/body for the staff "new website message" alert. Contains no
 * message text, phone number or email address — see the file header. */
export function buildAlertEmail(input: AlertEmailInput): AlertEmailContent {
  const first = firstNameOf(input.name);
  const subjectLabel = oneLine(input.subject, 80) || "General";
  const isCorporate = input.kind === "corporate";
  const received = manilaDateTime(input.createdAt);
  const sentFrom = contactFormLocationLabel(input.formLocation);

  const emailSubject = `${isCorporate ? "[Corporate lead] " : ""}New website message: ${subjectLabel}`;

  const text = [
    `A new website message came in from ${first}.`,
    `Subject: ${subjectLabel}`,
    isCorporate ? "This is a Corporate / HMO lead." : null,
    `Sent from: ${sentFrom}`,
    `Received: ${received}`,
    "",
    `Open it: ${input.messageUrl}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  const html = renderEmailShell({
    heading: "New website message",
    contentHtml:
      emailParagraph(`A new website message came in from <b>${escapeHtml(first)}</b>.`) +
      emailDetailBox([
        { label: "Subject", value: subjectLabel },
        ...(isCorporate ? [{ label: "Type", value: "Corporate / HMO lead" }] : []),
        { label: "Sent from", value: sentFrom },
        { label: "Received", value: received },
      ]) +
      emailButton("Open the message", input.messageUrl, "cyan"),
    receivedNote:
      "You're receiving this because you're switched on for the \"New website message\" alert. An admin can change who gets it under Admin Tools › Email Alerts.",
  });

  return { subject: emailSubject, text, html };
}
