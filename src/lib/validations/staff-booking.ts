import { z } from "zod";
import { manilaSlotFor, isValidSlot } from "@/lib/validations/booking";
import { STAFF_SELECTABLE_SOURCES } from "@/lib/appointments/source";

// Tolerates "", null, undefined, or a real string (the staff action may omit
// optional fields entirely, unlike the FormData public flow which sends "").
const optionalText = (max: number) =>
  z.string().trim().max(max).or(z.literal("")).nullish().transform((v) => (v == null || v === "" ? null : v));

// The staff "+ New appointment" slide-over's Notes field is optional on every
// booking (not just message bookings) — this is the single source for both
// the schema's max() below and the textarea's `maxLength` so they can't drift.
export const STAFF_BOOKING_NOTES_MAX = 2000;

// Staff timing is RELAXED vs the public form: the "≥1 hour ahead" lead-time rule
// is dropped (same-day / short-notice / re-entered bookings are allowed). It must
// still be a real 30-min Mon–Sat 08:00–16:30 slot, and no more than 60 days out.
const relaxedScheduledAt = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v, ctx) => {
    const t = (v ?? "").toString().trim();
    if (t.length === 0) return null;
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date/time." });
      return z.NEVER;
    }
    if (d.getTime() > Date.now() + 60 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Bookings up to 60 days in advance." });
      return z.NEVER;
    }
    if (!isValidSlot(manilaSlotFor(d))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pick a 30-minute slot Mon–Sat between 8:00 AM and 4:30 PM." });
      return z.NEVER;
    }
    return d.toISOString();
  });

// A plain string.refine (not z.enum) so the type predicate narrows to
// AppointmentSource on parse while the client's raw select value (typed
// `string`, may be "" before a choice is made) assigns straight into the
// input shape with no cast — the server is what actually enforces this.
function isStaffSelectableSource(v: unknown): v is (typeof STAFF_SELECTABLE_SOURCES)[number] {
  return typeof v === "string" && (STAFF_SELECTABLE_SOURCES as readonly string[]).includes(v);
}
const staffSourceSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => v ?? "")
  .refine(isStaffSelectableSource, "Choose how they reached us.");

// "" (never chosen) or a genuinely malformed value both collapse to
// undefined — createStaffAppointmentAction only links a message when this is
// a real uuid.
const optionalMessageId = z
  .union([z.string().uuid("Invalid message id."), z.literal(""), z.null(), z.undefined()])
  .transform((v) => (v == null || v === "" ? undefined : v));

const StaffPatientUnion = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("existing"), patient_id: z.string().uuid("Pick a patient.") }),
  z.object({
    mode: z.literal("new"),
    first_name: z.string().trim().min(1, "First name is required.").max(80),
    last_name: z.string().trim().min(1, "Last name is required.").max(80),
    middle_name: optionalText(80),
    birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Birthdate must be YYYY-MM-DD."),
    sex: z.union([z.literal(""), z.enum(["male", "female"])]).transform((v) => (v === "" ? null : v)).nullable(),
    // Email required: it's the dedup key for resolvePatient + the confirmation channel.
    email: z.string().trim().email("Valid email required.").max(160),
    phone: optionalText(40),
    address: optionalText(200),
  }),
  z.object({
    mode: z.literal("walk_in"),
    walk_in_name: z.string().trim().min(1, "Walk-in name is required.").max(120),
    walk_in_phone: z.string().trim().min(7, "Walk-in phone is required.").max(40),
  }),
]);

export const StaffBookingSchema = z
  .object({
    patient: StaffPatientUnion,
    branch: z.enum(["diagnostic_package", "lab_request", "doctor_appointment", "home_service"]),
    service_id: z.string().uuid().optional(),
    service_ids: z.array(z.string().uuid()).optional(),
    physician_id: z.string().uuid().optional(),
    scheduled_at: relaxedScheduledAt,
    notes: optionalText(STAFF_BOOKING_NOTES_MAX),
    send_confirmation: z.boolean().default(true),
    override: z.boolean().default(false),
    // How the patient reached us (0154) — required so every staff-made
    // booking is countable in the Booking Sources report.
    source: staffSourceSchema,
    // Set when this booking was made from the Website Messages inbox's
    // "Book appointment" button — createStaffAppointmentAction links the
    // message to the resulting booking.
    contact_message_id: optionalMessageId,
  })
  .superRefine((val, ctx) => {
    if (val.branch === "doctor_appointment") {
      if (!val.service_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["service_id"], message: "Pick a consultation." });
      if (!val.physician_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["physician_id"], message: "Pick a physician." });
    } else if (!val.service_ids || val.service_ids.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["service_ids"], message: "Pick at least one service." });
    }
  });

// z.input (raw) — the client builds this shape; the action re-parses to z.output.
export type StaffBookingInput = z.input<typeof StaffBookingSchema>;
