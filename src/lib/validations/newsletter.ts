import { z } from "zod";

export const SUBSCRIBER_SOURCES = [
  "homepage_footer",
  "newsletter_page",
  "schedule_form",
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

export const ComposeCampaignSchema = z.object({
  subject: z
    .string()
    .trim()
    .min(1, "Subject is required.")
    .max(200, "Subject is too long."),
  body_md: z
    .string()
    .trim()
    .min(1, "Body is required.")
    .max(50_000, "Body is too long."),
});

export type SubscribeInput = z.infer<typeof SubscribeSchema>;
export type ComposeCampaignInput = z.infer<typeof ComposeCampaignSchema>;
