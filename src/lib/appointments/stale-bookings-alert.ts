// The staff "Bookings not acted on" reminder email (Admin Tools › Email Alerts,
// alert key `stale_bookings`, migration 0186), sent each morning by
// /api/cron/stale-bookings. Pure — no DB, no server-only — so the privacy rule
// below is unit-tested.
//
// RA 10173: the email carries NO contact details and NO test or service
// names. Per booking it says who (first name only) and how long ago they
// booked, and flags the likely no-shows. Staff sign in to see the rest.
// Enforced structurally: StaleBookingLine has no field for anything else.
import {
  emailAmountTable,
  emailButton,
  emailFinePrint,
  emailParagraph,
  escapeHtml,
  renderEmailShell,
} from "@/lib/notifications/branded-email";
import { firstNameOf } from "@/lib/contact-messages/first-name";
import { REMIND_UNTIMED_AFTER_DAYS, STALE_UNTIMED_AFTER_DAYS, bookingAgeLabel } from "./stale";

export interface StaleBookingLine {
  /** Null (or blank) when the name is unknown or must not be shown. */
  firstName: string | null;
  ageDays: number;
  likelyNoShow: boolean;
}

export interface StaleBookingsAlertInput {
  /** Oldest first. */
  bookings: readonly StaleBookingLine[];
  appointmentsUrl: string;
}

export interface StaleBookingsAlertContent {
  subject: string;
  text: string;
  html: string;
}

/** The email lists at most this many bookings; the rest are counted. */
export const STALE_ALERT_MAX_LINES = 30;

function bookingsWord(n: number): string {
  return n === 1 ? "1 booking" : `${n} bookings`;
}

function lineName(line: StaleBookingLine): string {
  const first = firstNameOf(line.firstName);
  return first === "there" ? "A patient" : first;
}

export function buildStaleBookingsAlertEmail(input: StaleBookingsAlertInput): StaleBookingsAlertContent {
  const total = input.bookings.length;
  const likely = input.bookings.filter((b) => b.likelyNoShow).length;
  const shown = input.bookings.slice(0, STALE_ALERT_MAX_LINES);
  const more = total - shown.length;

  const subject =
    likely > 0
      ? `DRMed: ${bookingsWord(total)} not acted on (${likely} likely no-show${likely === 1 ? "" : "s"})`
      : `DRMed: ${bookingsWord(total)} not acted on`;

  const intro = `${bookingsWord(total)} with no set time ${total === 1 ? "has" : "have"} waited ${REMIND_UNTIMED_AFTER_DAYS} days or more without being marked arrived, no-show or cancelled.`;
  const likelyLine =
    likely > 0
      ? `${likely} of them ${likely === 1 ? "is" : "are"} ${STALE_UNTIMED_AFTER_DAYS} days or older — likely no-shows. The Appointments page can mark those in one go.`
      : "";
  const advice =
    "Call the newer ones if you can. If a patient says they are still coming, leave their booking alone.";

  const label = (b: StaleBookingLine) => `${lineName(b)}${b.likelyNoShow ? " — likely no-show" : ""}`;

  const text = [
    intro,
    likelyLine,
    advice,
    "",
    ...shown.map((b) => `- ${label(b)}: ${bookingAgeLabel(b.ageDays)}`),
    more > 0 ? `…and ${more} more.` : "",
    "",
    `Open Appointments: ${input.appointmentsUrl}`,
  ]
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n");

  const html = renderEmailShell({
    heading: "Bookings not acted on",
    contentHtml:
      emailParagraph(escapeHtml(intro)) +
      (likelyLine ? emailParagraph(escapeHtml(likelyLine)) : "") +
      emailAmountTable(shown.map((b) => ({ label: label(b), amount: bookingAgeLabel(b.ageDays) }))) +
      (more > 0 ? emailFinePrint(escapeHtml(`…and ${more} more on the Appointments page.`)) : "") +
      emailParagraph(escapeHtml(advice)) +
      emailButton("Open Appointments", input.appointmentsUrl, "cyan"),
    receivedNote:
      'You\'re receiving this because you\'re switched on for the "Bookings not acted on" alert. An admin can change who gets it under Admin Tools › Email Alerts.',
  });

  return { subject, text, html };
}
