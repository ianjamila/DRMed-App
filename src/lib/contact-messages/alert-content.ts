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
import type { ContactMessageKind } from "./labels";

/** Parse `CONTACT_ALERT_EMAILS` — comma-separated, each trimmed and validated
 * as a plausible email address; invalid entries are dropped rather than
 * failing the whole list, and duplicates (case-insensitive) are collapsed. */
export function parseAlertEmailsEnv(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const email = part.trim();
    if (!email || !EMAIL_RE.test(email)) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export interface AlertEmailInput {
  name: string;
  subject: string | null;
  kind: ContactMessageKind;
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
  const subjectLabel = input.subject?.trim() || "General";
  const isCorporate = input.kind === "corporate";
  const received = manilaDateTime(input.createdAt);

  const emailSubject = `${isCorporate ? "[Corporate lead] " : ""}New website message: ${subjectLabel}`;

  const text = [
    `A new website message came in from ${first}.`,
    `Subject: ${subjectLabel}`,
    isCorporate ? "This is a Corporate / HMO lead." : null,
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
        { label: "Received", value: received },
      ]) +
      emailButton("Open the message", input.messageUrl, "cyan"),
    receivedNote: "You're receiving this because you're on the Website Messages alert list.",
  });

  return { subject: emailSubject, text, html };
}
