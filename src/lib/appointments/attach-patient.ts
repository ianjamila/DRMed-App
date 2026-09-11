import { z } from "zod";

// Pure schema — no DB, no `server-only` import — for the H2 "attach patient
// to an arrived/confirmed walk-in" action. Deliberately narrower than
// StaffBookingSchema's patient union in src/lib/validations/staff-booking.ts:
// there is no "walk_in" mode here, since attaching a patient to a walk-in
// appointment is the whole point (the row already has walk_in_name /
// walk_in_phone — this schema resolves it to a real patient_id instead).

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .or(z.literal(""))
    .nullish()
    .transform((v) => (v == null || v === "" ? null : v));

export const AttachPatientSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("existing"), patient_id: z.string().uuid("Pick a patient.") }),
  z.object({
    mode: z.literal("new"),
    first_name: z.string().trim().min(1, "First name is required.").max(80),
    last_name: z.string().trim().min(1, "Last name is required.").max(80),
    middle_name: optionalText(80),
    birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Birthdate must be YYYY-MM-DD."),
    sex: z
      .union([z.literal(""), z.enum(["male", "female"])])
      .transform((v) => (v === "" ? null : v))
      .nullable(),
    // Email required: it's the dedup key for resolvePatient + the confirmation channel.
    email: z.string().trim().email("Valid email required.").max(160),
    phone: optionalText(40),
    address: optionalText(200),
  }),
]);

// z.input (raw) — the client builds this shape; the action re-parses to z.output.
export type AttachPatientInput = z.input<typeof AttachPatientSchema>;
