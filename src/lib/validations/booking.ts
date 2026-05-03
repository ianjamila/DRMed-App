import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable();

// Manila is UTC+8, no DST. Operating hours Mon-Sat. Slots are 30-min
// boundaries from 08:00 to 16:30 inclusive (last appointment finishes 17:00).
export interface ManilaSlot {
  dayOfWeek: number; // 0=Sun … 6=Sat
  hour: number;
  minute: number;
  dateISO: string; // YYYY-MM-DD in Manila
}

export function manilaSlotFor(d: Date): ManilaSlot {
  const ms = d.getTime() + 8 * 60 * 60 * 1000;
  const manila = new Date(ms);
  return {
    dayOfWeek: manila.getUTCDay(),
    hour: manila.getUTCHours(),
    minute: manila.getUTCMinutes(),
    dateISO: `${manila.getUTCFullYear()}-${String(manila.getUTCMonth() + 1).padStart(2, "0")}-${String(manila.getUTCDate()).padStart(2, "0")}`,
  };
}

export function isValidSlot(slot: ManilaSlot): boolean {
  if (slot.dayOfWeek === 0) return false; // Sunday closed
  if (slot.minute !== 0 && slot.minute !== 30) return false;
  if (slot.hour < 8) return false;
  if (slot.hour > 16) return false;
  // 16:30 is the last slot; 16:00 is also fine.
  return true;
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
      const slot = manilaSlotFor(d);
      if (!isValidSlot(slot)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Pick a 30-minute slot Mon–Sat between 8:00 AM and 4:30 PM.",
        });
        return z.NEVER;
      }
      return d.toISOString();
    }),
  notes: optionalText(2000),
});

export type BookingInput = z.infer<typeof BookingSchema>;
