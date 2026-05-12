import { z } from "zod";

const accountCodeSchema = z
  .string()
  .trim()
  .min(2, "Account code must be at least 2 characters.")
  .max(20, "Account code is too long.")
  .regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, dot, underscore, or dash.");

const accountTypeSchema = z.enum([
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
  "contra_revenue",
  "contra_expense",
  "memo",
]);

const accountNormalBalanceSchema = z.enum(["debit", "credit"]);

export const AccountCreateSchema = z.object({
  code: accountCodeSchema,
  name: z.string().trim().min(1, "Name is required.").max(120),
  type: accountTypeSchema,
  parent_id: z.string().uuid().nullable().optional(),
  normal_balance: accountNormalBalanceSchema,
  description: z.string().trim().max(500).nullable().optional(),
});

export const AccountUpdateSchema = AccountCreateSchema.omit({ code: true }).extend({
  is_active: z.coerce.boolean().optional(),
});

export const QuarterIdentifierSchema = z.object({
  fiscal_year: z.coerce.number().int().min(2020).max(2099),
  fiscal_quarter: z.coerce.number().int().min(1).max(4),
});

export const CloseQuarterSchema = QuarterIdentifierSchema.extend({
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const ReopenQuarterSchema = QuarterIdentifierSchema.extend({
  reason: z.string().trim().min(1, "Reason is required to reopen a closed quarter.").max(1000),
});

export type AccountCreateInput = z.infer<typeof AccountCreateSchema>;
export type AccountUpdateInput = z.infer<typeof AccountUpdateSchema>;
export type CloseQuarterInput = z.infer<typeof CloseQuarterSchema>;
export type ReopenQuarterInput = z.infer<typeof ReopenQuarterSchema>;
