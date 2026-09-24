import { z } from "zod";
import { knownContactSubject } from "@/lib/contact-messages/labels";

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
  message: z
    .string()
    .trim()
    .min(10, "Please tell us a little more (at least 10 characters).")
    .max(5000),
});

export type ContactInput = z.infer<typeof ContactSchema>;
