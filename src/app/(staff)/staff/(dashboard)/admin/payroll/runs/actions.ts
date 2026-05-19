"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { computePayrollRun } from "@/lib/payroll/compute";
import {
  CreatePeriodSchema,
  CreateRunSchema,
  VoidRunSchema,
  MarkEmployeePaidSchema,
  AddEarningLineSchema,
  AddDeductionLineSchema,
  ReopenVoidedRunSchema,
  type CreatePeriodInput,
  type CreateRunInput,
  type VoidRunInput,
  type MarkEmployeePaidInput,
  type AddEarningLineInput,
  type AddDeductionLineInput,
  type ReopenVoidedRunInput,
} from "@/lib/validations/accounting";

// All actions in this file return the same discriminated-union shape so the UI
// can branch on `ok` cleanly. The `data` payload differs by action.
export type RunActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const RUNS_PATH = "/staff/admin/payroll/runs";
const CASH_DRAWER_PATH = "/staff/payments/cash-drawer";

async function ipAndAgent() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    ua: h.get("user-agent"),
  };
}

function firstIssue(err: z.ZodError, fallback = "Please check the form."): string {
  return err.issues[0]?.message ?? fallback;
}

function runDetailPath(run_id: string) {
  return `${RUNS_PATH}/${run_id}`;
}

// =============================================================================
// Periods
// =============================================================================

export async function createPeriodAction(
  raw: CreatePeriodInput,
): Promise<RunActionResult<{ period_id: string }>> {
  const session = await requireAdminStaff();
  const parsed = CreatePeriodSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("payroll_periods")
    .insert({
      period_start: parsed.data.period_start,
      period_end: parsed.data.period_end,
      pay_date: parsed.data.pay_date,
      // status defaults to 'open' at the DB level.
    })
    .select("id")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not create period.",
    };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_period.created",
    resource_type: "payroll_period",
    resource_id: created.id,
    metadata: {
      period_start: parsed.data.period_start,
      period_end: parsed.data.period_end,
      pay_date: parsed.data.pay_date,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  return { ok: true, data: { period_id: created.id } };
}

