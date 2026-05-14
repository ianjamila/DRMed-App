"use server";

import { createHash } from "node:crypto";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import {
  uploadRunInput,
  validateRunInput,
  mapProviderAliasInput,
  mapServiceAliasInput,
  commitRunInput,
  discardRunInput,
} from "@/lib/validations/accounting";
import {
  parseXlsxBuffer,
  parseCsvBuffer,
  type ParsedRow,
  type SourceTab,
} from "@/lib/import/parse-mastersheet";
import { parseHmoReferenceAging } from "@/lib/import/reconciliation";
import { contentHash } from "@/lib/import/content-hash";
import { todayManilaISODate } from "@/lib/dates/manila";
import type { Json } from "@/types/database";

type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

// =============================================================================
// parseWorkbookAction — upload + parse + stage
// =============================================================================

export async function parseWorkbookAction(
  formData: FormData,
): Promise<
  ActionResult<{
    run_id: string;
    cutover_date: string;
    parsed_count: number;
    skipped_post_cutover_count: number;
    csv_reconciliation_skipped: boolean;
  }>
> {
  const staff = await requireAdminStaff();

  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "missing file" };
  if (file.size === 0) return { ok: false, error: "empty file" };
  if (file.size > 25 * 1024 * 1024) return { ok: false, error: "file too large (>25MB)" };

  const cutoverRaw = (formData.get("cutover_date") ?? todayManilaISODate()) as string;
  const parsed = uploadRunInput.safeParse({ cutover_date: cutoverRaw });
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  const cutoverISO = parsed.data.cutover_date;

  const buf = Buffer.from(await file.arrayBuffer());
  const fileHash = createHash("sha256").update(buf).digest("hex");

  // Parse depending on extension.
  let summary;
  let workbook: import("exceljs").Workbook | null = null;
  const isCsv = file.name.toLowerCase().endsWith(".csv");
  try {
    if (isCsv) {
      // CSV per-tab requires a tab hint encoded in filename, e.g.
      // "DR MED MASTERSHEET - LAB SERVICE.csv". Detect crudely.
      const tab: SourceTab = file.name.toUpperCase().includes("DOCTOR CONSULT")
        ? "DOCTOR CONSULTATION"
        : "LAB SERVICE";
      summary = parseCsvBuffer(tab, buf, { cutoverISO });
    } else {
      const result = await parseXlsxBuffer(buf, { cutoverISO });
      summary = result.summary;
      workbook = result.workbook;
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "parse failed" };
  }

  // Bail out if header assertions failed.
  const headerFails = summary.parseErrors.filter((e) => e.message.startsWith("header_mismatch"));
  if (headerFails.length > 0) {
    return {
      ok: false,
      error: `header mismatch: ${headerFails.map((e) => `${e.tab}: ${e.message}`).join("; ")}`,
    };
  }

  const supabase = createAdminClient();

  // Insert the run.
  const { data: runRow, error: runErr } = await supabase
    .from("hmo_import_runs")
    .insert({
      run_kind: "dry_run",
      file_hash: fileHash,
      file_name: file.name,
      cutover_date: cutoverISO,
      uploaded_by: staff.user_id,
    })
    .select("id")
    .single();
  if (runErr || !runRow) {
    return { ok: false, error: runErr?.message ?? "could not insert run" };
  }

  const runId = runRow.id;

  // Insert all parsed rows into staging in chunks of 1000.
  const allRows: ParsedRow[] = [
    ...summary.rowsByTab["LAB SERVICE"],
    ...summary.rowsByTab["DOCTOR CONSULTATION"],
  ];
  let inserted = 0;
  const CHUNK = 1000;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    const chunk = allRows.slice(i, i + CHUNK).map((r) => ({
      run_id: runId,
      source_tab: r.source_tab,
      source_row_no: r.source_row_no,
      source_date: r.source_date,
      patient_name_raw: r.patient_name_raw,
      normalized_patient_name: r.normalized_patient_name,
      last_name_raw: r.last_name_raw,
      first_name_raw: r.first_name_raw,
      provider_name_raw: r.provider_name_raw,
      service_name_raw: r.service_name_raw,
      senior_pwd_flag: r.senior_pwd_flag,
      hmo_approval_date: r.hmo_approval_date,
      billed_amount: r.billed_amount,
      submission_date: r.submission_date,
      reference_no: r.reference_no,
      or_number: r.or_number,
      payment_received_date: r.payment_received_date,
      status: "parsed" as const,
    }));
    const { error: stagingErr } = await supabase.from("hmo_history_staging").insert(chunk);
    if (stagingErr) return { ok: false, error: `staging insert failed: ${stagingErr.message}` };
    inserted += chunk.length;
  }

  const skipped =
    summary.skipPostCutoverCount["LAB SERVICE"] +
    summary.skipPostCutoverCount["DOCTOR CONSULTATION"];

  // Update run counts.
  await supabase
    .from("hmo_import_runs")
    .update({ staging_count: inserted })
    .eq("id", runId);

  // Parse HMO REFERENCE aging block and stash on the run for validate to consume.
  if (!isCsv && workbook) {
    const aging = parseHmoReferenceAging(workbook, cutoverISO).map((a) => ({
      provider_name: a.providerNameRaw,
      ending_php: a.endingBalancePhp,
    }));
    await supabase
      .from("hmo_import_runs")
      .update({ summary: { reconciliation: aging } as Json })
      .eq("id", runId);
  } else if (isCsv) {
    // CSV uploads skip the HMO REFERENCE aging block (it only exists in the
    // full workbook). Mark this on the run so the UI can explain the empty
    // reconciliation panel.
    await supabase
      .from("hmo_import_runs")
      .update({ summary: { csv_reconciliation_skipped: true } as unknown as Json })
      .eq("id", runId);
  }

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "hmo_history_import.uploaded",
    resource_type: "hmo_import_runs",
    resource_id: runId,
    metadata: {
      file_hash: fileHash,
      file_name: file.name,
      cutover_date: cutoverISO,
      parsed_count: inserted,
      skipped_post_cutover_count: skipped,
      csv_reconciliation_skipped: isCsv,
      parse_errors: summary.parseErrors.slice(0, 100),
    } as Json,
  });

  return {
    ok: true,
    data: {
      run_id: runId,
      cutover_date: cutoverISO,
      parsed_count: inserted,
      skipped_post_cutover_count: skipped,
      csv_reconciliation_skipped: isCsv,
    },
  };
}

