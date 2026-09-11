"use server";

import { headers } from "next/headers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { renderResultPdf } from "@/lib/results/render-pdf";
import { loadResultDocumentInput, loadTemplateParams } from "@/lib/results/loaders";
import { deriveEnabledParamIds } from "@/lib/results/enabled-params";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";
import {
  calculateAgeMonths,
  computeFlag,
  detectCritical,
  normalisePatientSex,
  pickRangeForPatient,
} from "@/lib/results/types";

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
        deferredReason: "payment" | "consent" | "signoff" | null;
      };
    }
  | { ok: false; error: string };

export async function finaliseConsolidatedReport(
  input: FinaliseInput,
): Promise<FinaliseResult> {
  const session = await requireActiveStaff();
  const admin = createAdminClient();

  if (input.testRequestIds.length === 0) {
    return { ok: false, error: "No tests selected." };
  }

  // ---------------------------------------------------------------------
  // 1) Re-derive the test requests server-side (N2). The client only sends
  // ids — never trust them at face value. Every id must:
  //   - exist, not be soft-deleted, and belong to a non-deleted visit
  //   - belong to the STATED visit (input.visitId), and therefore one
  //     patient — this is what stops a crafted payload from merging two
  //     different patients' chemistry into one shared PDF
  //   - belong to the stated report group
  //   - be claimed by this medtech
  // ---------------------------------------------------------------------
  const { data: claimRowsRaw } = await admin
    .from("test_requests")
    .select(
      "id, assigned_to, visit_id, services!inner(id, section, name, report_group_id), visits!inner(id, deleted_at)",
    )
    .in("id", input.testRequestIds)
    .is("deleted_at", null)
    .is("visits.deleted_at", null);

  const claimRows = claimRowsRaw ?? [];
  if (claimRows.length !== input.testRequestIds.length) {
    return {
      ok: false,
      error: "Some tests in this report were not found or were deleted.",
    };
  }
  if (claimRows.some((r) => r.visit_id !== input.visitId)) {
    return {
      ok: false,
      error: "These tests don't all belong to the stated visit.",
    };
  }
  const flatService = (
    svc: { id: string; section: string | null; name: string; report_group_id: string | null } | { id: string; section: string | null; name: string; report_group_id: string | null }[] | null,
  ) => (Array.isArray(svc) ? (svc[0] ?? null) : svc);
  if (
    claimRows.some((r) => flatService(r.services)?.report_group_id !== input.groupId)
  ) {
    return {
      ok: false,
      error: "These tests don't all belong to this report group.",
    };
  }
  // Ownership check: only the medtech who claimed this report may finalise
  // it (mirrors prepareStructured's check). Admins get no bypass — same as
  // the single-test flow; an admin who needs to take over uses reassign.
  if (claimRows.some((r) => r.assigned_to !== session.user_id)) {
    return { ok: false, error: "You haven't claimed this report." };
  }
  // Lab-section authorisation. This action doesn't just finalise — it also
  // performs the release (step 8 below), so it must pass the same
  // section gate releaseTestAction applies before flipping status to
  // 'released'. sectionsForRole(role) === [] is a DENY, never "no filter".
  const allowedSections = sectionsForRole(session.role);
  const sectionScoped = scopeToAllowedSections(
    claimRows.map((r) => ({ id: r.id, services: r.services })),
    allowedSections,
  );
  if (sectionScoped.length !== claimRows.length) {
    return {
      ok: false,
      error: "This report is outside the sections you can release.",
    };
  }

  // ---------------------------------------------------------------------
  // 2) Server-side re-validation of enablement + load full template params
  // (with age-band ranges) up front — needed both for the stale-value check
  // below and for flag / critical-value computation later (N3). "Enabled"
  // is a DB mapping (report_group_service_params, migration 0120) instead
  // of a compile-time constant — an admin can edit the group mapping while
  // a medtech has the form open. Recompute the enabled set from the DB
  // right before persisting; if any submitted value falls outside it,
  // refuse the write rather than silently dropping it.
  // ---------------------------------------------------------------------
  const { data: template } = await admin
    .from("result_templates")
    .select("id")
    .eq("report_group_id", input.groupId)
    .eq("is_active", true)
    .maybeSingle();
  if (!template) {
    return {
      ok: false,
      error: "No active template is configured for this report group.",
    };
  }
  const templateParams = await loadTemplateParams(admin, template.id);
  const paramsById = new Map(templateParams.map((p) => [p.id, p]));
  const templateParamIds = templateParams.map((p) => p.id);

  const orderedServiceIds = claimRows.map((r) => flatService(r.services)?.id ?? "");
  const { data: mapRows } =
    templateParamIds.length > 0
      ? await admin
          .from("report_group_service_params")
          .select("service_id, parameter_id")
          .in("parameter_id", templateParamIds)
      : { data: [] };
  const enabledParamIds = deriveEnabledParamIds(mapRows ?? [], orderedServiceIds);

  if (input.values.length > 0) {
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

  // ---------------------------------------------------------------------
  // 3) Load the patient for flag / critical-value computation (N3). Every
  // test in this report shares one visit → one patient (enforced above).
  // ---------------------------------------------------------------------
  const { data: visitRow } = await admin
    .from("visits")
    .select("id, patients!inner(id, drm_id, sex, birthdate)")
    .eq("id", input.visitId)
    .maybeSingle();
  const patientRaw = visitRow
    ? Array.isArray(visitRow.patients)
      ? visitRow.patients[0]
      : visitRow.patients
    : null;
  if (!patientRaw) {
    return { ok: false, error: "Visit or patient not found." };
  }
  const patientSex = normalisePatientSex(patientRaw.sex ?? null);
  const patientAgeMonths = calculateAgeMonths(patientRaw.birthdate ?? null);

  // ---------------------------------------------------------------------
  // 4) Idempotency / retry resolution (N5). If any of these test_requests
  // are already linked to a result, this may be:
  //   (a) a genuinely finished result (has a stored PDF) — refuse, as
  //       before, to avoid clobbering a released report.
  //   (b) a PREVIOUS attempt that got as far as inserting the results row
  //       (+ junction, maybe values) but crashed before the PDF was
  //       rendered/uploaded — resume from that row instead of erroring,
  //       so the medtech can always retry after a transient failure.
  // Anything else (a partial/mismatched set of links) is refused rather
  // than silently patched.
  // ---------------------------------------------------------------------
  const { data: alreadyLinked } = await admin
    .from("result_test_requests")
    .select("test_request_id, result_id, results!inner(id, storage_path)")
    .in("test_request_id", input.testRequestIds);

  let resultId: string;

  if (alreadyLinked && alreadyLinked.length > 0) {
    const resultIds = new Set(alreadyLinked.map((l) => l.result_id));
    const linkedResult = (() => {
      const r = alreadyLinked[0]?.results;
      return Array.isArray(r) ? r[0] : r;
    })();
    // Confirm the existing result's FULL membership (not just the rows that
    // happen to intersect input.testRequestIds) matches this call's set
    // exactly — otherwise a retry with a different id list than the
    // original attempt (e.g. a test cancelled in between) could silently
    // resume onto the wrong report.
    const singleResultId = resultIds.size === 1 ? [...resultIds][0] : null;
    const { count: fullLinkCount } = singleResultId
      ? await admin
          .from("result_test_requests")
          .select("test_request_id", { count: "exact", head: true })
          .eq("result_id", singleResultId)
      : { count: null };
    const isCleanResumableState =
      resultIds.size === 1 &&
      alreadyLinked.length === input.testRequestIds.length &&
      fullLinkCount === input.testRequestIds.length &&
      linkedResult != null;

    if (!isCleanResumableState) {
      return {
        ok: false,
        error:
          "These tests already have a result on file. Refresh to see current state — release happens from the visit page once payment is recorded.",
      };
    }
    if (linkedResult!.storage_path) {
      // A complete prior result already exists (has a PDF) — refuse.
      return {
        ok: false,
        error:
          "These tests already have a result on file. Refresh to see current state — release happens from the visit page once payment is recorded.",
      };
    }
    // No stored PDF: a prior attempt stalled before the PDF step. Resume —
    // do NOT insert a new results/junction row (that would violate
    // uq_result_test_requests_test_request); re-upsert values below in
    // case the failed attempt never got that far, then continue on to
    // render + upload + release.
    resultId = linkedResult!.id;
  } else {
    // Fresh finalise: insert the results row (finalised_at set so the
    // advance_test_on_result_upload trigger fires on the junction insert
    // below and flips test_requests.status from in_progress), then the
    // junction rows.
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
      .select("id")
      .single();
    if (rErr || !resultsRow) {
      return {
        ok: false,
        error: translatePgError(
          rErr ?? { message: "insert results returned no row" },
        ),
      };
    }
    resultId = resultsRow.id;

    const { error: jErr } = await admin.from("result_test_requests").insert(
      input.testRequestIds.map((trid) => ({
        result_id: resultId,
        test_request_id: trid,
      })),
    );
    if (jErr) return { ok: false, error: translatePgError(jErr) };
  }

  // ---------------------------------------------------------------------
  // 5) Result values, WITH flag computed (N3). Uses the exact same
  // pickRangeForPatient + computeFlag pair the single-test path uses
  // (src/lib/results/types.ts), so the two can never drift. `upsert`
  // (not `insert`) so a retry safely overwrites whatever a stalled prior
  // attempt already wrote.
  // ---------------------------------------------------------------------
  if (input.values.length > 0) {
    const valueRows = input.values.map((v) => {
      const param = paramsById.get(v.parameter_id);
      const flag = param
        ? computeFlag(param, pickRangeForPatient(param, patientSex, patientAgeMonths), {
            numeric_value_si: v.numeric_value_si,
            numeric_value_conv: v.numeric_value_conv,
            select_value: null,
            is_blank: false,
          })
        : null;
      return {
        result_id: resultId,
        parameter_id: v.parameter_id,
        numeric_value_si: v.numeric_value_si,
        numeric_value_conv: v.numeric_value_conv,
        is_blank: false,
        flag,
      };
    });
    const { error: vErr } = await admin
      .from("result_values")
      .upsert(valueRows, { onConflict: "result_id,parameter_id" });
    if (vErr) return { ok: false, error: translatePgError(vErr) };
  }

  // ---------------------------------------------------------------------
  // 6) Critical-value detection (N3), mirroring the single-test path's
  // step 11. Map each parameter back to a test_request in this report (via
  // report_group_service_params) so the alert carries a real
  // test_request_id. Delete any alerts a stalled prior attempt already
  // inserted for this result first, so a retry can't page pathologist/
  // admin twice for the same value.
  // ---------------------------------------------------------------------
  const serviceIdToTestRequestId = new Map(
    claimRows.map((r) => [flatService(r.services)?.id ?? "", r.id]),
  );
  const paramIdToTestRequestId = new Map<string, string>();
  for (const m of mapRows ?? []) {
    const trId = serviceIdToTestRequestId.get(m.service_id);
    if (trId) paramIdToTestRequestId.set(m.parameter_id, trId);
  }

  const alerts: Array<{
    result_id: string;
    test_request_id: string;
    parameter_id: string;
    parameter_name: string;
    direction: "low" | "high";
    observed_value_si: number;
    threshold_si: number;
    patient_id: string;
    patient_drm_id: string;
  }> = [];
  for (const v of input.values) {
    const param = paramsById.get(v.parameter_id);
    const testRequestId = paramIdToTestRequestId.get(v.parameter_id);
    if (!param || !testRequestId) continue;
    const range = pickRangeForPatient(param, patientSex, patientAgeMonths);
    const hit = detectCritical(param, range, {
      numeric_value_si: v.numeric_value_si,
      numeric_value_conv: v.numeric_value_conv,
      is_blank: false,
    });
    if (hit) {
      alerts.push({
        result_id: resultId,
        test_request_id: testRequestId,
        parameter_id: param.id,
        parameter_name: param.parameter_name,
        direction: hit.direction,
        observed_value_si: hit.observed_si,
        threshold_si: hit.threshold_si,
        patient_id: patientRaw.id,
        patient_drm_id: patientRaw.drm_id,
      });
    }
  }
  await admin.from("critical_alerts").delete().eq("result_id", resultId);
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  if (alerts.length > 0) {
    const { error: alertErr } = await admin.from("critical_alerts").insert(alerts);
    if (alertErr) {
      // Don't fail the finalise — the result row is already committed.
      // Surface in the audit log so the gap is investigatable.
      console.error("critical_alerts insert failed", alertErr);
    } else {
      await audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: patientRaw.id,
        action: "result.critical_value_detected",
        resource_type: "result",
        resource_id: resultId,
        metadata: {
          test_request_ids: input.testRequestIds,
          alerts: alerts.map((a) => ({
            parameter: a.parameter_name,
            direction: a.direction,
            observed: a.observed_value_si,
            threshold: a.threshold_si,
          })),
        },
        ip_address: ip,
        user_agent: ua,
      });
    }
  }

  // ---------------------------------------------------------------------
  // 7) Render the consolidated PDF and upload it BEFORE any release write
  // (N5). This is the crux of the fix: nothing below this point can leave
  // a test released without a downloadable PDF, because release (step 8)
  // only runs after the upload has already succeeded. If either fails,
  // the linked test_requests are left at whatever status the trigger gave
  // them in step 4 (in_progress → result_uploaded/ready_for_release) —
  // never 'released' — and the idempotency check in step 4 lets the
  // medtech retry (it resumes from the existing no-PDF result row rather
  // than refusing).
  // ---------------------------------------------------------------------
  const docInput = await loadResultDocumentInput(resultId);
  const pdfBuf = await renderResultPdf(docInput);
  const pdfPath = `${resultId}.pdf`;
  const { error: upErr } = await admin.storage
    .from("results")
    .upload(pdfPath, pdfBuf, { contentType: "application/pdf", upsert: true });
  if (upErr) return { ok: false, error: translatePgError(upErr) };

  // 8) Stamp storage_path + file_size_bytes now that the PDF is safely
  // uploaded.
  await admin
    .from("results")
    .update({ storage_path: pdfPath, file_size_bytes: pdfBuf.byteLength })
    .eq("id", resultId);

  // ---------------------------------------------------------------------
  // 9) Release every linked test_request that is ready to (N4 + M13).
  //
  // The status filter (`.eq("status", "ready_for_release")`) is the M13
  // guard: a test whose service requires pathologist sign-off was left at
  // 'result_uploaded' by the trigger in step 4 (never 'ready_for_release')
  // and is therefore excluded from this UPDATE's WHERE clause entirely —
  // it can never be force-released from here. The shared consolidated PDF
  // stays withheld from the portal until every linked test reaches
  // 'released' (see N6 in the portal actions).
  //
  // The payment-gating trigger (enforce_payment_before_release) fires on
  // the rows that DO match and will block the whole statement if
  // visits.payment_status/hmo_provider_id isn't settled (0133) — since
  // every row here shares one visit, that's a uniform "this visit's money
  // isn't settled yet" outcome. Same for the consent gate (ships OFF).
  // Treat both as soft outcomes (releaseDeferred) rather than hard
  // failures: the result is still finalised and reception can release
  // later from the visit page.
  //
  // Release metadata (released_at / released_by / release_medium) mirrors
  // exactly what releaseTestAction / markDoctorLineDoneAction write for
  // the single-test path (N4) — without it these tests would vanish from
  // "Released today", dated reports, and HMO movement. There is no
  // release-medium picker on this form, so "other" is used, matching the
  // convention markDoctorLineDoneAction already established for
  // non-interactive releases.
  // ---------------------------------------------------------------------
  const releaseNow = new Date().toISOString();
  const { data: releasedRows, error: relErr } = await admin
    .from("test_requests")
    .update({
      status: "released",
      released_at: releaseNow,
      released_by: session.user_id,
      release_medium: "other",
    })
    .in("id", input.testRequestIds)
    .eq("status", "ready_for_release")
    .select("id");

  let releaseDeferred = false;
  let deferredReason: "payment" | "consent" | "signoff" | null = null;
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
  } else if ((releasedRows ?? []).length < input.testRequestIds.length) {
    // No error, but not every id matched the status filter — the ids that
    // didn't were left at 'result_uploaded' by the sign-off gate in step 4
    // (a payment/consent failure would have raised for the whole
    // statement above, since every row shares one visit).
    releaseDeferred = true;
    deferredReason = "signoff";
  }

  // 10) Audit.
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.finalised",
    resource_type: "result",
    resource_id: resultId,
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
  if ((releasedRows ?? []).length > 0) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "result.released",
      resource_type: "result",
      resource_id: resultId,
      metadata: {
        test_request_ids: (releasedRows ?? []).map((r) => r.id),
        report_group_id: input.groupId,
        visit_id: input.visitId,
        release_medium: "other",
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  return {
    ok: true,
    data: { result_id: resultId, releaseDeferred, deferredReason },
  };
}
