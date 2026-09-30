// The staff "Results released" alert email (Admin Tools › Email Alerts, alert
// key `result_released`, migration 0192). Pure — no DB, no server-only — so the
// privacy rule below is unit-tested.
//
// RA 10173: the email carries the patient's first name + last INITIAL, the
// visit number and a COUNT of results — never test names, result values, the
// full surname or contact details (owner decision 2026-09-30, same posture as
// the online-booking alert). Staff sign in to see the rest. Enforced
// structurally: ReleaseAlertInput has no field for a test name, a phone or an
// email. The button opens the visit page, where reception prints the results.
import {
  emailButton,
  emailDetailBox,
  emailParagraph,
  escapeHtml,
  renderEmailShell,
} from "@/lib/notifications/branded-email";

export interface ReleaseAlertInput {
  firstName: string | null;
  lastName: string | null;
  visitNumber: string;
  /** How many results were released in this action. */
  count: number;
  visitUrl: string;
}

export interface ReleaseAlertContent {
  subject: string;
  text: string;
  html: string;
}

/** Names are typed by staff/patients and land in a subject line: strip control
 * characters (header injection), collapse whitespace, cap the length. */
function clean(value: string | null | undefined, max: number): string {
  const s = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "Ian J." — first name + last initial; "A patient" when there is no first name. */
export function patientShortName(firstName: string | null, lastName: string | null): string {
  const first = clean(firstName, 40);
  if (!first) return "A patient";
  const initial = Array.from(clean(lastName, 40))[0];
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

export function releaseCountLabel(count: number): string {
  return count === 1 ? "1 result" : `${count} results`;
}

export function buildReleaseAlertEmail(input: ReleaseAlertInput): ReleaseAlertContent {
  const who = patientShortName(input.firstName, input.lastName);
  const visit = clean(input.visitNumber, 40);
  const countLabel = releaseCountLabel(input.count);

  const subject = `${countLabel} released for ${who} — visit #${visit}`;
  const intro = `${countLabel} ${input.count === 1 ? "was" : "were"} released for ${who} (visit #${visit}). They can be printed from the visit page.`;

  const text = [
    intro,
    "",
    `Open the visit: ${input.visitUrl}`,
    "",
    'You\'re receiving this because you\'re switched on for the "Results released" alert. An admin can change who gets it under Admin Tools › Email Alerts.',
  ].join("\n");

  const html = renderEmailShell({
    heading: "Results released",
    contentHtml:
      emailParagraph(escapeHtml(intro)) +
      emailDetailBox([
        { label: "Patient", value: who },
        { label: "Visit", value: `#${visit}` },
        { label: "Results", value: countLabel },
      ]) +
      emailButton("Open the visit", input.visitUrl, "cyan"),
    receivedNote:
      'You\'re receiving this because you\'re switched on for the "Results released" alert. An admin can change who gets it under Admin Tools › Email Alerts.',
  });

  return { subject, text, html };
}