// =============================================================================
// validateRunAction — per-row + cross-row severities, reconciliation compute
// =============================================================================

type RowValidationError = {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
};

type StagingUpdate = {
  id: string;
  provider_id_resolved: string | null;
  service_id_resolved: string | null;
  visit_group_key: string | null;
  content_hash: string | null;
  validation_errors: RowValidationError[];
  status: "validated" | "skipped_post_cutover";
};

export async function validateRunAction(input: { run_id: string }): Promise<
  ActionResult<{
    error_count: number;
    warning_count: number;
    unmapped_providers: { alias: string; row_count: number }[];
    unmapped_services: {
      alias: string;
      kind: "lab_test" | "doctor_consultation";
      row_count: number;
    }[];
    reconciliation: {
      provider_id: string;
      provider_name: string;
      wb_ending_php: number | null;
      staged_ar_php: number;
      variance_pct: number | null;
      severity: "green" | "yellow" | "red" | "no_reference";
    }[];
  }>
> {
  const staff = await requireAdminStaff();
  const parsed = validateRunInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  const supabase = createAdminClient();
  const runId = parsed.data.run_id;

  // 1. Load staging rows for this run with status = 'parsed'.
  const { data: stagingRows, error: stagingErr } = await supabase
    .from("hmo_history_staging")
    .select("*")
    .eq("run_id", runId)
    .eq("status", "parsed");
  if (stagingErr || !stagingRows) {
    return { ok: false, error: stagingErr?.message ?? "no rows" };
  }

  // 2. Load lookup tables.
  const [providersR, aliasesPR, servicesR, aliasesSR, runR] = await Promise.all([
    supabase.from("hmo_providers").select("id, name").eq("is_active", true),
    supabase.from("hmo_provider_aliases").select("alias, provider_id"),
    supabase.from("services").select("id, name, kind").eq("is_active", true),
    supabase.from("hmo_service_aliases").select("alias, service_id"),
    supabase.from("hmo_import_runs").select("cutover_date, summary").eq("id", runId).single(),
  ]);
  if (runR.error || !runR.data) {
    return { ok: false, error: runR.error?.message ?? "no run" };
  }

  const providerByName = new Map<string, string>();
  providersR.data?.forEach((p) => providerByName.set(p.name.toUpperCase(), p.id));
  const providerAlias = new Map<string, string>();
  aliasesPR.data?.forEach((a) => providerAlias.set(a.alias, a.provider_id));

  const serviceByName = new Map<string, { id: string; kind: string }>();
  servicesR.data?.forEach((s) => serviceByName.set(s.name.toUpperCase(), { id: s.id, kind: s.kind }));
  const serviceAlias = new Map<string, string>();
  aliasesSR.data?.forEach((a) => serviceAlias.set(a.alias, a.service_id));

  // 3. Per-row resolution + severity.
  const unmappedProviders = new Map<string, number>();
  const unmappedServices = new Map<
    string,
    { kind: "lab_test" | "doctor_consultation"; row_count: number }
  >();
  const orProviderMap = new Map<string, Set<string>>(); // or_number → set of provider_ids
  let errorCount = 0;
  let warningCount = 0;

  const updates: StagingUpdate[] = [];

  for (const row of stagingRows) {
    const errors: RowValidationError[] = [];

    // Rule 2: skip post-cutover (parser already did this, but defensive).
    if (row.source_date > runR.data.cutover_date) {
      updates.push({
        id: row.id,
        provider_id_resolved: null,
        service_id_resolved: null,
        visit_group_key: null,
        content_hash: null,
        validation_errors: [],
        status: "skipped_post_cutover",
      });
      continue;
    }

    // Rule 3: provider resolution.
    const provKey = row.provider_name_raw.toUpperCase();
    const provId =
      providerAlias.get(row.provider_name_raw) ?? providerByName.get(provKey) ?? null;
    if (!provId) {
      errors.push({
        code: "unmapped_provider",
        message: `provider "${row.provider_name_raw}"`,
        severity: "error",
      });
      unmappedProviders.set(
        row.provider_name_raw,
        (unmappedProviders.get(row.provider_name_raw) ?? 0) + 1,
      );
    }

    // Rule 4: service resolution.
    const svcKey = row.service_name_raw.toUpperCase();
    const svcByAlias = serviceAlias.get(row.service_name_raw);
    const svcByName = serviceByName.get(svcKey);
    const svcId = svcByAlias ?? svcByName?.id ?? null;
    if (!svcId) {
      errors.push({
        code: "unmapped_service",
        message: `service "${row.service_name_raw}"`,
        severity: "error",
      });
      const kind: "lab_test" | "doctor_consultation" =
        row.source_tab === "DOCTOR CONSULTATION" ? "doctor_consultation" : "lab_test";
      const ent = unmappedServices.get(row.service_name_raw) ?? { kind, row_count: 0 };
      ent.row_count++;
      unmappedServices.set(row.service_name_raw, ent);
    }

    // Rule 5: billed_amount > 0 (CHECK constraint).
    if (!(row.billed_amount > 0)) {
      errors.push({
        code: "invalid_amount",
        message: `billed_amount=${row.billed_amount}`,
        severity: "error",
      });
    }

    // Rule 6: paid_amount ≤ billed_amount.
    if (row.payment_received_date && row.paid_amount > row.billed_amount) {
      errors.push({
        code: "overpaid",
        message: `paid (${row.paid_amount}) > billed (${row.billed_amount})`,
        severity: "error",
      });
    }

    // Rule 9: patient_name has comma (already enforced at parse time; defensive).
    if (!row.patient_name_raw.includes(",")) {
      errors.push({
        code: "patient_name_no_comma",
        message: `"${row.patient_name_raw}" must be in "Last, First" format`,
        severity: "error",
      });
    }

    // Cross-row Rule A: or_number scan.
    if (row.or_number && provId) {
      if (!orProviderMap.has(row.or_number)) orProviderMap.set(row.or_number, new Set());
      orProviderMap.get(row.or_number)!.add(provId);
    }

    const has_error = errors.some((e) => e.severity === "error");
    if (has_error) errorCount++;

    // visit_group_key (only when provider resolved).
    const visit_group_key = provId
      ? createHash("sha256")
          .update(`${row.source_date}|${row.normalized_patient_name}|${provId}`)
          .digest("hex")
      : null;

    // content_hash (only when both provider + service resolved AND no errors block it).
    const content_hash_val =
      provId && svcId
        ? contentHash({
            sourceTab: row.source_tab as "LAB SERVICE" | "DOCTOR CONSULTATION",
            normalizedPatientName: row.normalized_patient_name,
            sourceDate: row.source_date,
            providerId: provId,
            serviceId: svcId,
            billedAmount: row.billed_amount,
            referenceNo: row.reference_no,
          })
        : null;

    updates.push({
      id: row.id,
      provider_id_resolved: provId,
      service_id_resolved: svcId,
      visit_group_key,
      content_hash: content_hash_val,
      validation_errors: errors,
      status: "validated",
    });
  }

  // Cross-row Rule A: tag cross-provider duplicate OR# as warning.
  for (const [or, provs] of orProviderMap.entries()) {
    if (provs.size > 1) {
      for (const u of updates) {
        const sr = stagingRows.find((r) => r.id === u.id);
        if (sr?.or_number === or) {
          u.validation_errors.push({
            code: "cross_provider_or",
            message: `OR# ${or} appears under ${provs.size} providers`,
            severity: "warning",
          });
        }
      }
    }
  }

  // Recompute warningCount at row-level granularity (mirrors errorCount),
  // counting each affected row once regardless of how many warnings it has.
  warningCount = updates.filter(
    (u) => u.validation_errors.some((e) => e.severity === "warning"),
  ).length;

  // Apply updates in chunks via bulk upsert (one round-trip per chunk
  // instead of one UPDATE per row). The supabase-js typed `upsert` requires
  // full Insert shape, so we merge each existing staging row with the new
  // resolved fields rather than sending a partial payload.
  const stagingById = new Map(stagingRows.map((r) => [r.id, r]));
  for (let i = 0; i < updates.length; i += 500) {
    const chunk = updates.slice(i, i + 500).map((u) => {
      const sr = stagingById.get(u.id)!;
      return {
        ...sr,
        provider_id_resolved: u.provider_id_resolved,
        service_id_resolved: u.service_id_resolved,
        visit_group_key: u.visit_group_key,
        content_hash: u.content_hash,
        validation_errors: u.validation_errors as unknown as Json,
        status: u.status,
      };
    });
    const { error: upsertErr } = await supabase
      .from("hmo_history_staging")
      .upsert(chunk, { onConflict: "id" });
    if (upsertErr) {
      return { ok: false, error: `staging upsert failed at chunk ${i}: ${upsertErr.message}` };
    }
  }

  // 4. Reconciliation. Re-load the file from disk would be slow; instead read
  //    the HMO REFERENCE aging that parseWorkbookAction stashed on the run summary.
  const summaryJson = runR.data.summary as
    | { reconciliation?: { provider_name: string; ending_php: number }[] }
    | null;
  const aging = summaryJson?.reconciliation ?? [];

  // Compute staged_ar per provider.
  const stagedByProvider = new Map<string, { name: string; total: number }>();
  for (const u of updates) {
    if (!u.provider_id_resolved) continue;
    const sr = stagingRows.find((r) => r.id === u.id);
    if (!sr) continue;
    const ent = stagedByProvider.get(u.provider_id_resolved) ?? { name: "", total: 0 };
    // Net unpaid = billed - paid - patient_billed - written_off. For pre-commit
    // staging, paid_amount on the row is the workbook-recorded paid amount;
    // patient_billed and written_off come from later resolution and are zero
    // for fresh imports.
    ent.total += Math.max(0, sr.billed_amount - sr.paid_amount);
    stagedByProvider.set(u.provider_id_resolved, ent);
  }
  // Backfill provider names.
  providersR.data?.forEach((p) => {
    const ent = stagedByProvider.get(p.id);
    if (ent) ent.name = p.name;
  });

  const reconciliation = Array.from(stagedByProvider.entries()).map(([provId, ent]) => {
    const wb = aging.find((a) => a.provider_name.toUpperCase() === ent.name.toUpperCase());
    const wbEnding = wb?.ending_php ?? null;
    const variance_pct = wbEnding ? (ent.total - wbEnding) / wbEnding : null;
    let severity: "green" | "yellow" | "red" | "no_reference" = "no_reference";
    if (variance_pct != null) {
      const abs = Math.abs(variance_pct);
      severity = abs <= 0.01 ? "green" : abs <= 0.05 ? "yellow" : "red";
    }
    return {
      provider_id: provId,
      provider_name: ent.name,
      wb_ending_php: wbEnding,
      staged_ar_php: ent.total,
      variance_pct,
      severity,
    };
  });

  // 5. Update run counts.
  const mergedSummary: Json = {
    ...((summaryJson ?? {}) as Record<string, Json>),
    reconciliation_computed: reconciliation as unknown as Json,
  };
  await supabase
    .from("hmo_import_runs")
    .update({
      error_count: errorCount,
      warning_count: warningCount,
      summary: mergedSummary,
    })
    .eq("id", runId);

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "hmo_history_import.validated",
    resource_type: "hmo_import_runs",
    resource_id: runId,
    metadata: { error_count: errorCount, warning_count: warningCount } as Json,
  });

  return {
    ok: true,
    data: {
      error_count: errorCount,
      warning_count: warningCount,
      unmapped_providers: Array.from(unmappedProviders.entries()).map(([alias, row_count]) => ({
        alias,
        row_count,
      })),
      unmapped_services: Array.from(unmappedServices.entries()).map(([alias, v]) => ({
        alias,
        kind: v.kind,
        row_count: v.row_count,
      })),
      reconciliation,
    },
  };
}