export async function closePeriodAction(
  period_id: string,
): Promise<RunActionResult> {
  const session = await requireAdminStaff();
  if (!period_id || typeof period_id !== "string") {
    return { ok: false, error: "Period id is required." };
  }

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("payroll_periods")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: session.user_id,
    })
    .eq("id", period_id)
    .eq("status", "open")
    .select("id")
    .maybeSingle();
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated) {
    return { ok: false, error: "Period not found, or already closed." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_period.closed",
    resource_type: "payroll_period",
    resource_id: period_id,
    metadata: null,
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  return { ok: true, data: undefined };
}

// =============================================================================
// Runs — lifecycle
// =============================================================================

export async function createRunAction(
  raw: CreateRunInput,
): Promise<RunActionResult<{ run_id: string }>> {
  const session = await requireAdminStaff();
  const parsed = CreateRunSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();

  // 1. Insert the run row (status defaults to 'draft' per migration 0044).
  const { data: createdRun, error: runErr } = await admin
    .from("payroll_runs")
    .insert({ period_id: parsed.data.period_id })
    .select("id")
    .single();
  if (runErr || !createdRun) {
    return {
      ok: false,
      error: runErr ? translatePgError(runErr) : "Could not create run.",
    };
  }

  // 2. Bulk-insert one payroll_employee_runs row per active employee. Currency
  //    columns default to zero; scheduled_days defaults to 0 too. The DTR ingest
  //    in Task 50 fills in attendance + scheduled_days. We just need a slate.
  const { data: activeEmployees, error: emplErr } = await admin
    .from("employees")
    .select("id")
    .eq("is_active", true)
    .is("termination_date", null);
  if (emplErr) {
    // Best-effort cleanup so we don't leave an empty run laying around.
    await admin.from("payroll_runs").delete().eq("id", createdRun.id);
    return { ok: false, error: translatePgError(emplErr) };
  }

  const employeeRows = (activeEmployees ?? []).map((e) => ({
    run_id: createdRun.id,
    employee_id: e.id,
    scheduled_days: 0,
  }));
  if (employeeRows.length > 0) {
    const { error: bulkErr } = await admin
      .from("payroll_employee_runs")
      .insert(employeeRows);
    if (bulkErr) {
      await admin.from("payroll_runs").delete().eq("id", createdRun.id);
      return { ok: false, error: translatePgError(bulkErr) };
    }
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.created",
    resource_type: "payroll_run",
    resource_id: createdRun.id,
    metadata: {
      period_id: parsed.data.period_id,
      employee_count: employeeRows.length,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  return { ok: true, data: { run_id: createdRun.id } };
}

export async function recomputePayrollRunAction(
  run_id: string,
): Promise<RunActionResult<{ updated: number }>> {
  const session = await requireAdminStaff();
  if (!run_id || typeof run_id !== "string") {
    return { ok: false, error: "Run id is required." };
  }

  const admin = createAdminClient();

  // Guard: only draft runs can be (re)computed. The DB has no hard trigger for
  // this — once it flips to 'finalised' or 'voided' the bridge has already run
  // and recomputing would silently overwrite finalised numbers.
  const { data: existing, error: fetchErr } = await admin
    .from("payroll_runs")
    .select("id, status")
    .eq("id", run_id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "Run not found." };
  }
  if (existing.status !== "draft") {
    return {
      ok: false,
      error: `Run must be in 'draft' status to compute (currently '${existing.status}').`,
    };
  }

  const result = await computePayrollRun(admin, run_id);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.recomputed",
    resource_type: "payroll_run",
    resource_id: run_id,
    metadata: { updated: result.updated },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  revalidatePath(runDetailPath(run_id));
  return { ok: true, data: { updated: result.updated } };
}

export async function finaliseRunAction(
  run_id: string,
): Promise<RunActionResult> {
  const session = await requireAdminStaff();
  if (!run_id || typeof run_id !== "string") {
    return { ok: false, error: "Run id is required." };
  }

  const admin = createAdminClient();

  // Guard: must be 'computed' before finalise. The bridge (T29) fires
  // automatically on the status flip and posts the gross-up JE; the
  // P0020 trigger also checks DTR completeness server-side.
  const { data: existing, error: fetchErr } = await admin
    .from("payroll_runs")
    .select("id, status")
    .eq("id", run_id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "Run not found." };
  }
  if (existing.status !== "computed") {
    return {
      ok: false,
      error: `Run must be 'computed' before finalise (currently '${existing.status}').`,
    };
  }

  const { error } = await admin
    .from("payroll_runs")
    .update({
      status: "finalised",
      finalised_at: new Date().toISOString(),
      finalised_by: session.user_id,
    })
    .eq("id", run_id);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.finalised",
    resource_type: "payroll_run",
    resource_id: run_id,
    metadata: null,
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  revalidatePath(runDetailPath(run_id));
  return { ok: true, data: undefined };
}

export async function voidRunAction(
  raw: VoidRunInput,
): Promise<RunActionResult> {
  const session = await requireAdminStaff();
  const parsed = VoidRunSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: updated, error } = await admin
    .from("payroll_runs")
    .update({
      status: "voided",
      voided_at: new Date().toISOString(),
      voided_by: session.user_id,
      void_reason: parsed.data.void_reason,
    })
    .eq("id", parsed.data.run_id)
    .select("id")
    .maybeSingle();
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated) {
    return { ok: false, error: "Run not found." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.voided",
    resource_type: "payroll_run",
    resource_id: parsed.data.run_id,
    metadata: { void_reason: parsed.data.void_reason },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  revalidatePath(runDetailPath(parsed.data.run_id));
  return { ok: true, data: undefined };
}

export async function reopenVoidedRunAction(
  raw: ReopenVoidedRunInput,
): Promise<RunActionResult> {
  const session = await requireAdminStaff();
  const parsed = ReopenVoidedRunSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  // Strict guard: only 'voided' rows are eligible. Clearing the JE pointers
  // doesn't reverse them — the prior reversal JE stays in the ledger for audit.
  const { data: updated, error } = await admin
    .from("payroll_runs")
    .update({
      status: "draft",
      voided_at: null,
      voided_by: null,
      void_reason: null,
      gross_up_je_id: null,
      thirteenth_payout_je_id: null,
    })
    .eq("id", parsed.data.run_id)
    .eq("status", "voided")
    .select("id")
    .maybeSingle();
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }
  if (!updated) {
    return { ok: false, error: "Run not found, or not in 'voided' status." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.reopened_voided",
    resource_type: "payroll_run",
    resource_id: parsed.data.run_id,
    metadata: null,
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  revalidatePath(runDetailPath(parsed.data.run_id));
  return { ok: true, data: undefined };
}

// =============================================================================
// Per-employee payout
// =============================================================================

export async function markEmployeePaidAction(
  raw: MarkEmployeePaidInput,
): Promise<RunActionResult<{ payment_method: "cash" | "bank"; cash_adjustment_id?: string }>> {
  const session = await requireAdminStaff();
  const parsed = MarkEmployeePaidSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }
  // Note (v1): MarkEmployeePaidSchema.contra_account_id is accepted but unused.
  // Cash routing comes from cash_adjustment_account_map (12.C); bank routing
  // is hard-coded to 1020 inside bridge_payroll_payout_bank().

  const admin = createAdminClient();

  // Load the employee_run + payment_method + employee full_name in one shot.
  const { data: er, error: erErr } = await admin
    .from("payroll_employee_runs")
    .select(
      `id, run_id, employee_id, net_pay_php, payout_status,
       employee:employees!inner ( id, payment_method,
         staff_profile:staff_profiles!inner ( full_name ) ),
       run:payroll_runs!inner ( id, period:payroll_periods!inner ( period_start, period_end ) )`,
    )
    .eq("id", parsed.data.employee_run_id)
    .maybeSingle();
  if (erErr) {
    return { ok: false, error: translatePgError(erErr) };
  }
  if (!er) {
    return { ok: false, error: "Employee run not found." };
  }
  if (er.payout_status !== "pending") {
    return {
      ok: false,
      error: `Cannot mark paid: payout_status is already '${er.payout_status}'.`,
    };
  }

  // PostgREST returns the FK joins as either a single object or an array
  // depending on the relation cardinality; type both shapes defensively.
  const employee = Array.isArray(er.employee) ? er.employee[0] : er.employee;
  const run = Array.isArray(er.run) ? er.run[0] : er.run;
  if (!employee || !run) {
    return { ok: false, error: "Could not load employee or run details." };
  }
  const staffProfile = Array.isArray(employee.staff_profile)
    ? employee.staff_profile[0]
    : employee.staff_profile;
  const period = Array.isArray(run.period) ? run.period[0] : run.period;
  const employeeName = staffProfile?.full_name ?? "(unknown)";
  const periodLabel = period
    ? `${period.period_start} → ${period.period_end}`
    : er.run_id;

  const paymentMethod = employee.payment_method as "cash" | "bank";
  const stamp = new Date().toISOString();
  const { ip, ua } = await ipAndAgent();

  if (paymentMethod === "cash") {
    // 1. Find an active shift; the 12.C bridge uses (business_date, shift_id)
    //    as the lock key. The cash payout is keyed to "today" in Asia/Manila.
    const { data: shift, error: shiftErr } = await admin
      .from("cash_shifts")
      .select("id")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (shiftErr) {
      return { ok: false, error: translatePgError(shiftErr) };
    }
    if (!shift) {
      return { ok: false, error: "No active cash shift configured." };
    }
    const businessDate = new Date()
      .toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }); // YYYY-MM-DD

    // 2. Insert the cash adjustment. The 12.C bridge auto-posts the JE
    //    (DR 2360 Salaries Payable / CR 1000 Cash) on insert.
    const { data: adj, error: adjErr } = await admin
      .from("eod_cash_adjustments")
      .insert({
        business_date: businessDate,
        shift_id: shift.id,
        kind: "salary_payout",
        amount_php: er.net_pay_php,
        payee: employeeName,
        // payee_staff_id is left null: it references staff_profiles, and the
        // salary_payout flow is already tied to payroll_employee_runs via
        // payout_cash_adjustment_id below.
        notes: `Payroll payout — ${employeeName} for period ${periodLabel}`,
        recorded_by: session.user_id,
      })
      .select("id")
      .single();
    if (adjErr || !adj) {
      return {
        ok: false,
        error: adjErr ? translatePgError(adjErr) : "Could not record cash adjustment.",
      };
    }

    // 3. Flip the employee_run row to paid + link the cash adjustment.
    const { error: updErr } = await admin
      .from("payroll_employee_runs")
      .update({
        payout_status: "paid",
        payment_method_used: "cash",
        paid_at: stamp,
        paid_by: session.user_id,
        payout_cash_adjustment_id: adj.id,
      })
      .eq("id", parsed.data.employee_run_id);
    if (updErr) {
      // If we can't link, void the cash adjustment so the ledger stays consistent.
      await admin
        .from("eod_cash_adjustments")
        .update({
          voided_at: new Date().toISOString(),
          voided_by: session.user_id,
          void_reason: "Auto-void: failed to link to employee_run.",
        })
        .eq("id", adj.id);
      return { ok: false, error: translatePgError(updErr) };
    }

    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "payroll_run.marked_paid",
      resource_type: "payroll_employee_run",
      resource_id: parsed.data.employee_run_id,
      metadata: {
        run_id: er.run_id,
        employee_id: er.employee_id,
        payment_method: "cash",
        amount_php: er.net_pay_php,
        cash_adjustment_id: adj.id,
      },
      ip_address: ip,
      user_agent: ua,
    });

    revalidatePath(RUNS_PATH);
    revalidatePath(runDetailPath(er.run_id));
    revalidatePath(CASH_DRAWER_PATH);
    return {
      ok: true,
      data: { payment_method: "cash", cash_adjustment_id: adj.id },
    };
  }

  // Bank path — the bridge (bridge_payroll_payout_bank) posts the JE and sets
  // payout_je_id automatically on this UPDATE.
  const { error: bankErr } = await admin
    .from("payroll_employee_runs")
    .update({
      payment_method_used: "bank",
      payout_status: "paid",
      paid_at: stamp,
      paid_by: session.user_id,
    })
    .eq("id", parsed.data.employee_run_id);
  if (bankErr) {
    return { ok: false, error: translatePgError(bankErr) };
  }

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.marked_paid",
    resource_type: "payroll_employee_run",
    resource_id: parsed.data.employee_run_id,
    metadata: {
      run_id: er.run_id,
      employee_id: er.employee_id,
      payment_method: "bank",
      amount_php: er.net_pay_php,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  revalidatePath(runDetailPath(er.run_id));
  return { ok: true, data: { payment_method: "bank" } };
}

