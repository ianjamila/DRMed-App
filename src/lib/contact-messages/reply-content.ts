// Pure, unit-testable pieces of "reply to a website message from inside the
// app": the zod validation schema, the SMS segment counter + sign-off
// builder, the email body builder (HTML + plain text, no original message
// quoted), and the quick-start reply templates. Split out of actions.ts
// (which is "use server", and pulls in cookies/RLS-client machinery) so this
// stays testable with plain vitest — no server-only imports here.
//
// PRIVACY: buildEmailReply's input has no field for the sender's original
// message — if they mistyped their own address, their health question must
// never be echoed back to whoever now holds that mailbox. That is enforced
// structurally here, the same way alert-content.ts's AlertEmailInput has no
// message/phone/email field.

import { z } from "zod";
import { CONTACT, SITE } from "@/lib/marketing/site";
import { emailParagraph, escapeHtml, renderEmailShell } from "@/lib/notifications/branded-email";
import { REPLY_BODY_MAX, REPLY_CHANNELS, REPLY_SMS_MAX } from "./labels";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const ReplyInputSchema = z
  .object({
    messageId: z.string().uuid(),
    channel: z.enum(REPLY_CHANNELS),
    body: z
      .string()
      .trim()
      .min(1, "Write a reply before sending.")
      .max(REPLY_BODY_MAX, `A reply must be ${REPLY_BODY_MAX} characters or fewer.`),
  })
  .superRefine((val, ctx) => {
    if (val.channel === "sms" && val.body.length > REPLY_SMS_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: `A text message reply must be ${REPLY_SMS_MAX} characters or fewer.`,
      });
    }
  });

export type ReplyInput = z.infer<typeof ReplyInputSchema>;

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

const SMS_SEGMENT_LEN = 160;

/** How many 160-char SMS segments `text` will bill as. 0 for empty text. */
export function smsSegmentCount(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / SMS_SEGMENT_LEN);
}

export const SMS_SIGNOFF = " – DR Med";

/** Appends a short sign-off to the staff's SMS text, but only when it still
 * fits within REPLY_SMS_MAX — the body alone is the fallback, and the result
 * never exceeds the cap either way. */
export function buildSmsReplyBody(staffText: string): string {
  const trimmed = staffText.trim();
  const withSignoff = `${trimmed}${SMS_SIGNOFF}`;
  return withSignoff.length <= REPLY_SMS_MAX ? withSignoff : trimmed;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export interface BuildEmailReplyInput {
  firstName: string;
  /** The website message's own subject line, if any — used only to build
   * "Re: <subject>"; the message BODY is never available to this function. */
  subject: string | null;
  /** The staff-written reply. Blank lines separate paragraphs; single line
   * breaks inside a paragraph become <br> in the HTML part. */
  staffText: string;
}

export interface EmailReplyContent {
  subject: string;
  text: string;
  html: string;
}

function paragraphsOf(text: string): string[] {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Builds the subject/text/html for a staff reply email. Never includes the
 * sender's original message — see the file header. */
export function buildEmailReply(input: BuildEmailReplyInput): EmailReplyContent {
  const subjectLabel = input.subject?.trim();
  const subject = subjectLabel ? `Re: ${subjectLabel}` : "Re: your message to DR Med";
  const greeting = `Hi ${input.firstName},`;
  const paragraphs = paragraphsOf(input.staffText);
  const signOffLines = [`— ${SITE.name}`, `${CONTACT.phone.mobile} · ${CONTACT.phone.landline}`];

  const text = [greeting, "", ...paragraphs, "", ...signOffLines].join("\n");

  const html = renderEmailShell({
    contentHtml:
      emailParagraph(escapeHtml(greeting)) +
      paragraphs.map((p) => emailParagraph(escapeHtml(p).replace(/\n/g, "<br>"))).join("") +
      emailParagraph(
        `— <b>${escapeHtml(SITE.name)}</b><br>${escapeHtml(CONTACT.phone.mobile)} · ${escapeHtml(CONTACT.phone.landline)}`,
      ),
    receivedNote: "You're receiving this because you contacted DRMed through our website.",
  });

  return { subject, text, html };
}

// ---------------------------------------------------------------------------
// Quick-start templates
// ---------------------------------------------------------------------------

export interface ReplyTemplate {
  id: string;
  label: string;
  body: string;
}

/** Editable starting points for a reply, in the clinic's own words. Staff can
 * change every word before sending — these just save the retyping. */
export function replyTemplates(firstName: string): ReplyTemplate[] {
  const shortAddress = `${CONTACT.address.line1}, ${CONTACT.address.line2}, ${CONTACT.address.city}`;
  return [
    {
      id: "thanks-call",
      label: "Thanks — we'll call you",
      body: `Hi ${firstName}, thank you for reaching out to ${SITE.shortName}. We received your message and one of our staff will call you shortly to help. If you'd like to reach us first, call ${CONTACT.phone.mobile}.`,
    },
    {
      id: "prices-hours",
      label: "Prices & hours",
      body: `Hi ${firstName}, thanks for your interest! We're open ${CONTACT.hours} at ${shortAddress}. Call us at ${CONTACT.phone.mobile} and we'll be happy to give you the current prices.`,
    },
    {
      id: "good-time",
      label: "Ask for a good time to call",
      body: `Hi ${firstName}, thanks for reaching out! Could you reply and let us know a good time for us to call you? You can also reach us directly at ${CONTACT.phone.mobile}.`,
    },
  ];
}
