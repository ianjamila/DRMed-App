import { z } from "zod";
import { isOnOrBeforeTodayManila } from "@/lib/dates/manila";

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

// =============================================================================
// 12.A — HMO history import
// =============================================================================

export const cutoverISO = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "cutover must be YYYY-MM-DD");

export const uploadRunInput = z.object({
  // formData-driven; the action peels the File off separately.
  cutover_date: cutoverISO,
});

export const validateRunInput = z.object({
  run_id: z.string().uuid(),
});

export const mapProviderAliasInput = z.object({
  run_id: z.string().uuid(),
  alias: z.string().min(1).max(200),
  // EITHER an existing provider id OR the sentinel "create" string.
  provider_id: z.union([z.string().uuid(), z.literal("create")]),
});

export const mapServiceAliasInput = z.object({
  run_id: z.string().uuid(),
  alias: z.string().min(1).max(200),
  service_kind: z.enum(["lab_test", "doctor_consultation"]),
  service_id: z.union([z.string().uuid(), z.literal("create")]),
});

export const commitRunInput = z.object({
  run_id: z.string().uuid(),
  variance_override_reason: z.string().max(2000).optional(),
  pii_ack: z.literal(true),   // checkbox must be checked
});

export const discardRunInput = z.object({
  run_id: z.string().uuid(),
});

// ============================================================
// 12.C — Daily cash reconciliation schemas
// ============================================================

const CashAdjustmentKindEnum = z.enum([
  "petty_cash",
  "salary_advance",
  "courier",
  "other_payout",
  "float_topup",
  "float_pullout",
]);

export const RecordCashAdjustmentSchema = z
  .object({
    business_date: z
      .string()
      .refine(isOnOrBeforeTodayManila, "business_date must be a date on or before today"),
    shift_id: z.string().uuid(),
    kind: CashAdjustmentKindEnum,
    amount_php: z.coerce.number().positive().max(1_000_000),
    payee: z.string().trim().max(120).nullable().optional(),
    payee_staff_id: z.string().uuid().nullable().optional(),
    contra_account_id: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine(
    (v) => v.kind !== "salary_advance" || !!v.payee_staff_id,
    { message: "Salary advance requires a staff member", path: ["payee_staff_id"] },
  );
export type RecordCashAdjustmentInput = z.infer<typeof RecordCashAdjustmentSchema>;

export const VoidCashAdjustmentSchema = z.object({
  id: z.string().uuid(),
  void_reason: z.string().trim().min(1, "Reason is required.").max(500),
});
export type VoidCashAdjustmentInput = z.infer<typeof VoidCashAdjustmentSchema>;

export const CloseEodSchema = z
  .object({
    business_date: z
      .string()
      .refine(isOnOrBeforeTodayManila, "business_date must be a date on or before today"),
    shift_id: z.string().uuid(),
    counted_cash_php: z.coerce.number().min(0).max(10_000_000),
    variance_reason: z.string().trim().max(1000).nullable().optional(),
  });
export type CloseEodInput = z.infer<typeof CloseEodSchema>;

export const ReopenEodSchema = z.object({
  close_id: z.string().uuid(),
  reopen_reason: z.string().trim().min(1, "Reason is required.").max(1000),
});
export type ReopenEodInput = z.infer<typeof ReopenEodSchema>;

export const UpdateCashAdjustmentRoutingSchema = z.object({
  kind: CashAdjustmentKindEnum,
  account_id: z.string().uuid(),
  requires_user_choice: z.coerce.boolean(),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type UpdateCashAdjustmentRoutingInput = z.infer<typeof UpdateCashAdjustmentRoutingSchema>;

export const UpdateDefaultChangeFundSchema = z.object({
  amount_php: z.coerce.number().min(0).max(1_000_000),
});
export type UpdateDefaultChangeFundInput = z.infer<typeof UpdateDefaultChangeFundSchema>;

export const CashShiftCreateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(20)
    .regex(/^[a-z0-9_]+$/, "lowercase letters, digits, underscore only"),
  label: z.string().trim().min(1).max(60),
  sort_order: z.coerce.number().int().min(0).default(0),
});
export type CashShiftCreateInput = z.infer<typeof CashShiftCreateSchema>;

export const CashShiftUpdateSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1).max(60).optional(),
  is_active: z.coerce.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).optional(),
});
export type CashShiftUpdateInput = z.infer<typeof CashShiftUpdateSchema>;

