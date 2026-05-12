"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import {
  CloseQuarterSchema,
  ReopenQuarterSchema,
} from "@/lib/validations/accounting";
import { translatePgError } from "@/lib/accounting/pg-errors";

export type PeriodResult = { ok: true } | { ok: false; error: string };

function lastDayOfQuarter(year: number, quarter: 1 | 2 | 3 | 4): Date {
  const endMonth = quarter * 3; // 3, 6, 9, 12
  // Last day of the quarter's final month.
  return new Date(year, endMonth, 0);
}

export async function closeQuarterAction(
  fiscalYear: number,
  fiscalQuarter: 1 | 2 | 3 | 4,
  notes: string | null,
): Promise<PeriodResult> {
  const session = await requireAdminStaff();
  const parsed = CloseQuarterSchema.safeParse({
    fiscal_year: fiscalYear,
    fiscal_quarter: fiscalQuarter,
    notes,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid quarter.",
    };
  }

  // Reject future quarters (quarter's last day must be in the past).
  const lastDay = lastDayOfQuarter(parsed.data.fiscal_year, parsed.data.fiscal_quarter as 1 | 2 | 3 | 4);
  if (lastDay >= new Date()) {
    return {
      ok: false,
      error: `Cannot close Q${parsed.data.fiscal_quarter} ${parsed.data.fiscal_year} — the quarter hasn't ended yet.`,
    };
  }

  const admin = createAdminClient();

  // Read current state to determine "already closed".
  const { data: existing } = await admin
    .from("accounting_periods")
    .select("id, status")
    .eq("fiscal_year", parsed.data.fiscal_year)
    .eq("fiscal_quarter", parsed.data.fiscal_quarter);
  if (!existing || existing.length !== 3) {
    return { ok: false, error: "Quarter periods not found. Was the seed run?" };
  }
  if (existing.every((p) => p.status === "closed")) {
    return { ok: false, error: `Q${parsed.data.fiscal_quarter} ${parsed.data.fiscal_year} is already closed.` };
  }

  // Atomic update — all 3 months flip together.
  const { data: updated, error } = await admin
    .from("accounting_periods")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by: session.user_id,
      notes: parsed.data.notes ?? null,
    })
    .eq("fiscal_year", parsed.data.fiscal_year)
    .eq("fiscal_quarter", parsed.data.fiscal_quarter)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "period.quarter.closed",
    resource_type: "accounting_periods",
    metadata: {
      fiscal_year: parsed.data.fiscal_year,
      fiscal_quarter: parsed.data.fiscal_quarter,
      period_ids: (updated ?? []).map((r) => r.id),
      notes: parsed.data.notes ?? null,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/accounting/periods");
  return { ok: true };
}

export async function reopenQuarterAction(
  fiscalYear: number,
  fiscalQuarter: 1 | 2 | 3 | 4,
  reason: string,
): Promise<PeriodResult> {
  const session = await requireAdminStaff();
  const parsed = ReopenQuarterSchema.safeParse({
    fiscal_year: fiscalYear,
    fiscal_quarter: fiscalQuarter,
    reason,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input.",
    };
  }

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("accounting_periods")
    .select("id, status")
    .eq("fiscal_year", parsed.data.fiscal_year)
    .eq("fiscal_quarter", parsed.data.fiscal_quarter);
  if (!existing || existing.length !== 3) {
    return { ok: false, error: "Quarter periods not found." };
  }
  if (existing.every((p) => p.status === "open")) {
    return { ok: false, error: `Q${parsed.data.fiscal_quarter} ${parsed.data.fiscal_year} is already open.` };
  }

  const { data: updated, error } = await admin
    .from("accounting_periods")
    .update({
      status: "open",
      closed_at: null,
      closed_by: null,
      // Keep notes as historical record of the close; reopen reason goes to audit only.
    })
    .eq("fiscal_year", parsed.data.fiscal_year)
    .eq("fiscal_quarter", parsed.data.fiscal_quarter)
    .select("id");
  if (error) return { ok: false, error: translatePgError(error) };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "period.quarter.reopened",
    resource_type: "accounting_periods",
    metadata: {
      fiscal_year: parsed.data.fiscal_year,
      fiscal_quarter: parsed.data.fiscal_quarter,
      reason: parsed.data.reason,
      period_ids: (updated ?? []).map((r) => r.id),
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/admin/accounting/periods");
  return { ok: true };
}
