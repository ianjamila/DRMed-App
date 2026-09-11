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

// M11: hmo_providers.unbilled_threshold_days (0034) is NOT NULL default 14 —
// unlike due_days_for_invoice, a blank/invalid submission must not resolve to
// null, so this falls back to the DB default of 14 rather than rejecting.
const unbilledThresholdDays = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null || v === "") return 14;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return 14;
    return n;
  })
  .pipe(
    z
      .number()
      .int()
      .min(1, "Must be at least 1 day.")
      .max(365, "Must be 365 days or fewer."),
  );

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
  unbilled_threshold_days: unbilledThresholdDays,
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
