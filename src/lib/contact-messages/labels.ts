// Website Messages inbox vocabulary — `contact_messages.status` / `.kind`
// (migration 0154). Client-safe (no server-only), shared by the public contact
// form, its server action, the staff inbox and the dashboards.
//
// Values are pinned to 0154's CHECK constraints by
// website-messages-schema.test.ts.

export const CONTACT_MESSAGE_STATUSES = ["new", "replied", "booked", "closed"] as const;
export type ContactMessageStatus = (typeof CONTACT_MESSAGE_STATUSES)[number];

export const CONTACT_MESSAGE_STATUS_LABEL: Record<ContactMessageStatus, string> = {
  new: "New",
  replied: "Replied",
  booked: "Booked",
  closed: "Closed",
};

// One-line hint shown beside each status in the inbox, in reception's words.
export const CONTACT_MESSAGE_STATUS_HINT: Record<ContactMessageStatus, string> = {
  new: "Nobody has replied yet.",
  replied: "We've contacted them. Waiting on them to book or decide.",
  booked: "An appointment was made from this message.",
  closed: "Nothing more to do (answered, not interested, or spam).",
};

export const CONTACT_MESSAGE_KINDS = ["general", "corporate"] as const;
export type ContactMessageKind = (typeof CONTACT_MESSAGE_KINDS)[number];

export const CONTACT_MESSAGE_KIND_LABEL: Record<ContactMessageKind, string> = {
  general: "General",
  corporate: "Corporate / HMO lead",
};

// The contact form's subject that marks a company / HMO enquiry. The form's
// <select> option, the server action's Meta "Lead" event and the `kind`
// classification all read this one constant. 0154's backfill matches the same
// literal — change both together.
export const CORPORATE_SUBJECT = "Corporate / HMO";

// Every subject the public form offers, in display order.
export const CONTACT_SUBJECT_OPTIONS = [
  "Doctor's Consultation",
  "Laboratory Tests",
  "X-Ray Imaging",
  "ECG",
  "Ultrasound",
  "Home Service",
  CORPORATE_SUBJECT,
  "Other",
] as const;

export function contactMessageKindForSubject(subject: string | null | undefined): ContactMessageKind {
  return subject === CORPORATE_SUBJECT ? "corporate" : "general";
}

export function isContactMessageStatus(value: unknown): value is ContactMessageStatus {
  return typeof value === "string" && (CONTACT_MESSAGE_STATUSES as ReadonlyArray<string>).includes(value);
}

export function isContactMessageKind(value: unknown): value is ContactMessageKind {
  return typeof value === "string" && (CONTACT_MESSAGE_KINDS as ReadonlyArray<string>).includes(value);
}

// Which copy of the public contact form a message was sent from —
// `contact_messages.form_location` (migration 0156). The form is on the
// Contact page and in the home page's "Send us a message" section; messages
// received before 0156 are NULL and read "Not recorded".
export const CONTACT_FORM_LOCATIONS = ["home", "contact"] as const;
export type ContactFormLocation = (typeof CONTACT_FORM_LOCATIONS)[number];

export const CONTACT_FORM_LOCATION_LABEL: Record<ContactFormLocation, string> = {
  home: "Home page",
  contact: "Contact page",
};

export const FORM_LOCATION_NOT_RECORDED_LABEL = "Not recorded";

export function isContactFormLocation(value: unknown): value is ContactFormLocation {
  return typeof value === "string" && (CONTACT_FORM_LOCATIONS as ReadonlyArray<string>).includes(value);
}

export function contactFormLocationLabel(value: string | null | undefined): string {
  return isContactFormLocation(value) ? CONTACT_FORM_LOCATION_LABEL[value] : FORM_LOCATION_NOT_RECORDED_LABEL;
}

export function contactMessageStatusLabel(status: string | null | undefined): string {
  return isContactMessageStatus(status) ? CONTACT_MESSAGE_STATUS_LABEL[status] : "Unknown";
}

export const STAFF_NOTES_MAX = 2000;

// Replies sent from inside the app — `contact_message_replies` (0154).
export const REPLY_CHANNELS = ["email", "sms"] as const;
export type ReplyChannel = (typeof REPLY_CHANNELS)[number];

export const REPLY_CHANNEL_LABEL: Record<ReplyChannel, string> = {
  email: "Email",
  sms: "Text message",
};

export const REPLY_OUTCOMES = ["sent", "failed", "skipped"] as const;
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];

export const REPLY_OUTCOME_LABEL: Record<ReplyOutcome, string> = {
  sent: "Sent",
  failed: "Not sent — the provider refused it",
  skipped: "Not sent — notifications are off in this environment",
};

// 0154's contact_message_replies_body_len cap. An email reply may use all of
// it; a text is capped far lower in the app (REPLY_SMS_MAX) because every 160
// characters is another billed SMS segment.
export const REPLY_BODY_MAX = 5000;
export const REPLY_SMS_MAX = 480;

export function isReplyChannel(value: unknown): value is ReplyChannel {
  return typeof value === "string" && (REPLY_CHANNELS as ReadonlyArray<string>).includes(value);
}

export function isReplyOutcome(value: unknown): value is ReplyOutcome {
  return typeof value === "string" && (REPLY_OUTCOMES as ReadonlyArray<string>).includes(value);
}

// Anything a website visitor typed that ends up on ONE line of a staff-facing
// email — the subject line above all, where a line break could forge extra
// headers and a long run of text reads like a message from the clinic. The
// public form's own validation already restricts `subject` to
// CONTACT_SUBJECT_OPTIONS; this is the second line of defence for rows written
// before that rule and for any future caller. Strips control characters,
// collapses whitespace, caps the length with an ellipsis.
export function oneLine(value: string | null | undefined, max: number): string {
  const cleaned = (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// The subject a stored message may carry, as the form offers it — or null.
export function knownContactSubject(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return (CONTACT_SUBJECT_OPTIONS as ReadonlyArray<string>).includes(v) ? v : null;
}
