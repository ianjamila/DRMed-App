// Pure builder for the day-before appointment reminder email. No `server-only`
// import so it can be unit-tested. The notifier resolves the fields and sends.
import {
  renderEmailShell, emailParagraph, emailDetailBox, emailButton, emailFinePrint, escapeHtml,
} from "./branded-email";

export interface ReminderEmailInput {
  greeting: string;
  serviceName: string;
  /** Pre-formatted Manila date/time, e.g. "June 18, 2026 at 9:00 AM". */
  when: string;
  cancelUrl: string;
  hasForm: boolean;
}

export function buildReminderEmail(input: ReminderEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { greeting, serviceName, when, cancelUrl, hasForm } = input;
  const subject = `Reminder — ${serviceName} tomorrow, ${when}`;
  const lines = [
    `Hi ${greeting},`,
    "",
    `This is a friendly reminder for your appointment tomorrow with DRMed Clinic and Laboratory.`,
    "",
    `Service: ${serviceName}`,
    `Date / time: ${when}`,
  ];
  if (hasForm) {
    lines.push(
      "",
      `We have your doctor's request form on file — no need to bring a printout.`,
    );
  }
  lines.push(
    "",
    `Need to cancel or reschedule? Open this link:`,
    `  ${cancelUrl}`,
    "",
    `Bring a valid ID. For HMO, please bring your card.`,
    "",
    "— DRMed Clinic and Laboratory",
  );
  const html = renderEmailShell({
    heading: "Appointment reminder",
    contentHtml:
      emailParagraph(`Hi <b>${escapeHtml(greeting)}</b>,`) +
      emailParagraph("This is a friendly reminder for your appointment tomorrow with DRMed Clinic &amp; Laboratory.") +
      emailDetailBox([
        { label: "Service", value: serviceName },
        { label: "Date / time", value: when },
      ]) +
      (hasForm ? emailParagraph("We have your doctor's request form on file — no need to bring a printout.") : "") +
      emailButton("View or cancel booking", cancelUrl, "navy") +
      emailFinePrint("Bring a valid ID. For HMO, please bring your card."),
  });
  return { subject, text: lines.join("\n"), html };
}
