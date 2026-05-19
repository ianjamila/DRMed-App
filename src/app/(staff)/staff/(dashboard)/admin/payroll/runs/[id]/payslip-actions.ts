"use server";

// Server Actions for payslip PDF generation.
//
// Spec: docs/superpowers/specs/2026-05-18-12.6-payroll-design.md §13.
//
// T73 fills these in by calling generatePayslipPdf() from the helper and
// uploading the resulting bytes to the `payslips` Storage bucket (created
// by T74's migration 0045). The path is keyed by employee + period so the
// patient-facing reader (T76) can resolve by lookup.

import { revalidatePath } from "next/cache";
import { z } from "zod";

const RUNS_PATH = "/staff/admin/payroll/runs";
function runDetailPath(run_id: string) {
  return `${RUNS_PATH}/${run_id}`;
}
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { generatePayslipPdf } from "@/lib/payroll/payslip-pdf";
import { reportError } from "@/lib/observability/report-error";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";
import {
  RegeneratePayslipSchema,
  type RegeneratePayslipInput,
} from "@/lib/validations/accounting";

export type PayslipActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const PAYSLIP_BUCKET = "payslips";

type AdminClient = ReturnType<typeof createAdminClient>;

// Storage path format — spec §13:
//   ${employee_id}/${period_start}_${period_end}.pdf
// Keeps every revision for a given (employee, period) at the same key so
// upsert can overwrite cleanly on regeneration.
function buildStoragePath(
  employee_id: string,
  period_start: string,
  period_end: string,
): string {
  return `${employee_id}/${period_start}_${period_end}.pdf`;
}

// Generate + upload + record-update for a single employee_run. Returns the
// resulting storage path, or throws on failure. Caller decides whether to
// catch (batch mode) or surface the error (single-row regeneration).
async function generateAndUpload(
  admin: AdminClient,
  employee_run_id: string,
  employee_id: string,
  period_start: string,
  period_end: string,
): Promise<{ storage_path: string }> {
  const buf = await generatePayslipPdf(employee_run_id);
  const storage_path = buildStoragePath(employee_id, period_start, period_end);

  const { error: uploadErr } = await admin.storage
    .from(PAYSLIP_BUCKET)
    .upload(storage_path, buf, {
      upsert: true,
      contentType: "application/pdf",
    });
  if (uploadErr) {
    throw new Error(`Storage upload failed: ${uploadErr.message}`);
  }

  const { error: updateErr } = await admin
    .from("payroll_employee_runs")
    .update({
      payslip_file_path: storage_path,
      payslip_generated_at: new Date().toISOString(),
    })
    .eq("id", employee_run_id);
  if (updateErr) {
    throw new Error(`Record update failed: ${translatePgError(updateErr)}`);
  }

  return { storage_path };
}

// =============================================================================
// generatePayslipsForRunAction
// =============================================================================

const GeneratePayslipsForRunSchema = z.object({
  run_id: z.string().uuid(),
});

type GenerateBatchResult = {
  generated: number;
  failed: number;
  warning?: string;
};

/**
 * Generate per-employee payslip PDFs for every employee_run on the given
 * payroll run. Uploads to the `payslips` Storage bucket and records the
 * storage path + timestamp on each employee_run row.
 *
 * Per-employee errors are collected into a `failures` count and surfaced via
 * `warning` — the batch keeps going so one bad row doesn't abort the rest.
 * This action is auto-called by `finaliseRunAction` after the gross-up JE
 * posts; it can also be re-run manually from the run-review UI.
 */