const VoidEmployeePayoutSchema = z.object({
  employee_run_id: z.string().uuid(),
  void_reason: z.string().trim().min(1, "Reason is required.").max(1000),
});

export async function voidEmployeePayoutAction(
  employee_run_id: string,
  void_reason: string,
): Promise<RunActionResult<{ warning?: string }>> {
  const session = await requireAdminStaff();
  const parsed = VoidEmployeePayoutSchema.safeParse({ employee_run_id, void_reason });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();

  const { data: er, error: erErr } = await admin
    .from("payroll_employee_runs")
    .select(
      "id, run_id, employee_id, payout_status, payment_method_used, payout_je_id, payout_cash_adjustment_id",
    )
    .eq("id", parsed.data.employee_run_id)
    .maybeSingle();
  if (erErr) {
    return { ok: false, error: translatePgError(erErr) };
  }
  if (!er) {
    return { ok: false, error: "Employee run not found." };
  }
  if (er.payout_status !== "paid") {
    return {
      ok: false,
      error: `Cannot void: payout_status is '${er.payout_status}', not 'paid'.`,
    };
  }

  let warning: string | undefined;

  if (er.payment_method_used === "cash") {
    // Cash path — void the underlying cash adjustment; the 12.C bridge
    // reverses the JE on this update.
    if (!er.payout_cash_adjustment_id) {
      return {
        ok: false,
        error: "Cash payout has no linked cash adjustment; cannot auto-void.",
      };
    }
    const { error: voidErr } = await admin
      .from("eod_cash_adjustments")
      .update({
        voided_at: new Date().toISOString(),
        voided_by: session.user_id,
        void_reason: parsed.data.void_reason,
      })
      .eq("id", er.payout_cash_adjustment_id)
      .is("voided_at", null);
    if (voidErr) {
      return { ok: false, error: translatePgError(voidErr) };
    }
  } else if (er.payment_method_used === "bank") {
    // Bank path — v1 leaves the reversal JE to be posted manually by an admin
    // via the JE editor. We surface the linked JE id in the warning so the
    // UI can route the admin straight to it.
    warning = er.payout_je_id
      ? `Bank payout voided — manually reverse JE ${er.payout_je_id} in the journal editor.`
      : "Bank payout voided — no linked JE was found to reverse.";
    // TODO(12.6.future): post the reversal JE programmatically via the admin
    // client (mirrors what bridge_cash_adjustment_void does for cash adjustments).
  } else {
    return {
      ok: false,
      error: "Employee run has no payment_method_used recorded; cannot void.",
    };
  }

  // Flip the payout status in either branch.
  const { error: flipErr } = await admin
    .from("payroll_employee_runs")
    .update({ payout_status: "voided" })
    .eq("id", parsed.data.employee_run_id);
  if (flipErr) {
    return { ok: false, error: translatePgError(flipErr) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.payout_voided",
    resource_type: "payroll_employee_run",
    resource_id: parsed.data.employee_run_id,
    metadata: {
      run_id: er.run_id,
      employee_id: er.employee_id,
      payment_method: er.payment_method_used,
      void_reason: parsed.data.void_reason,
      cash_adjustment_id: er.payout_cash_adjustment_id,
      payout_je_id: er.payout_je_id,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  revalidatePath(runDetailPath(er.run_id));
  if (er.payment_method_used === "cash") {
    revalidatePath(CASH_DRAWER_PATH);
  }
  return { ok: true, data: warning ? { warning } : {} };
}

// =============================================================================
// Earning + deduction lines
// =============================================================================

async function lookupEmployeeRunForLine(
  admin: ReturnType<typeof createAdminClient>,
  employee_run_id: string,
): Promise<{ run_id: string } | null> {
  const { data } = await admin
    .from("payroll_employee_runs")
    .select("run_id")
    .eq("id", employee_run_id)
    .maybeSingle();
  return data ?? null;
}

export async function addEarningLineAction(
  raw: AddEarningLineInput,
): Promise<RunActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = AddEarningLineSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("payroll_earning_lines")
    .insert({
      employee_run_id: parsed.data.employee_run_id,
      kind: parsed.data.kind,
      label: parsed.data.label,
      quantity: parsed.data.quantity ?? null,
      rate_php: parsed.data.rate_php ?? null,
      amount_php: parsed.data.amount_php,
      created_by: session.user_id,
    })
    .select("id, employee_run_id")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not add earning line.",
    };
  }

  const er = await lookupEmployeeRunForLine(admin, created.employee_run_id);

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.line_added",
    resource_type: "payroll_earning_line",
    resource_id: created.id,
    metadata: {
      employee_run_id: created.employee_run_id,
      kind: parsed.data.kind,
      label: parsed.data.label,
      amount_php: parsed.data.amount_php,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  if (er) revalidatePath(runDetailPath(er.run_id));
  return { ok: true, data: { id: created.id } };
}

export async function removeEarningLineAction(
  id: string,
): Promise<RunActionResult> {
  const session = await requireAdminStaff();
  if (!id || typeof id !== "string") {
    return { ok: false, error: "Line id is required." };
  }

  const admin = createAdminClient();
  // Capture metadata BEFORE delete so the audit row has context.
  const { data: existing, error: fetchErr } = await admin
    .from("payroll_earning_lines")
    .select("id, employee_run_id, kind, label, amount_php")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "Earning line not found." };
  }

  const { error } = await admin
    .from("payroll_earning_lines")
    .delete()
    .eq("id", id);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const er = await lookupEmployeeRunForLine(admin, existing.employee_run_id);

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.line_removed",
    resource_type: "payroll_earning_line",
    resource_id: id,
    metadata: {
      employee_run_id: existing.employee_run_id,
      kind: existing.kind,
      label: existing.label,
      amount_php: existing.amount_php,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  if (er) revalidatePath(runDetailPath(er.run_id));
  return { ok: true, data: undefined };
}

