import { z } from "zod";

const optionalText = z
  .string()
  .trim()
  .max(160)
  .or(z.literal(""))
  .transform((v) => (v === "" ? null : v))
  .nullable();

export const PatientCreateSchema = z.object({
  first_name: z.string().trim().min(1, "First name is required.").max(80),
  last_name: z.string().trim().min(1, "Last name is required.").max(80),
  middle_name: optionalText,
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Birthdate must be YYYY-MM-DD."),
  sex: z.enum(["male", "female"]).nullable().or(z.literal("").transform(() => null)),
  phone: optionalText,
  email: optionalText,
  address: optionalText,
});

export const PatientUpdateSchema = PatientCreateSchema.partial();

export type PatientCreateInput = z.infer<typeof PatientCreateSchema>;
