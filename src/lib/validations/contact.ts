import { z } from "zod";

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
  subject: z.string().trim().max(160).nullable().or(z.literal("")),
  message: z
    .string()
    .trim()
    .min(10, "Please tell us a little more (at least 10 characters).")
    .max(5000),
});

export type ContactInput = z.infer<typeof ContactSchema>;