// =============================================================================
// mapProviderAliasAction — upsert hmo_provider_aliases; re-resolve staging
// =============================================================================

export async function mapProviderAliasAction(input: {
  run_id: string;
  alias: string;
  provider_id: string | "create";
}): Promise<ActionResult<{ remaining_unmapped: number }>> {
  const staff = await requireAdminStaff();
  const parsed = mapProviderAliasInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  const supabase = createAdminClient();
  let providerId: string;
  let createdNew = false;

  if (parsed.data.provider_id === "create") {
    const { data, error } = await supabase
      .from("hmo_providers")
      .insert({ name: parsed.data.alias, is_active: true, due_days_for_invoice: 30 })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "create failed" };
    providerId = data.id;
    createdNew = true;
  } else {
    providerId = parsed.data.provider_id;
  }

  const { error: aliasErr } = await supabase.from("hmo_provider_aliases").upsert({
    alias: parsed.data.alias,
    provider_id: providerId,
    created_by: staff.user_id,
  });
  if (aliasErr) return { ok: false, error: aliasErr.message };

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "hmo_provider_alias.mapped",
    resource_type: "hmo_provider_aliases",
    resource_id: providerId,
    metadata: {
      alias: parsed.data.alias,
      provider_id: providerId,
      created_new: createdNew,
      run_id: parsed.data.run_id,
    } as Json,
  });

  // Re-resolve staging rows for this alias.
  await supabase
    .from("hmo_history_staging")
    .update({ provider_id_resolved: providerId })
    .eq("run_id", parsed.data.run_id)
    .eq("provider_name_raw", parsed.data.alias);

  // Re-run validation so visit_group_key and content_hash are recomputed for
  // rows that now have BOTH provider + service resolved. Don't fail the
  // mapping if revalidation hiccups — the alias was already saved.
  const reval = await validateRunAction({ run_id: parsed.data.run_id });
  if (!reval.ok) {
    await supabase
      .from("hmo_import_runs")
      .update({ summary: { revalidation_warning: reval.error } as unknown as Json })
      .eq("id", parsed.data.run_id);
  }

  // Remaining unmapped count.
  const { count } = await supabase
    .from("hmo_history_staging")
    .select("*", { count: "exact", head: true })
    .eq("run_id", parsed.data.run_id)
    .is("provider_id_resolved", null);

  return { ok: true, data: { remaining_unmapped: count ?? 0 } };
}

