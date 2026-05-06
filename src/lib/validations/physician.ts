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
