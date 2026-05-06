import { z } from "zod";
import { INQUIRY_CHANNELS } from "@/lib/inquiries/labels";

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const t = (v ?? "").toString().trim();
      return t.length === 0 ? null : t;
    })
    .pipe(z.string().max(max).nullable());

const optionalUuid = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const t = (v ?? "").toString().trim();
    return t.length === 0 ? null : t;
  })
  .pipe(z.string().uuid("Invalid staff id.").nullable());

// <input type="datetime-local"> emits "YYYY-MM-DDTHH:MM"; treat that as
// Asia/Manila wall-clock time. Append the offset so Postgres stores the
// correct UTC instant regardless of where the server is running.
const calledAt = z
  .string()
  .trim()
  .min(1, "Date and time are required.")
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, "Invalid date/time.")
  .transform((v) => {
    const withSeconds = v.length === 16 ? `${v}:00` : v;
    return `${withSeconds}+08:00`;
  });

const baseFields = {
  caller_name: z.string().trim().min(1, "Caller name is required.").max(120),
  contact: z.string().trim().min(1, "Contact is required.").max(120),
  channel: z.enum(INQUIRY_CHANNELS),
  service_interest: optionalText(500),
  called_at: calledAt,
  received_by_id: optionalUuid,
  notes: optionalText(2000),
};

// Reception form only ever sets pending / dropped. Confirmed transitions
// come from the "Book from this inquiry" action (Phase 10.4) which links
// the appointment/visit at the same time.
const InquiryFormSchema = z
  .object({
    ...baseFields,
    status: z.enum(["pending", "dropped"]),
    drop_reason: optionalText(1000),
  })
  .superRefine((val, ctx) => {
    if (val.status === "dropped" && !val.drop_reason) {
      ctx.addIssue({
        code: "custom",
        path: ["drop_reason"],
        message: "Drop reason is required.",
      });
    }
  });

export const InquiryCreateSchema = InquiryFormSchema;
export const InquiryUpdateSchema = InquiryFormSchema;

export type InquiryInput = z.infer<typeof InquiryFormSchema>;
