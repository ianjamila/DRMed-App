import { z } from "zod";

export const ServiceSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Code is required.")
    .max(40)
    .regex(/^[A-Z0-9_-]+$/, "Code can only contain A-Z, 0-9, underscore, dash."),
  name: z.string().trim().min(1, "Name is required.").max(160),
  description: z
    .string()
    .trim()
    .max(2000)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  price_php: z
    .string()
    .transform((v) => Number(v))
    .pipe(z.number().nonnegative("Price must be 0 or greater.")),
  turnaround_hours: z
    .string()
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : Number(v)))
    .pipe(z.number().int().positive().nullable())
    .nullable(),
  is_active: z
    .union([z.literal("on"), z.literal("true"), z.literal("false"), z.null()])
    .transform((v) => v === "on" || v === "true"),
  requires_signoff: z
    .union([z.literal("on"), z.literal("true"), z.literal("false"), z.null()])
    .transform((v) => v === "on" || v === "true"),
});

export type ServiceInput = z.infer<typeof ServiceSchema>;
