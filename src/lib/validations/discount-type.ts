import { z } from "zod";

// Admin-managed discount catalog (PR G, item 5). `kind` here is deliberately
// narrower than the DB CHECK: `custom` is a built-in row admins can rename or
// deactivate but never create — the counter types the amount per line.
const money2dp = (v: unknown) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
};

const DiscountTypeFields = {
  label: z.string().trim().min(1, "Label is required.").max(80),
  kind: z.enum(["percent", "fixed"], {
    message: "Pick percent or fixed peso.",
  }),
  percent: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform(money2dp)
    .pipe(
      z
        .number()
        .gt(0, "Percent must be more than 0.")
        .max(100, "Percent cannot exceed 100.")
        .nullable(),
    ),
  amount_php: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform(money2dp)
    .pipe(z.number().gt(0, "Amount must be more than ₱0.").nullable()),
  active: z
    .union([z.literal("on"), z.literal("true"), z.literal("false"), z.null(), z.undefined()])
    .transform((v) => v === "on" || v === "true"),
  sort_order: z
    .union([z.string(), z.number(), z.null(), z.undefined()])
    .transform((v) => {
      if (v == null || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
      return n;
    })
    .pipe(z.number().int().min(0).max(9999).nullable()),
};

function requireRateForKind<
  T extends { kind: "percent" | "fixed"; percent: number | null; amount_php: number | null },
>(data: T, ctx: z.RefinementCtx) {
  if (data.kind === "percent" && data.percent == null) {
    ctx.addIssue({
      code: "custom",
      path: ["percent"],
      message: "Enter the percent for a percent discount.",
    });
  }
  if (data.kind === "fixed" && data.amount_php == null) {
    ctx.addIssue({
      code: "custom",
      path: ["amount_php"],
      message: "Enter the peso amount for a fixed discount.",
    });
  }
}

export const DiscountTypeCreateSchema = z
  .object(DiscountTypeFields)
  .superRefine(requireRateForKind);

export const DiscountTypeUpdateSchema = z
  .object(DiscountTypeFields)
  .superRefine(requireRateForKind);

/**
 * Limited update shape for built-in rows (statutory Senior/PWD + the
 * counter-typed `custom` row): label, active, sort order. Rate and kind are
 * locked — the statutory guard trigger backs this server-side.
 */
export const DiscountTypeBuiltinUpdateSchema = z.object({
  label: DiscountTypeFields.label,
  active: DiscountTypeFields.active,
  sort_order: DiscountTypeFields.sort_order,
});

export type DiscountTypeInput = z.infer<typeof DiscountTypeCreateSchema>;

/**
 * Stable machine key derived from the label at create time. Codes are
 * immutable afterwards — history rows (test_requests.discount_kind) and the
 * accounting Sheets export reference them.
 */
export function slugifyDiscountCode(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/g, "");
  return slug || "discount";
}