export async function generatePayslipsForRunAction(
  run_id: string,
): Promise<PayslipActionResult<GenerateBatchResult>> {
  const session = await requireAdminStaff();
  const parsed = GeneratePayslipsForRunSchema.safeParse({ run_id });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();

  // Fetch all employee_runs for this run with the period dates needed for
  // the storage path. payroll_runs.period_id → payroll_periods.
  const { data: rows, error: fetchErr } = await admin
    .from("payroll_employee_runs")
    .select(
      `id, employee_id,
       payroll_runs:run_id!inner(
         id,
         payroll_periods:period_id!inner(period_start, period_end)
       )`,
    )
    .eq("run_id", parsed.data.run_id);

  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!rows || rows.length === 0) {
    const { ip, ua } = await ipAndAgent();
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "payroll_payslip.generated",
      resource_type: "payroll_run",
      resource_id: parsed.data.run_id,
      metadata: { run_id: parsed.data.run_id, generated: 0, failed: 0 },
      ip_address: ip,
      user_agent: ua,
    });
    return { ok: true, data: { generated: 0, failed: 0 } };
  }

  let generated = 0;
  const failures: Array<{ employee_run_id: string; error: string }> = [];

  for (const row of rows) {
    // The PostgREST relational select returns runs/periods as either an
    // object or an array depending on inferred cardinality.
    const runJoin = Array.isArray(row.payroll_runs)
      ? row.payroll_runs[0]
      : row.payroll_runs;
    const periodJoin = runJoin
      ? Array.isArray(runJoin.payroll_periods)
        ? runJoin.payroll_periods[0]
        : runJoin.payroll_periods
      : null;
    if (!periodJoin) {
      failures.push({
        employee_run_id: row.id,
        error: "Could not resolve period dates.",
      });
      continue;
    }

    try {
      await generateAndUpload(
        admin,
        row.id,
        row.employee_id,
        periodJoin.period_start,
        periodJoin.period_end,
      );
      generated += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ employee_run_id: row.id, error: message });
      // Log to Sentry so admins can grep — but don't abort the batch.
      await reportError({
        scope: "payroll.payslip_generate",
        error: err,
        metadata: {
          run_id: parsed.data.run_id,
          employee_run_id: row.id,
          employee_id: row.employee_id,
        },
      });
    }
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_payslip.generated",
    resource_type: "payroll_run",
    resource_id: parsed.data.run_id,
    metadata: {
      run_id: parsed.data.run_id,
      generated,
      failed: failures.length,
      // Cap the list so the audit row doesn't blow up on huge runs.
      failures: failures.slice(0, 20),
    },
    ip_address: ip,
    user_agent: ua,
  });

  const warning =
    failures.length > 0
      ? `${failures.length} of ${rows.length} payslip(s) failed to generate — see audit log.`
      : undefined;

  revalidatePath(RUNS_PATH);
  revalidatePath(runDetailPath(parsed.data.run_id));

  return {
    ok: true,
    data: { generated, failed: failures.length, warning },
  };
}

// =============================================================================
// regeneratePayslipAction
// =============================================================================

/**
 * Regenerate the payslip PDF for a single employee_run. Used by the
 * run-review UI when an admin edits an earning/deduction line after the
 * initial batch ran.
 */
export async function regeneratePayslipAction(
  input: RegeneratePayslipInput,
): Promise<PayslipActionResult<{ storage_path: string }>> {
  const session = await requireAdminStaff();
  const parsed = RegeneratePayslipSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();

  const { data: row, error: fetchErr } = await admin
    .from("payroll_employee_runs")
    .select(
      `id, employee_id, run_id,
       payroll_runs:run_id!inner(
         id,
         payroll_periods:period_id!inner(period_start, period_end)
       )`,
    )
    .eq("id", parsed.data.employee_run_id)
    .maybeSingle();

  if (fetchErr) {
    return { ok: false, error: translatePgError(fetchErr) };
  }
  if (!row) {
    return { ok: false, error: "Employee run not found." };
  }

  const runJoin = Array.isArray(row.payroll_runs)
    ? row.payroll_runs[0]
    : row.payroll_runs;
  const periodJoin = runJoin
    ? Array.isArray(runJoin.payroll_periods)
      ? runJoin.payroll_periods[0]
      : runJoin.payroll_periods
    : null;
  if (!periodJoin) {
    return { ok: false, error: "Could not resolve period dates." };
  }

  let storage_path: string;
  try {
    const result = await generateAndUpload(
      admin,
      row.id,
      row.employee_id,
      periodJoin.period_start,
      periodJoin.period_end,
    );
    storage_path = result.storage_path;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reportError({
      scope: "payroll.payslip_regenerate",
      error: err,
      metadata: {
        employee_run_id: parsed.data.employee_run_id,
        employee_id: row.employee_id,
        run_id: row.run_id,
      },
    });
    return { ok: false, error: message };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_payslip.regenerated",
    resource_type: "payroll_employee_run",
    resource_id: parsed.data.employee_run_id,
    metadata: {
      employee_run_id: parsed.data.employee_run_id,
      employee_id: row.employee_id,
      run_id: row.run_id,
      storage_path,
    },
    ip_address: ip,
    user_agent: ua,
  });

  revalidatePath(RUNS_PATH);
  revalidatePath(runDetailPath(row.run_id));

  return { ok: true, data: { storage_path } };
}
