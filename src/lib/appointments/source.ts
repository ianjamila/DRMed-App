// How a patient reached the clinic for an appointment — `appointments.source`
// (migration 0154). Client-safe: the staff slide-over, the appointments list,
// the Booking Sources report and the server actions all read this one list.
//
// The order and values are pinned to 0154's CHECK constraint by
// src/lib/contact-messages/website-messages-schema.test.ts — add a value in
// BOTH places, in the same PR.
import type { Attribution } from "@/lib/analytics/attribution";

export const APPOINTMENT_SOURCES = [
  "online_booking",
  "patient_portal",
  "website_message",
  "phone",
  "sms",
  "messenger",
  "walk_in",
  "referral",
  "other",
] as const;

export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

export const APPOINTMENT_SOURCE_LABEL: Record<AppointmentSource, string> = {
  online_booking: "Online booking",
  patient_portal: "Patient portal",
  website_message: "Website message",
  phone: "Phone call",
  sms: "Text message",
  messenger: "Facebook / Messenger",
  walk_in: "Walk-in",
  referral: "Referral",
  other: "Other",
};

// Rows booked before 0154 by staff carry NULL — the source was never asked.
export const SOURCE_NOT_RECORDED_LABEL = "Not recorded";

// Set by the system, never picked by staff: the public /schedule form and the
// patient portal stamp these themselves.
export const SYSTEM_SOURCES: ReadonlySet<AppointmentSource> = new Set([
  "online_booking",
  "patient_portal",
]);

// What the staff "+ New appointment" slide-over offers, in the order reception
// hears them most. `website_message` is included so a booking made by hand for
// someone who wrote in can still be counted, even when it did not start from
// the inbox's "Book appointment" button.
export const STAFF_SELECTABLE_SOURCES: ReadonlyArray<AppointmentSource> = APPOINTMENT_SOURCES.filter(
  (s) => !SYSTEM_SOURCES.has(s),
);

export function isAppointmentSource(value: unknown): value is AppointmentSource {
  return typeof value === "string" && (APPOINTMENT_SOURCES as ReadonlyArray<string>).includes(value);
}

export function appointmentSourceLabel(source: string | null | undefined): string {
  return isAppointmentSource(source) ? APPOINTMENT_SOURCE_LABEL[source] : SOURCE_NOT_RECORDED_LABEL;
}

// The attribution stored on an appointment / message is the cookie payload
// verbatim (src/lib/analytics/attribution.ts). A campaign label for reports:
// the utm_campaign, else "<source> / <medium>", else null (organic / direct).
export function attributionCampaignLabel(attribution: Attribution | null | undefined): string | null {
  if (!attribution || typeof attribution !== "object") return null;
  const campaign = typeof attribution.utm_campaign === "string" ? attribution.utm_campaign.trim() : "";
  if (campaign) return campaign;
  const src = typeof attribution.utm_source === "string" ? attribution.utm_source.trim() : "";
  const medium = typeof attribution.utm_medium === "string" ? attribution.utm_medium.trim() : "";
  if (src && medium) return `${src} / ${medium}`;
  return src || medium || null;
}
