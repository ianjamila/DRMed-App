import { z } from "zod";

export const SUBSCRIBER_SOURCES = [
  "homepage_footer",
  "newsletter_page",
  "admin_added",
] as const;
export type SubscriberSource = (typeof SUBSCRIBER_SOURCES)[number];

export const SubscribeSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Email is required.")
    .email("Please enter a valid email.")
    .max(254)
    .transform((v) => v.toLowerCase()),
  source: z.enum(SUBSCRIBER_SOURCES),
});

export type SubscribeInput = z.infer<typeof SubscribeSchema>;
