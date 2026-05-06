import { z } from "zod";

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const t = (v ?? "").toString().trim();
      return t.length === 0 ? null : t;
    })
    .pipe(z.string().max(max).nullable());

const slug = z
  .string()
  .trim()
  .min(1, "Slug is required.")
  .max(80)
  .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and dashes.");

const PhysicianFields = {
  slug,
  full_name: z.string().trim().min(1, "Full name is required.").max(160),
  specialty: z.string().trim().min(1, "Specialty is required.").max(160),
  group_label: optionalText(160),
  bio: optionalText(4000),
  is_active: z
    .union([z.literal("on"), z.literal("true"), z.literal("false"), z.null(), z.undefined()])
    .transform((v) => v === "on" || v === "true"),
  display_order: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((v) => {
      if (v == null || v === "") return 0;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : 0;
    })
    .pipe(z.number().int().min(0).max(9999)),
};

export const PhysicianCreateSchema = z.object(PhysicianFields);
export const PhysicianUpdateSchema = z.object(PhysicianFields);

export type PhysicianInput = z.infer<typeof PhysicianCreateSchema>;

const timeStr = z
  .string()
  .trim()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/, "Use HH:MM format.")
  .transform((v) => (v.length === 5 ? `${v}:00` : v));

const optionalTime = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const t = (v ?? "").toString().trim();
    return t.length === 0 ? null : t;
  })
  .pipe(
    z
      .string()
      .regex(/^\d{2}:\d{2}(:\d{2})?$/, "Use HH:MM format.")
      .transform((v) => (v.length === 5 ? `${v}:00` : v))
      .nullable(),
  );

const optionalDate = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const t = (v ?? "").toString().trim();
    return t.length === 0 ? null : t;
  })
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").nullable());

export const ScheduleBlockSchema = z
  .object({
    day_of_week: z
      .union([z.string(), z.number()])
      .transform((v) => Number(v))
      .pipe(z.number().int().min(0).max(6)),
    start_time: timeStr,
    end_time: timeStr,
    valid_from: optionalDate,
    valid_until: optionalDate,
    notes: optionalText(500),
  })
  .superRefine((val, ctx) => {
    if (val.end_time <= val.start_time) {
      ctx.addIssue({
        code: "custom",
        path: ["end_time"],
        message: "End must be after start.",
      });
    }
  });

export const OverrideSchema = z
  .object({
    override_on: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date."),
    start_time: optionalTime,
    end_time: optionalTime,
    reason: optionalText(500),
  })
  .superRefine((val, ctx) => {
    const bothNull = val.start_time === null && val.end_time === null;
    const bothSet = val.start_time !== null && val.end_time !== null;
    if (!bothNull && !bothSet) {
      ctx.addIssue({
        code: "custom",
        path: ["end_time"],
        message: "Set both times for a partial-day window, or leave both empty for a full-day off.",
      });
    }
    if (
      bothSet &&
      val.end_time !== null &&
      val.start_time !== null &&
      val.end_time <= val.start_time
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["end_time"],
        message: "End must be after start.",
      });
    }
  });
