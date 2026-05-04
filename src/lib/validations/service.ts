import { z } from "zod";

export const SERVICE_KINDS = [
  "lab_test",
  "lab_package",
  "doctor_consultation",
  "doctor_procedure",
  "home_service",
  "vaccine",
] as const;

export const SERVICE_SECTIONS = [
  "package",
  "chemistry",
  "hematology",
  "immunology",
  "urinalysis",
  "microbiology",
  "imaging_xray",
  "imaging_ultrasound",
  "vaccine",
  "send_out",
  "consultation",
  "procedure",
  "home_service",
] as const;

const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.null()])
  .transform((v) => v === "on" || v === "true");

const optionalNumber = z
  .string()
  .or(z.literal(""))
  .transform((v) => (v === "" ? null : Number(v)))
  .pipe(z.number().nonnegative("Must be 0 or greater.").nullable())
  .nullable();

const optionalText = z
  .string()
  .trim()
  .max(2000)
  .or(z.literal(""))
  .transform((v) => (v === "" ? null : v))
  .nullable();

export const ServiceSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Code is required.")
    .max(40)
    .regex(/^[A-Z0-9_-]+$/, "Code can only contain A-Z, 0-9, underscore, dash."),
  name: z.string().trim().min(1, "Name is required.").max(160),
  description: optionalText,
  price_php: z
    .string()
    .transform((v) => Number(v))
    .pipe(z.number().nonnegative("Price must be 0 or greater.")),
  hmo_price_php: optionalNumber,
  senior_discount_php: optionalNumber,
  turnaround_hours: z
    .string()
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : Number(v)))
    .pipe(z.number().int().positive().nullable())
    .nullable(),
  kind: z.enum(SERVICE_KINDS),
  section: z
    .union([z.enum(SERVICE_SECTIONS), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  is_send_out: checkbox,
  send_out_lab: optionalText,
  is_active: checkbox,
  requires_signoff: checkbox,
});

export type ServiceInput = z.infer<typeof ServiceSchema>;