// =============================================================================
// mapServiceAliasAction — upsert hmo_service_aliases; re-resolve staging
// =============================================================================

export async function mapServiceAliasAction(input: {
  run_id: string;
  alias: string;
  service_kind: "lab_test" | "doctor_consultation";
  service_id: string | "create";
}): Promise<ActionResult<{ remaining_unmapped: number }>> {
  const staff = await requireAdminStaff();
  const parsed = mapServiceAliasInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  const supabase = createAdminClient();
  let serviceId: string;
  let createdNew = false;

  if (parsed.data.service_id === "create") {
    const code = `HIST-${createHash("md5").update(parsed.data.alias).digest("hex").slice(0, 8).toUpperCase()}`;
    const { data, error } = await supabase
      .from("services")
      .insert({
        code,
        name: parsed.data.alias,
        kind: parsed.data.service_kind,
        price_php: 0,
        is_active: true,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? "create failed" };
    serviceId = data.id;
    createdNew = true;
  } else {
    serviceId = parsed.data.service_id;
  }

  const { error: aliasErr } = await supabase.from("hmo_service_aliases").upsert({
    alias: parsed.data.alias,
    service_id: serviceId,
    created_by: staff.user_id,
  });
  if (aliasErr) return { ok: false, error: aliasErr.message };

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "hmo_service_alias.mapped",
    resource_type: "hmo_service_aliases",
    resource_id: serviceId,
    metadata: {
      alias: parsed.data.alias,
      service_id: serviceId,
      kind: parsed.data.service_kind,
      created_new: createdNew,
      run_id: parsed.data.run_id,
    } as Json,
  });

  await supabase
    .from("hmo_history_staging")
    .update({ service_id_resolved: serviceId })
    .eq("run_id", parsed.data.run_id)
    .eq("service_name_raw", parsed.data.alias);

  // Re-run validation so visit_group_key and content_hash are recomputed for
  // rows that now have BOTH provider + service resolved. Don't fail the
  // mapping if revalidation hiccups — the alias was already saved.
  const reval = await validateRunAction({ run_id: parsed.data.run_id });
  if (!reval.ok) {
    await supabase
      .from("hmo_import_runs")
      .update({ summary: { revalidation_warning: reval.error } as unknown as Json })
      .eq("id", parsed.data.run_id);
  }

  const { count } = await supabase
    .from("hmo_history_staging")
    .select("*", { count: "exact", head: true })
    .eq("run_id", parsed.data.run_id)
    .is("service_id_resolved", null);

  return { ok: true, data: { remaining_unmapped: count ?? 0 } };
}

