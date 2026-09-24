// The staff "new online booking" alert email (Admin Tools › Email Alerts,
// alert key `online_booking`, migration 0157). Pure — no DB, no server-only —
// so the privacy rule below is unit-tested.
//
// RA 10173: the email carries NO contact details and NO test or service
// names (a service name can itself be health information). It says who booked
// (first name only), what kind of booking, when — or that they need a call
// back — how many services, and whether it came from the website or the
// patient portal. Staff sign in to see the rest. Enforced structurally:
// BookingAlertInput has no field for a phone, an email or a service name.
import { manilaDateTime } from "@/lib/dates/manila";
import {
  emailButton,
  emailDetailBox,
  emailParagraph,
  escapeHtml,
  renderEmailShell,
} from "@/lib/notifications/branded-email";
import { firstNameOf } from "@/lib/contact-messages/first-name";
import { BOOKING_BRANCH_LABEL } from "@/lib/appointments/labels";
import type { BookingBranch } from "@/lib/validations/booking";

export interface BookingAlertInput {
  firstName: string | null;
  branch: BookingBranch;
  /** The confirmed slot, when the booking has one. */
  scheduledAtIso: string | null;
  /** Reception must call the patient to set a time (doctor by appointment, home service, callback lab request). */
  pendingCallback: boolean;
  /** How many services were picked; 0 = a lab request uploaded as a form instead. */
  serviceCount: number;
  via: "website" | "portal";
  appointmentsUrl: string;
}

export interface BookingAlertContent {
  subject: string;
  text: string;
  html: string;
}

export function bookingWhenLabel(input: Pick<BookingAlertInput, "scheduledAtIso" | "pendingCallback">): string {
  if (input.pendingCallback) return "Needs a call back to set a time";
  if (input.scheduledAtIso) return manilaDateTime(input.scheduledAtIso);
  return "No fixed time — walk in during clinic hours";
}

export function bookingServicesLabel(serviceCount: number): string {
  if (serviceCount <= 0) return "Tests from an uploaded request form";
  return serviceCount === 1 ? "1 service" : `${serviceCount} services`;
}

export function buildBookingAlertEmail(input: BookingAlertInput): BookingAlertContent {
  const first = firstNameOf(input.firstName);
  const type = BOOKING_BRANCH_LABEL[input.branch];
  const when = bookingWhenLabel(input);
  const services = bookingServicesLabel(input.serviceCount);
  const via = input.via === "portal" ? "Patient portal" : "Website (Schedule page)";

  const subject = input.pendingCallback
    ? `[Call back] New online booking: ${type}`
    : `New online booking: ${type} — ${when}`;

  const intro = input.pendingCallback
    ? `${first} booked online and is waiting for a call back to set a time.`
    : `${first} booked online.`;

  const text = [
    intro,
    `Type: ${type}`,
    `When: ${when}`,
    `Services: ${services}`,
    `Booked through: ${via}`,
    "",
    `Open Appointments: ${input.appointmentsUrl}`,
  ].join("\n");

  const html = renderEmailShell({
    heading: input.pendingCallback ? "New online booking — call back needed" : "New online booking",
    contentHtml:
      emailParagraph(escapeHtml(intro).replace(escapeHtml(first), `<b>${escapeHtml(first)}</b>`)) +
      emailDetailBox([
        { label: "Type", value: type },
        { label: "When", value: when },
        { label: "Services", value: services },
        { label: "Booked through", value: via },
      ]) +
      emailButton("Open Appointments", input.appointmentsUrl, "cyan"),
    receivedNote:
      'You\'re receiving this because you\'re switched on for the "New online booking" alert. An admin can change who gets it under Admin Tools › Email Alerts.',
  });

  return { subject, text, html };
}
