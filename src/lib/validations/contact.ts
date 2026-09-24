import { z } from "zod";
import { isContactFormLocation, knownContactSubject } from "@/lib/contact-messages/labels";

export const ContactSchema = z.object({
  name: z.string().trim().min(1, "Please enter your name.").max(120),
  email: z
    .string()
    .trim()
    .email("Please enter a valid email.")
    .max(160)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  phone: z.string().trim().max(40).nullable().or(z.literal("")),
  // Only the subjects the form offers. The <select> cannot send anything
  // else, so a different value means a scripted post (or a stale cached form)
  // and is stored as "no subject" rather than rejected. It feeds the staff
  // alert's email subject line and the corporate-lead flag.
  subject: z
    .string()
    .trim()
    .max(160)
    .nullable()
    .or(z.literal(""))
    .transform((v) => knownContactSubject(v)),
  // Which page's copy of the form sent it (hidden field, 0156). Anything
  // outside the allow-list — a scripted post, a stale cached page — is stored
  // as "not recorded" rather than rejected, same as an unknown subject.
  formLocation: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (isContactFormLocation(v) ? v : null)),
  message: z
    .string()
    .trim()
    .min(10, "Please tell us a little more (at least 10 characters).")
    .max(5000),
});

export type ContactInput = z.infer<typeof ContactSchema>;