export async function addDeductionLineAction(
  raw: AddDeductionLineInput,
): Promise<RunActionResult<{ id: string }>> {
  const session = await requireAdminStaff();
  const parsed = AddDeductionLineSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();
  const { data: created, error } = await admin
    .from("payroll_deduction_lines")
    .insert({
      employee_run_id: parsed.data.employee_run_id,
      kind: parsed.data.kind,
      label: parsed.data.label,
      amount_php: parsed.data.amount_php,
      loan_id: parsed.data.loan_id ?? null,
      created_by: session.user_id,
    })
    .select("id, employee_run_id")
    .single();
  if (error || !created) {
    return {
      ok: false,
      error: error ? translatePgError(error) : "Could not add deduction line.",
    };
  }

  const er = await lookupEmployeeRunForLine(admin, created.employee_run_id);

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.line_added",
    resource_type: "payroll_deduction_line",
    resource_id: created.id,
    metadata: {
      employee_run_id: created.employee_run_id,
      kind: parsed.data.kind,
      label: parsed.data.label,
      amount_php: parsed.data.amount_php,
      loan_id: parsed.data.loan_id ?? null,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  if (er) revalidatePath(runDetailPath(er.run_id));
  return { ok: true, data: { id: created.id } };
}

export async function removeDeductionLineAction(
  id: string,
): Promise<RunActionResult> {
  const session = await requireAdminStaff();
  if (!id || typeof id !== "string") {
    return { ok: false, error: "Line id is required." };
  }

  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("payroll_deduction_lines")
    .select("id, employee_run_id, kind, label, amount_php, loan_id")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!existing) {
    return { ok: false, error: "Deduction line not found." };
  }

  const { error } = await admin
    .from("payroll_deduction_lines")
    .delete()
    .eq("id", id);
  if (error) {
    return { ok: false, error: translatePgError(error) };
  }

  const er = await lookupEmployeeRunForLine(admin, existing.employee_run_id);

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_run.line_removed",
    resource_type: "payroll_deduction_line",
    resource_id: id,
    metadata: {
      employee_run_id: existing.employee_run_id,
      kind: existing.kind,
      label: existing.label,
      amount_php: existing.amount_php,
      loan_id: existing.loan_id,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  if (er) revalidatePath(runDetailPath(er.run_id));
  return { ok: true, data: undefined };
}