// ============================================================
// 12.6 — Payroll schemas
// ============================================================

const PayrollScheduleKindEnum = z.enum([
  "fixed_5day_mon_fri",
  "fixed_6day_mon_sat",
  "shifting_5of6_mon_sat",
]);

const PaymentMethodEnum = z.enum(["cash", "bank"]);

const LeaveKindEnum = z.enum(["VL", "SL"]);

export const CreateEmployeeSchema = z.object({
  staff_profile_id: z.string().uuid(),
  employee_number: z.string().trim().min(1).max(40).optional(),
  hire_date: z.string().refine(isOnOrBeforeTodayManila, "hire_date must be a date on or before today"),
  regularization_date: z.string().nullable().optional(),
  civil_status: z.enum(["single", "married", "widowed", "separated", "divorced"]).optional(),
  basic_daily_rate_php: z.coerce.number().positive().max(100_000),
  monthly_salary_credit_php: z.coerce.number().positive().max(1_000_000),
  schedule_kind: PayrollScheduleKindEnum,
  rest_days: z.array(z.coerce.number().int().min(0).max(6)).nullable().optional(),
  dtr_external_id: z.string().trim().max(80).nullable().optional(),
  payment_method: PaymentMethodEnum.default("cash"),
  bank_name: z.string().trim().max(80).nullable().optional(),
  bank_account_number: z.string().trim().max(40).nullable().optional(),
  bank_account_holder_name: z.string().trim().max(120).nullable().optional(),
  sss_number: z.string().trim().max(40).nullable().optional(),
  philhealth_number: z.string().trim().max(40).nullable().optional(),
  pagibig_number: z.string().trim().max(40).nullable().optional(),
  tin: z.string().trim().max(40).nullable().optional(),
  tax_status: z.enum(["standard", "minimum_wage_earner"]).default("standard"),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type CreateEmployeeInput = z.infer<typeof CreateEmployeeSchema>;

export const UpdateEmployeeSchema = CreateEmployeeSchema.partial().extend({
  id: z.string().uuid(),
});
export type UpdateEmployeeInput = z.infer<typeof UpdateEmployeeSchema>;

export const AddAllowanceSchema = z.object({
  employee_id: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  daily_amount_php: z.coerce.number().min(0).max(10_000),
  is_taxable: z.coerce.boolean().default(true),
  effective_from: z.string(),
  effective_to: z.string().nullable().optional(),
});
export type AddAllowanceInput = z.infer<typeof AddAllowanceSchema>;

export const RequestLoanSchema = z.object({
  employee_id: z.string().uuid(),
  principal_php: z.coerce.number().positive().max(1_000_000),
  amortization_per_period_php: z.coerce.number().positive().max(1_000_000),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type RequestLoanInput = z.infer<typeof RequestLoanSchema>;

export const ApproveLoanSchema = z.object({
  loan_id: z.string().uuid(),
  approval_notes: z.string().trim().max(1000).nullable().optional(),
});
export type ApproveLoanInput = z.infer<typeof ApproveLoanSchema>;

export const MarkLoanDisbursedSchema = z.object({
  loan_id: z.string().uuid(),
  start_period_id: z.string().uuid(),
});
export type MarkLoanDisbursedInput = z.infer<typeof MarkLoanDisbursedSchema>;

export const CreatePeriodSchema = z.object({
  period_start: z.string(),
  period_end: z.string(),
  pay_date: z.string(),
});
export type CreatePeriodInput = z.infer<typeof CreatePeriodSchema>;

export const CreateRunSchema = z.object({
  period_id: z.string().uuid(),
});
export type CreateRunInput = z.infer<typeof CreateRunSchema>;

export const VoidRunSchema = z.object({
  run_id: z.string().uuid(),
  void_reason: z.string().trim().min(1).max(1000),
});
export type VoidRunInput = z.infer<typeof VoidRunSchema>;

export const MarkEmployeePaidSchema = z.object({
  employee_run_id: z.string().uuid(),
  contra_account_id: z.string().uuid().optional(),
});
export type MarkEmployeePaidInput = z.infer<typeof MarkEmployeePaidSchema>;

export const AddEarningLineSchema = z.object({
  employee_run_id: z.string().uuid(),
  kind: z.enum(["incentive", "one_time_bonus", "manual_adjustment", "ot_supplement"]),
  label: z.string().trim().min(1).max(120),
  quantity: z.coerce.number().nullable().optional(),
  rate_php: z.coerce.number().nullable().optional(),
  amount_php: z.coerce.number().min(0).max(10_000_000),
});
export type AddEarningLineInput = z.infer<typeof AddEarningLineSchema>;

export const AddDeductionLineSchema = z.object({
  employee_run_id: z.string().uuid(),
  kind: z.enum(["loan_amortization", "manual_adjustment", "other"]),
  label: z.string().trim().min(1).max(120),
  amount_php: z.coerce.number().min(0).max(10_000_000),
  loan_id: z.string().uuid().nullable().optional(),
});
export type AddDeductionLineInput = z.infer<typeof AddDeductionLineSchema>;

export const CreateOtSlipSchema = z.object({
  employee_id: z.string().uuid(),
  work_date: z.string(),
  hours_requested: z.coerce.number().positive().max(24),
  reason: z.string().trim().max(500).nullable().optional(),
});
export type CreateOtSlipInput = z.infer<typeof CreateOtSlipSchema>;

export const AddHolidaySchema = z.object({
  date: z.string(),
  kind: z.enum(["regular", "special_non_working", "special_working"]),
  name: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type AddHolidayInput = z.infer<typeof AddHolidaySchema>;

export const CreateContributionBracketSchema = z.object({
  kind: z.enum(["sss", "philhealth", "pagibig"]),
  effective_from: z.string(),
  effective_to: z.string().nullable().optional(),
  monthly_salary_credit_min_php: z.coerce.number().min(0),
  monthly_salary_credit_max_php: z.coerce.number().positive(),
  employee_share_php: z.coerce.number().min(0),
  employer_share_php: z.coerce.number().min(0),
  notes: z.string().trim().max(500).nullable().optional(),
});
export type CreateContributionBracketInput = z.infer<typeof CreateContributionBracketSchema>;

export const CreateWtBracketSchema = z.object({
  effective_from: z.string(),
  effective_to: z.string().nullable().optional(),
  taxable_min_php: z.coerce.number().min(0),
  taxable_max_php: z.coerce.number().positive().nullable().optional(),
  base_tax_php: z.coerce.number().min(0),
  marginal_rate: z.coerce.number().min(0).max(1),
});
export type CreateWtBracketInput = z.infer<typeof CreateWtBracketSchema>;

export const UpdatePayrollSettingSchema = z.object({
  key: z.string().trim().min(1).max(80),
  value_php: z.coerce.number(),
});
export type UpdatePayrollSettingInput = z.infer<typeof UpdatePayrollSettingSchema>;

export const AddLeaveGrantSchema = z.object({
  employee_id: z.string().uuid(),
  kind: LeaveKindEnum,
  days: z.coerce.number().positive().max(365),
  effective_date: z.string(),
  expiry_date: z.string().nullable().optional(),
  reason: z.string().trim().min(1).max(500),
});
export type AddLeaveGrantInput = z.infer<typeof AddLeaveGrantSchema>;

export const RecordLeaveUsageSchema = z.object({
  employee_id: z.string().uuid(),
  kind: LeaveKindEnum,
  days: z.coerce.number().positive().max(365),
  effective_date: z.string(),
  period_id: z.string().uuid().nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
});
export type RecordLeaveUsageInput = z.infer<typeof RecordLeaveUsageSchema>;

export const ApplyLeaveEntitlementsSchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
});
export type ApplyLeaveEntitlementsInput = z.infer<typeof ApplyLeaveEntitlementsSchema>;

export const UploadDtrSchema = z.object({
  period_id: z.string().uuid(),
  filename: z.string().trim().min(1).max(200),
  csv_text: z.string().min(1).max(5_000_000),
});
export type UploadDtrInput = z.infer<typeof UploadDtrSchema>;

export const RegeneratePayslipSchema = z.object({
  employee_run_id: z.string().uuid(),
});
export type RegeneratePayslipInput = z.infer<typeof RegeneratePayslipSchema>;

export const ReopenVoidedRunSchema = z.object({
  run_id: z.string().uuid(),
});
export type ReopenVoidedRunInput = z.infer<typeof ReopenVoidedRunSchema>;
