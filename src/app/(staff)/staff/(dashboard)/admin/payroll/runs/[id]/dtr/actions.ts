"use server";

// Server Actions for the DTR (Daily Time Record) ingest flow on a run.
// Spec: docs/superpowers/specs/2026-05-18-12.6-payroll-design.md §5 / §13.
//
// Upload is single-shot: the CSV is parsed in-process, persisted to
// payroll_dtr_imports + payroll_dtr_rows, and any earlier imports for the
// same period have their rows flipped to status='superseded'. If a payroll_run
// for the period is currently in 'computed' state, it is bumped back to
// 'draft' (Q23) so it gets a chance to re-pull the new DTR data.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { parseDtrCsv } from "@/lib/payroll/dtr-parser";
import {
  UploadDtrSchema,
  type UploadDtrInput,
} from "@/lib/validations/accounting";
import type { Json } from "@/types/database";
import { ipAndAgent, firstIssue } from "@/lib/server/action-helpers";

// Discriminated-union shape consistent with the other payroll actions
// (createPeriodAction, recomputePayrollRunAction, etc.).
export type DtrActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

const RUNS_PATH = "/staff/admin/payroll/runs";

function runDtrPath(run_id: string) {
  return `${RUNS_PATH}/${run_id}/dtr`;
}

function runDetailPath(run_id: string) {
  return `${RUNS_PATH}/${run_id}`;
}

// =============================================================================
// uploadDtrAction
// =============================================================================

type UploadDtrSummary = {
  import_id: string;
  parsed: number;
  flagged_no_employee: number;
  flagged_missing_punch: number;
  errors: number;
};

/**
 * Parse and persist a CSV in one atomic operation. After the upload:
 *   - rows from any previous import for the same period are marked 'superseded'
 *   - the period's payroll_run, if currently 'computed', is bumped to 'draft'
 *
 * v1 has no preview-then-commit flow; commitDtrAction is a placeholder.
 */