// =============================================================================
// discardRunAction — refuses committed runs; soft-marks staging
// =============================================================================

export async function discardRunAction(input: {
  run_id: string;
}): Promise<ActionResult<{ run_id: string }>> {
  const staff = await requireAdminStaff();
  const parsed = discardRunInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  const supabase = createAdminClient();
  const { data: run } = await supabase
    .from("hmo_import_runs")
    .select("committed_at")
    .eq("id", parsed.data.run_id)
    .single();
  if (run?.committed_at) {
    return { ok: false, error: "cannot discard a committed run; void the JEs instead" };
  }

  await supabase
    .from("hmo_history_staging")
    .update({ status: "discarded" })
    .eq("run_id", parsed.data.run_id);

  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "hmo_history_import.discarded",
    resource_type: "hmo_import_runs",
    resource_id: parsed.data.run_id,
    metadata: {} as Json,
  });

  return { ok: true, data: { run_id: parsed.data.run_id } };
}

// =============================================================================
// commitRunAction — calls the commit_hmo_history_run SQL function (D4).
// =============================================================================

export async function commitRunAction(input: {
  run_id: string;
  variance_override_reason?: string;
  pii_ack: boolean;
}): Promise<
  ActionResult<{
    run_id: string;
    summary: Record<string, number>;
  }>
