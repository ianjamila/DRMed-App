"use server";

import { headers } from "next/headers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { renderResultPdf } from "@/lib/results/render-pdf";
import { loadResultDocumentInput } from "@/lib/results/loaders";
import { deriveEnabledParamIds } from "@/lib/results/enabled-params";

export interface FinaliseInput {
  visitId: string;
  groupId: string;
  testRequestIds: string[];
  values: Array<{
    parameter_id: string;
    numeric_value_si: number | null;
    numeric_value_conv: number | null;
  }>;
}

export type FinaliseResult =
  | {
      ok: true;
      data: {
        result_id: string;
        releaseDeferred: boolean;
        deferredReason: "payment" | "consent" | null;
      };
    }
  | { ok: false; error: string };

export async function finaliseConsolidatedReport(
  input: FinaliseInput,
): Promise<FinaliseResult> {
  const session = await requireActiveStaff();
  const admin = createAdminClient();

  // Ownership check: only the medtech who claimed this report may finalise
  // it (mirrors prepareStructured's check). Admins get no bypass — same as
  // the single-test flow; an admin who needs to take over uses reassign.
  const { data: claimRows } = await admin
    .from("test_requests")
    .select("id, assigned_to, services!inner(id)")
    .in("id", input.testRequestIds);
  if (
    (claimRows ?? []).length !== input.testRequestIds.length ||
    (claimRows ?? []).some((r) => r.assigned_to !== session.user_id)
  ) {
    return { ok: false, error: "You haven't claimed this report." };
  }

  // Server-side re-validation of enablement. The client only submits values
  // for fields it currently sees as enabled, but "enabled" is now a DB
  // mapping (report_group_service_params, migration 0120) instead of a
  // compile-time constant — an admin can edit the group mapping while a
  // medtech has the form open. Recompute the enabled set from the DB right
  // before persisting; if any submitted value falls outside it, refuse the
  // write rather than silently dropping it (the medtech would otherwise
  // believe an entered value was saved when it never was).
  if (input.values.length > 0) {
    const orderedServiceIds = (claimRows ?? []).map((r) => {
      const svc = Array.isArray(r.services) ? r.services[0] : r.services;
      return svc?.id ?? "";
    });
    const { data: template } = await admin
      .from("result_templates")
      .select("id, result_template_params(id)")
      .eq("report_group_id", input.groupId)
      .eq("is_active", true)
      .single();
    const templateParamIds = (template?.result_template_params ?? []).map(
      (p: { id: string }) => p.id,
    );
    const { data: mapRows } =
      templateParamIds.length > 0
        ? await admin
            .from("report_group_service_params")
            .select("service_id, parameter_id")
            .in("parameter_id", templateParamIds)
        : { data: [] };
    const enabledParamIds = deriveEnabledParamIds(
      mapRows ?? [],
      orderedServiceIds,
    );
    const hasStaleValue = input.values.some(
      (v) => !enabledParamIds.has(v.parameter_id),
    );
    if (hasStaleValue) {
      return {
        ok: false,
        error:
          "The enabled fields for this report changed since the form was opened. Reload the page and review your entries before finalising.",
      };
    }
  }

  // Idempotency guard: if any of these test_requests are already linked to a
  // result, a fresh consolidated finalise will trip
  // uq_result_test_requests_test_request on the junction insert and leave an
  // orphan `results` row behind. Surface a clearer message and bail before
  // inserting anything.
  const { data: alreadyLinked } = await admin
    .from("result_test_requests")
    .select("test_request_id")
    .in("test_request_id", input.testRequestIds);
  if (alreadyLinked && alreadyLinked.length > 0) {
    return {
      ok: false,
      error:
        "These tests already have a result on file. Refresh to see current state — release happens from the visit page once payment is recorded.",
    };
  }

  // 1) Insert results row (structured + group-keyed). control_no defaults
  // are set by an existing sequence trigger (Phase 13). We insert with
  // finalised_at set so the advance_test_on_result_upload trigger fires
  // immediately on insert and flips test_requests.status from in_progress.
  const nowIso = new Date().toISOString();
  const { data: resultsRow, error: rErr } = await admin
    .from("results")
    .insert({
      report_group_id: input.groupId,
      finalised_by_staff_id: session.user_id,
      generation_kind: "structured",
      finalised_at: nowIso,
      uploaded_by: session.user_id,
      storage_path: null,
    })
    .select("id, control_no")
    .single();
  if (rErr || !resultsRow) {
    return {
      ok: false,
      error: translatePgError(
        rErr ?? { message: "insert results returned no row" },
      ),
    };
  }

  // 2) Junction rows — link every ordered test_request to this result.
  const { error: jErr } = await admin
    .from("result_test_requests")
    .insert(
      input.testRequestIds.map((trid) => ({
        result_id: resultsRow.id,
        test_request_id: trid,
      })),
    );
  if (jErr) return { ok: false, error: translatePgError(jErr) };

  // 3) Result values (only filled ones).
  if (input.values.length > 0) {
    const { error: vErr } = await admin.from("result_values").insert(
      input.values.map((v) => ({
        result_id: resultsRow.id,
        parameter_id: v.parameter_id,
        numeric_value_si: v.numeric_value_si,
        numeric_value_conv: v.numeric_value_conv,
        is_blank: false,
      })),
    );
    if (vErr) return { ok: false, error: translatePgError(vErr) };
  }

  // 4) Release every linked test_request. The payment-gating trigger fires
  // here and will block the transition to 'released' if visits.payment_status
  // is not 'paid' (or 'waived'). That block is a legitimate state — the
  // result is still finalised and the 0059 junction-insert trigger has
  // already advanced status to ready_for_release; reception will release
  // from the visit page once payment is recorded. Treat the gate as a soft
  // outcome (releaseDeferred) rather than a hard failure so the medtech's
  // work isn't wasted and a retry doesn't produce orphan result rows.
  const { error: relErr } = await admin
    .from("test_requests")
    .update({ status: "released" })
    .in("id", input.testRequestIds);
  let releaseDeferred = false;
  let deferredReason: "payment" | "consent" | null = null;
  if (relErr) {
    const code = (relErr as { code?: string }).code;
    const msg = relErr.message ?? "";
    if (code === "23514" && /payment_status/i.test(msg)) {
      releaseDeferred = true;
      deferredReason = "payment";
    } else if (code === "23514" && /consent/i.test(msg)) {
      releaseDeferred = true;
      deferredReason = "consent";
    } else {
      return { ok: false, error: translatePgError(relErr) };
    }
  }

  // 5) Render the consolidated PDF and upload to the results bucket.
  const docInput = await loadResultDocumentInput(resultsRow.id);
  const pdfBuf = await renderResultPdf(docInput);
  const pdfPath = `${resultsRow.id}.pdf`;
  const { error: upErr } = await admin.storage
    .from("results")
    .upload(pdfPath, pdfBuf, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (upErr) return { ok: false, error: translatePgError(upErr) };

  // 6) Stamp storage_path + file_size_bytes on the results row.
  await admin
    .from("results")
    .update({ storage_path: pdfPath, file_size_bytes: pdfBuf.byteLength })
    .eq("id", resultsRow.id);

  // 7) Audit.
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.finalised",
    resource_type: "result",
    resource_id: resultsRow.id,
    metadata: {
      test_request_ids: input.testRequestIds,
      report_group_id: input.groupId,
      visit_id: input.visitId,
      pdf_size_bytes: pdfBuf.byteLength,
      release_deferred: releaseDeferred,
      deferred_reason: deferredReason,
    },
    ip_address: ip,
    user_agent: ua,
  });
  if (!releaseDeferred) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "result.released",
      resource_type: "result",
      resource_id: resultsRow.id,
      metadata: {
        test_request_ids: input.testRequestIds,
        report_group_id: input.groupId,
        visit_id: input.visitId,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  return {
    ok: true,
    data: { result_id: resultsRow.id, releaseDeferred, deferredReason },
  };
}