export async function uploadDtrAction(
  raw: UploadDtrInput,
): Promise<DtrActionResult<UploadDtrSummary>> {
  const session = await requireAdminStaff();
  const parsed = UploadDtrSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();

  // -- 1. Find the run for this period (so we know which sub-page to
  // revalidate). The upload itself is keyed off period_id, but if there's a
  // computed run we have to bump it back to draft.
  const { data: runForPeriod, error: runLookupErr } = await admin
    .from("payroll_runs")
    .select("id, status")
    .eq("period_id", parsed.data.period_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runLookupErr) {
    return { ok: false, error: translatePgError(runLookupErr) };
  }

  // -- 2. Insert the parent import row with parsed_rows_count = 0 (we update
  // it below once the parse completes). parse_errors stays null until we know
  // we have errors to record.
  const { data: importRow, error: importErr } = await admin
    .from("payroll_dtr_imports")
    .insert({
      period_id: parsed.data.period_id,
      filename: parsed.data.filename,
      raw_csv_text: parsed.data.csv_text,
      uploaded_by: session.user_id,
      parsed_rows_count: 0,
    })
    .select("id")
    .single();
  if (importErr || !importRow) {
    return {
      ok: false,
      error: importErr ? translatePgError(importErr) : "Could not record DTR import.",
    };
  }
  const importId = importRow.id;

  // -- 3. Parse the CSV in-process.
  const parseResult = parseDtrCsv(parsed.data.csv_text);

  // Persist parse errors (if any) onto the import row immediately so they're
  // always recoverable from the DB, even if a later step fails.
  if (parseResult.errors.length > 0) {
    const { error: updErr } = await admin
      .from("payroll_dtr_imports")
      // reason: parse_errors is a typed Json column, but DtrParseError[] is a
      // richer shape than Json's recursive type allows. The cast widens it
      // back to Json for the typed insert.
      .update({ parse_errors: parseResult.errors as unknown as Json })
      .eq("id", importId);
    if (updErr) {
      return { ok: false, error: translatePgError(updErr) };
    }
  }

  // Audit a parse_failed event if there were any errors. This is separate from
  // payroll_dtr.imported (which always fires on a successful upload row).
  const { ip, ua } = await ipAndAgent();
  if (parseResult.errors.length > 0) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "payroll_dtr.parse_failed",
      resource_type: "payroll_dtr_import",
      resource_id: importId,
      metadata: {
        period_id: parsed.data.period_id,
        errors_count: parseResult.errors.length,
        filename: parsed.data.filename,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  // -- 4. Resolve external_id_raw -> employees.id once for the batch.
  const externalIds = Array.from(
    new Set(parseResult.rows.map((r) => r.external_id_raw)),
  );
  let mapping = new Map<string, string>();
  if (externalIds.length > 0) {
    const { data: empMatches, error: empErr } = await admin
      .from("employees")
      .select("id, dtr_external_id")
      .in("dtr_external_id", externalIds);
    if (empErr) {
      return { ok: false, error: translatePgError(empErr) };
    }
    mapping = new Map(
      (empMatches ?? [])
        .filter((e): e is { id: string; dtr_external_id: string } =>
          typeof e.dtr_external_id === "string" && e.dtr_external_id.length > 0,
        )
        .map((e) => [e.dtr_external_id, e.id]),
    );
  }

  // -- 5. Classify and bulk insert payroll_dtr_rows.
  let flaggedNoEmployee = 0;
  let flaggedMissingPunch = 0;
  let parsedCount = 0;

  const rowsToInsert = parseResult.rows.map((r) => {
    const empId = mapping.get(r.external_id_raw) ?? null;
    let status: "parsed" | "flagged_no_employee" | "flagged_missing_punch";
    if (!empId) {
      status = "flagged_no_employee";
      flaggedNoEmployee += 1;
    } else if (r.time_in_iso === null || r.time_out_iso === null) {
      status = "flagged_missing_punch";
      flaggedMissingPunch += 1;
    } else {
      status = "parsed";
      parsedCount += 1;
    }
    return {
      import_id: importId,
      employee_id: empId,
      external_id_raw: r.external_id_raw,
      work_date: r.work_date,
      time_in: r.time_in_iso,
      time_out: r.time_out_iso,
      total_hours: r.total_hours,
      status,
      // reason: source_row is a typed Json column, but Record<string, string>
      // is a richer shape than Json's recursive type allows. The cast widens it
      // back to Json for the typed insert.
      source_row: r.source_row as unknown as Json,
      notes: r.parse_warnings.length > 0 ? r.parse_warnings.join("; ") : null,
    };
  });

  if (rowsToInsert.length > 0) {
    const { error: bulkErr } = await admin
      .from("payroll_dtr_rows")
      .insert(rowsToInsert);
    if (bulkErr) {
      return { ok: false, error: translatePgError(bulkErr) };
    }
  }

  // -- 6. Supersede earlier imports' rows for this period. PostgREST doesn't
  // support correlated subselects in UPDATE; do it in two queries.
  const { data: priorImports, error: priorErr } = await admin
    .from("payroll_dtr_imports")
    .select("id")
    .eq("period_id", parsed.data.period_id)
    .neq("id", importId);
  if (priorErr) {
    return { ok: false, error: translatePgError(priorErr) };
  }
  const priorIds = (priorImports ?? []).map((p) => p.id);
  if (priorIds.length > 0) {
    const { error: supersedeErr } = await admin
      .from("payroll_dtr_rows")
      .update({ status: "superseded" })
      .in("import_id", priorIds);
    if (supersedeErr) {
      return { ok: false, error: translatePgError(supersedeErr) };
    }
  }

  // -- 7. Stamp parsed_rows_count on the import row. (parsed = rows that got
  // status 'parsed'; flagged rows are still inserted, just not counted here.)
  const { error: stampErr } = await admin
    .from("payroll_dtr_imports")
    .update({ parsed_rows_count: parsedCount })
    .eq("id", importId);
  if (stampErr) {
    return { ok: false, error: translatePgError(stampErr) };
  }

  // -- 8. If the period's run is currently 'computed', bump it back to draft
  // (Q23). We ignore the case where the run is in another state — there's
  // nothing to do.
  if (runForPeriod && runForPeriod.status === "computed") {
    const { error: bumpErr } = await admin
      .from("payroll_runs")
      .update({ status: "draft" })
      .eq("id", runForPeriod.id)
      .eq("status", "computed");
    if (bumpErr) {
      return { ok: false, error: translatePgError(bumpErr) };
    }
  }

  // -- 9. Audit + revalidate.
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_dtr.imported",
    resource_type: "payroll_dtr_import",
    resource_id: importId,
    metadata: {
      period_id: parsed.data.period_id,
      parsed: parsedCount,
      flagged_no_employee: flaggedNoEmployee,
      flagged_missing_punch: flaggedMissingPunch,
      errors_count: parseResult.errors.length,
      filename: parsed.data.filename,
    },
    ip_address: ip,
    user_agent: ua,
  });

  if (runForPeriod) {
    revalidatePath(runDtrPath(runForPeriod.id));
    revalidatePath(runDetailPath(runForPeriod.id));
  }
  revalidatePath(RUNS_PATH);

  return {
    ok: true,
    data: {
      import_id: importId,
      parsed: parsedCount,
      flagged_no_employee: flaggedNoEmployee,
      flagged_missing_punch: flaggedMissingPunch,
      errors: parseResult.errors.length,
    },
  };
}