> {
  const staff = await requireAdminStaff();

  const parsed = commitRunInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.message };

  const supabase = createAdminClient();

  // Persist the variance override reason (if the admin filled one in) before
  // we kick off the SQL function. Audit logging captures the override too.
  if (parsed.data.variance_override_reason) {
    const { error: ovrErr } = await supabase
      .from("hmo_import_runs")
      .update({ variance_override_reason: parsed.data.variance_override_reason })
      .eq("id", parsed.data.run_id);
    if (ovrErr) return { ok: false, error: ovrErr.message };
  }

  // Flip the run from 'dry_run' to 'commit' so the audit trail makes sense
  // even if the SQL function later raises.
  const { error: kindErr } = await supabase
    .from("hmo_import_runs")
    .update({ run_kind: "commit" })
    .eq("id", parsed.data.run_id);
  if (kindErr) return { ok: false, error: kindErr.message };

  const { data, error } = await supabase.rpc("commit_hmo_history_run", {
    p_run_id: parsed.data.run_id,
  });
  if (error) {
    // Best-effort rollback so the runs list doesn't show a 'commit' kind for a run that never committed.
    await supabase
      .from("hmo_import_runs")
      .update({ run_kind: "dry_run" })
      .eq("id", parsed.data.run_id);
    return { ok: false, error: translatePgError(error) };
  }

  // Best-effort audit at the Server Action level (the SQL function also writes
  // one inside the same transaction; this one captures the override reason and
  // the actor's session context that the function doesn't have access to).
  await audit({
    actor_id: staff.user_id,
    actor_type: "staff",
    action: "hmo_history_import.commit_requested",
    resource_type: "hmo_import_runs",
    resource_id: parsed.data.run_id,
    metadata: {
      variance_override_reason: parsed.data.variance_override_reason ?? null,
      summary: data as Json,
    } as Json,
  });

  return {
    ok: true,
    data: {
      run_id: parsed.data.run_id,
      summary: (data ?? {}) as Record<string, number>,
    },
  };
}
