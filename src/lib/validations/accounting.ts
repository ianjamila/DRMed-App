import { z } from "zod";

const MANILA_TZ = "Asia/Manila";

function todayManila(): string {
  // Returns YYYY-MM-DD as it is right now in Manila.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MANILA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isOnOrBeforeTodayManila(dateStr: string): boolean {
  // dateStr is expected as YYYY-MM-DD; lexical compare works for ISO-like dates.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  return dateStr <= todayManila();
}

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

export const VoidPaymentSchema = z.object({
  reason: z.string().trim().min(1, "Reason is required to void a payment.").max(500),
});

export const UpdatePaymentMethodMapSchema = z.object({
  account_id: z.string().uuid(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export type AccountCreateInput = z.infer<typeof AccountCreateSchema>;
export type AccountUpdateInput = z.infer<typeof AccountUpdateSchema>;
export type CloseQuarterInput = z.infer<typeof CloseQuarterSchema>;
export type ReopenQuarterInput = z.infer<typeof ReopenQuarterSchema>;
export type VoidPaymentInput = z.infer<typeof VoidPaymentSchema>;
export type UpdatePaymentMethodMapInput = z.infer<typeof UpdatePaymentMethodMapSchema>;

// ============================================================
// 12.3 — HMO AR subledger schemas
// ============================================================

const HmoResponseEnum = z.enum(["pending", "paid", "rejected", "no_response"]);
const HmoBatchMediumEnum = z.enum(["mail", "courier", "email", "portal", "fax", "in_person"]);
const HmoResolutionDestEnum = z.enum(["patient_bill", "write_off"]);
const HmoBulkScopeEnum = z.enum(["pending_only", "all"]);

export const CreateClaimBatchSchema = z.object({
  provider_id: z.string().uuid(),
  test_request_ids: z.array(z.string().uuid()).min(1, "Add at least one test request"),
});
export type CreateClaimBatchInput = z.infer<typeof CreateClaimBatchSchema>;

export const AddItemsToBatchSchema = z.object({
  batch_id: z.string().uuid(),
  test_request_ids: z.array(z.string().uuid()).min(1),
});
export type AddItemsToBatchInput = z.infer<typeof AddItemsToBatchSchema>;

export const RemoveItemFromBatchSchema = z.object({
  item_id: z.string().uuid(),
});
export type RemoveItemFromBatchInput = z.infer<typeof RemoveItemFromBatchSchema>;

export const SubmitBatchSchema = z.object({
  batch_id: z.string().uuid(),
  submitted_at: z
    .string()
    .refine(isOnOrBeforeTodayManila, "submitted_at must be a date on or before today"),
  medium: HmoBatchMediumEnum,
  reference_no: z.string().min(1).max(64).optional().nullable(),
});
export type SubmitBatchInput = z.infer<typeof SubmitBatchSchema>;

export const AcknowledgeBatchSchema = z.object({
  batch_id: z.string().uuid(),
  hmo_ack_ref: z.string().min(1).max(128).optional().nullable(),
});
export type AcknowledgeBatchInput = z.infer<typeof AcknowledgeBatchSchema>;

export const VoidBatchSchema = z.object({
  batch_id: z.string().uuid(),
  void_reason: z.string().min(5, "Reason must be at least 5 characters"),
});
export type VoidBatchInput = z.infer<typeof VoidBatchSchema>;

export const UpdateItemHmoResponseSchema = z.object({
  item_id: z.string().uuid(),
  hmo_response: HmoResponseEnum,
  hmo_response_date: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid date"),
  hmo_response_notes: z.string().max(2000).optional().nullable(),
});
export type UpdateItemHmoResponseInput = z.infer<typeof UpdateItemHmoResponseSchema>;

export const BulkSetHmoResponseSchema = z.object({
  batch_id: z.string().uuid(),
  response: HmoResponseEnum,
  response_date: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "invalid date"),
  scope: HmoBulkScopeEnum,
  notes: z.string().max(2000).optional().nullable(),
});
export type BulkSetHmoResponseInput = z.infer<typeof BulkSetHmoResponseSchema>;

export const CreateResolutionSchema = z.object({
  item_id: z.string().uuid(),
  destination: HmoResolutionDestEnum,
  amount_php: z.number().positive("Amount must be > 0"),
  notes: z.string().max(2000).optional().nullable(),
});
export type CreateResolutionInput = z.infer<typeof CreateResolutionSchema>;

export const VoidResolutionSchema = z.object({
  resolution_id: z.string().uuid(),
  void_reason: z.string().min(5),
});
export type VoidResolutionInput = z.infer<typeof VoidResolutionSchema>;

export const RecordHmoSettlementSchema = z
  .object({
    batch_id: z.string().uuid(),
    total_amount_php: z.number().positive(),
    payment_date: z
      .string()
      .refine(isOnOrBeforeTodayManila, "payment_date must be on or before today"),
    bank_reference: z.string().max(128).optional().nullable(),
    items: z
      .array(
        z.object({
          item_id: z.string().uuid(),
          amount_php: z.number().positive(),
        }),
      )
      .min(1),
  })
  .refine(
    (v) => {
      const sum = v.items.reduce((acc, it) => acc + it.amount_php, 0);
      return Math.abs(sum - v.total_amount_php) < 0.005;
    },
    { message: "Sum of per-item amounts must equal total_amount_php" },
  );
export type RecordHmoSettlementInput = z.infer<typeof RecordHmoSettlementSchema>;

export const AllocateExistingPaymentSchema = z.object({
  payment_id: z.string().uuid(),
  allocations: z
    .array(
      z.object({
        item_id: z.string().uuid(),
        amount_php: z.number().positive(),
      }),
    )
    .min(1),
});
export type AllocateExistingPaymentInput = z.infer<typeof AllocateExistingPaymentSchema>;
// NOTE: sum-equals-payment refinement is enforced inside the Server Action,
// because the payment.amount_php is fetched server-side.
