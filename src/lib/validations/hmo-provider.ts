import { z } from "zod";

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const t = (v ?? "").toString().trim();
      return t.length === 0 ? null : t;
    })
    .pipe(z.string().max(max).nullable());

const optionalInt = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    return n;
  })
  .pipe(z.number().int().min(0).max(365).nullable());

const optionalDate = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => {
    const t = (v ?? "").toString().trim();
    return t.length === 0 ? null : t;
  })
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").nullable());

// Shared field shape for create + update.
const HmoProviderFields = {
  name: z.string().trim().min(1, "Name is required.").max(120),
  is_active: z
    .union([z.literal("on"), z.literal("true"), z.literal("false"), z.null(), z.undefined()])
    .transform((v) => v === "on" || v === "true"),
  due_days_for_invoice: optionalInt,
  contract_start_date: optionalDate,
  contract_end_date: optionalDate,
  contact_person_name: optionalText(120),
  contact_person_address: optionalText(240),
  contact_person_phone: optionalText(40),
  contact_person_email: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const t = (v ?? "").toString().trim();
      return t.length === 0 ? null : t;
    })
    .pipe(z.string().email("Invalid email.").max(160).nullable()),
  notes: optionalText(2000),
};

export const HmoProviderCreateSchema = z.object(HmoProviderFields);
export const HmoProviderUpdateSchema = z.object(HmoProviderFields);

export type HmoProviderInput = z.infer<typeof HmoProviderCreateSchema>;
