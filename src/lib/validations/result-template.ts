import { z } from "zod";

export const ResultLayoutEnum = z.enum([
  "simple",
  "dual_unit",
  "multi_section",
  "imaging_report",
]);

export const ParamInputTypeEnum = z.enum(["numeric", "free_text", "select"]);

const optionalText = (max: number) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const t = (v ?? "").toString().trim();
      return t.length === 0 ? null : t;
    })
    .pipe(z.string().max(max).nullable());

const optionalNumber = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  })
  .pipe(z.number().nullable());

const optionalGender = z
  .union([z.literal("F"), z.literal("M"), z.literal(""), z.null(), z.undefined()])
  .transform((v) => (v === "F" || v === "M" ? v : null));

// Parameter row sent from the client. `id` is null for newly-added rows; the
// server inserts those and reuses existing IDs for edits.
export const TemplateParamSchema = z.object({
  id: z.string().uuid().nullable(),
  parameter_name: z.string().trim().min(1, "Parameter name is required.").max(120),
  input_type: ParamInputTypeEnum,
  section: optionalText(80),
  is_section_header: z.boolean(),
  unit_si: optionalText(40),
  unit_conv: optionalText(40),
  ref_low_si: optionalNumber,
  ref_high_si: optionalNumber,
  ref_low_conv: optionalNumber,
  ref_high_conv: optionalNumber,
  gender: optionalGender,
  si_to_conv_factor: optionalNumber,
  // Comma-separated input from the form, persisted as text[]. Empty becomes null.
  allowed_values: z
    .union([z.string(), z.array(z.string()), z.null(), z.undefined()])
    .transform((v) => {
      if (Array.isArray(v)) return v.filter((s) => s.trim().length > 0);
      if (typeof v === "string") {
        const arr = v
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        return arr;
      }
      return [];
    })
    .transform((arr) => (arr.length > 0 ? arr : null)),
  abnormal_values: z
    .union([z.string(), z.array(z.string()), z.null(), z.undefined()])
    .transform((v) => {
      if (Array.isArray(v)) return v.filter((s) => s.trim().length > 0);
      if (typeof v === "string") {
        const arr = v
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        return arr;
      }
      return [];
    })
    .transform((arr) => (arr.length > 0 ? arr : null)),
  placeholder: optionalText(120),
});

export const TemplateEditorPayloadSchema = z.object({
  service_id: z.string().uuid(),
  layout: ResultLayoutEnum,
  header_notes: optionalText(500),
  footer_notes: optionalText(500),
  is_active: z.boolean(),
  // Final ordering — server uses array index as sort_order, ignores any
  // sort_order the client may send to avoid drift.
  params: z.array(TemplateParamSchema),
});

export type TemplateEditorPayload = z.infer<typeof TemplateEditorPayloadSchema>;
export type TemplateParamPayload = z.infer<typeof TemplateParamSchema>;
