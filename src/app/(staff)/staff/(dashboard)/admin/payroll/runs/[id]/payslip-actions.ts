"use server";

// Server Action stubs for payslip PDF generation.
//
// These let D3 (admin pages) + the run-finalise bridge wire up call paths
// without blocking on PDF work. D4 will fill in the actual generation via
// src/lib/payroll/payslip-pdf.ts.
//
// Spec: docs/superpowers/specs/2026-05-18-12.6-payroll-design.md §13.

import { headers } from "next/headers";
import { z } from "zod";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  RegeneratePayslipSchema,
  type RegeneratePayslipInput,
} from "@/lib/validations/accounting";

export type PayslipActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

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

// =============================================================================
// generatePayslipsForRunAction — STUB
// =============================================================================

const GeneratePayslipsForRunSchema = z.object({
  run_id: z.string().uuid(),
});

/**
 * Generate per-employee payslip PDFs for every employee_run on the given
 * payroll run.
 *
 * TODO(D4): Wiring to src/lib/payroll/payslip-pdf.ts happens in D4. For now,
 * this stub returns success with a warning so the run-finalise flow doesn't
 * fail. The audit row is still written so the trail records every attempt.
 */
export async function generatePayslipsForRunAction(
  run_id: string,
): Promise<PayslipActionResult<{ generated: number; warning: string }>> {
  const session = await requireAdminStaff();
  const parsed = GeneratePayslipsForRunSchema.safeParse({ run_id });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
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
      stub: true,
    },
    ip_address: ip,
    user_agent: ua,
  });

  return {
    ok: true,
    data: {
      generated: 0,
      warning: "Payslip PDF generation will be implemented in D4.",
    },
  };
}

// =============================================================================
// regeneratePayslipAction — STUB
// =============================================================================

/**
 * Regenerate the payslip PDF for a single employee_run.
 *
 * TODO(D4): Wiring to src/lib/payroll/payslip-pdf.ts happens in D4. For now,
 * this stub returns success with a warning so the admin UI can wire up the
 * call path. The audit row is still written.
 */
export async function regeneratePayslipAction(
  input: RegeneratePayslipInput,
): Promise<PayslipActionResult<{ warning: string }>> {
  const session = await requireAdminStaff();
  const parsed = RegeneratePayslipSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
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
      stub: true,
    },
    ip_address: ip,
    user_agent: ua,
  });

  return {
    ok: true,
    data: {
      warning: "Payslip PDF regeneration will be implemented in D4.",
    },
  };
}
