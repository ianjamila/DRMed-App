import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable();

// Manila is UTC+8, no DST. Operating hours Mon-Sat 8 AM – 5 PM.
function isWithinOperatingHours(d: Date): boolean {
  // Convert to Manila wall-clock by offsetting +8h from UTC.
  const ms = d.getTime() + 8 * 60 * 60 * 1000;
  const manila = new Date(ms);
  const dow = manila.getUTCDay(); // 0=Sun … 6=Sat
  if (dow === 0) return false;
  const hour = manila.getUTCHours();
  return hour >= 8 && hour < 17;
}

export const BookingSchema = z.object({
  first_name: z.string().trim().min(1, "First name is required.").max(80),
  last_name: z.string().trim().min(1, "Last name is required.").max(80),
  middle_name: optionalText(80),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Birthdate must be YYYY-MM-DD."),
  sex: z
    .union([z.literal(""), z.enum(["male", "female"])])
    .transform((v) => (v === "" ? null : v))
    .nullable(),
  phone: z
    .string()
    .trim()
    .min(7, "Phone is required for SMS confirmation.")
    .max(40),
  email: z
    .string()
    .trim()
    .email("Valid email required for confirmation.")
    .max(160),
  address: optionalText(200),
  service_id: z.string().uuid("Pick a service."),
  scheduled_at: z
    .string()
    .min(1, "Pick a date and time.")
    .transform((v, ctx) => {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Invalid date/time.",
        });
        return z.NEVER;
      }
      const now = Date.now();
      if (d.getTime() < now + 60 * 60 * 1000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Pick a slot at least 1 hour from now.",
        });
        return z.NEVER;
      }
      if (d.getTime() > now + 60 * 24 * 60 * 60 * 1000) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Bookings up to 60 days in advance.",
        });
        return z.NEVER;
      }
      if (!isWithinOperatingHours(d)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Pick a slot Mon–Sat between 8 AM and 5 PM.",
        });
        return z.NEVER;
      }
      return d.toISOString();
    }),
  notes: optionalText(2000),
});

export type BookingInput = z.infer<typeof BookingSchema>;
