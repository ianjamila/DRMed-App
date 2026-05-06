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
  return true;
}

export const BOOKING_BRANCHES = [
  "diagnostic_package",
  "lab_request",
  "doctor_appointment",
  "home_service",
] as const;
export type BookingBranch = (typeof BOOKING_BRANCHES)[number];

const PatientFields = {
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
  notes: optionalText(2000),
  marketing_consent: z
    .union([z.literal("on"), z.literal("off"), z.literal(""), z.null(), z.undefined()])
    .transform((v) => v === "on"),
  service_agreement: z
    .union([z.literal("on"), z.literal("off"), z.literal(""), z.null(), z.undefined()])
    .transform((v) => v === "on")
    .refine((v) => v, "Please accept the service agreement to continue."),
};

const serviceIds = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : [v]))
  .pipe(
    z
      .array(z.string().uuid("Invalid service id."))
      .min(1, "Pick at least one service."),
  );

// scheduled_at — when present, must be ≥1 h from now, ≤60 d, and a valid
// 30-min Mon–Sat slot. Empty allowed (the branch decides whether to
// require it via .superRefine on the discriminated union).
const optionalScheduledAt = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    const t = (v ?? "").toString().trim();
    if (t.length === 0) return null;
    const d = new Date(t);
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
  });

export const DiagnosticPackageBookingSchema = z.object({
  ...PatientFields,
  branch: z.literal("diagnostic_package"),
  service_ids: serviceIds,
});

export const LabRequestBookingSchema = z
  .object({
    ...PatientFields,
    branch: z.literal("lab_request"),
    service_ids: serviceIds,
    scheduled_at: optionalScheduledAt,
  });

export const DoctorAppointmentBookingSchema = z.object({
  ...PatientFields,
  branch: z.literal("doctor_appointment"),
  service_id: z.string().uuid("Pick a consultation."),
  physician_id: z.string().uuid("Pick a physician."),
  scheduled_at: optionalScheduledAt,
});

export const HomeServiceBookingSchema = z.object({
  ...PatientFields,
  branch: z.literal("home_service"),
  service_ids: serviceIds,
});

export const BookingSchema = z.discriminatedUnion("branch", [
  DiagnosticPackageBookingSchema,
  LabRequestBookingSchema,
  DoctorAppointmentBookingSchema,
  HomeServiceBookingSchema,
]);

export type BookingInput = z.infer<typeof BookingSchema>;