// =============================================================================
// commitDtrAction — placeholder for a future preview-then-commit flow.
// =============================================================================

export async function commitDtrAction(
  import_id: string,
): Promise<DtrActionResult<{ committed: true }>> {
  const session = await requireAdminStaff();
  if (!import_id || typeof import_id !== "string") {
    return { ok: false, error: "Import id is required." };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_dtr.committed",
    resource_type: "payroll_dtr_import",
    resource_id: import_id,
    metadata: null,
    ip_address: ip,
    user_agent: ua,
  });

  return { ok: true, data: { committed: true } };
}

// =============================================================================
// reconcileDtrEmployeeAction — manual rescue for 'flagged_no_employee' rows.
// =============================================================================

const ReconcileDtrEmployeeSchema = z.object({
  dtr_row_id: z.string().uuid(),
  employee_id: z.string().uuid(),
});

export async function reconcileDtrEmployeeAction(
  dtr_row_id: string,
  employee_id: string,
): Promise<DtrActionResult> {
  const session = await requireAdminStaff();
  const parsed = ReconcileDtrEmployeeSchema.safeParse({ dtr_row_id, employee_id });
  if (!parsed.success) {
    return { ok: false, error: firstIssue(parsed.error) };
  }

  const admin = createAdminClient();

  // Decide if the row is eligible AND grab the parent import->period->run so
  // we know what to revalidate. Strict guard: status must currently be
  // 'flagged_no_employee'.
  const { data: row, error: rowErr } = await admin
    .from("payroll_dtr_rows")
    .select(
      `id, status, import:payroll_dtr_imports!inner ( id, period_id )`,
    )
    .eq("id", parsed.data.dtr_row_id)
    .maybeSingle();
  if (rowErr) {
    return { ok: false, error: translatePgError(rowErr) };
  }
  if (!row) {
    return { ok: false, error: "DTR row not found." };
  }
  if (row.status !== "flagged_no_employee") {
    return {
      ok: false,
      error: `Cannot reconcile: row status is '${row.status}', not 'flagged_no_employee'.`,
    };
  }

  // PostgREST returns the FK join as either a single object or an array
  // depending on relation cardinality; type both shapes defensively.
  const importJoin = Array.isArray(row.import) ? row.import[0] : row.import;
  const periodId = importJoin?.period_id ?? null;

  const { error: updErr } = await admin
    .from("payroll_dtr_rows")
    .update({
      employee_id: parsed.data.employee_id,
      status: "parsed",
    })
    .eq("id", parsed.data.dtr_row_id)
    .eq("status", "flagged_no_employee");
  if (updErr) {
    return { ok: false, error: translatePgError(updErr) };
  }

  const { ip, ua } = await ipAndAgent();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "payroll_dtr.reconciled",
    resource_type: "payroll_dtr_row",
    resource_id: parsed.data.dtr_row_id,
    metadata: {
      dtr_row_id: parsed.data.dtr_row_id,
      employee_id: parsed.data.employee_id,
    },
    ip_address: ip,
    user_agent: ua,
  });

  // Best-effort revalidation of the originating run's DTR sub-page.
  if (periodId) {
    const { data: run } = await admin
      .from("payroll_runs")
      .select("id")
      .eq("period_id", periodId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run) {
      revalidatePath(runDtrPath(run.id));
      revalidatePath(runDetailPath(run.id));
    }
  }
  revalidatePath(RUNS_PATH);

  return { ok: true, data: undefined };
}
