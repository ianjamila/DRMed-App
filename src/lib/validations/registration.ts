import { z } from "zod";

const optionalText = (max: number) =>
  z.string().trim().max(max).or(z.literal("")).nullish().transform((v) => (v == null || v === "" ? null : v));

export const RegistrationSchema = z.object({
  first_name: z.string().trim().min(1, "First name is required.").max(80),
  last_name: z.string().trim().min(1, "Last name is required.").max(80),
  middle_name: optionalText(80),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Birthdate must be YYYY-MM-DD."),
  sex: z.union([z.literal(""), z.enum(["male", "female"])]).transform((v) => (v === "" ? null : v)).nullable(),
  phone: z.string().trim().min(7, "Phone is required.").max(40),
  // Email is required: it's the DRM-ID delivery channel AND the dedup key.
  email: z.string().trim().email("A valid email is required — we send your DRM-ID there.").max(160),
  address: optionalText(200),
  data_privacy_consent: z
    .union([z.literal("on"), z.literal("true"), z.literal("off"), z.literal(""), z.null(), z.undefined()])
    .transform((v) => v === "on" || v === "true")
    .refine((v) => v, "Please accept the data-privacy consent to register."),
  marketing_consent: z
    .union([z.literal("on"), z.literal("off"), z.literal(""), z.null(), z.undefined()])
    .transform((v) => v === "on"),
});

export type RegistrationInput = z.input<typeof RegistrationSchema>;
export type RegistrationData = z.output<typeof RegistrationSchema>;
