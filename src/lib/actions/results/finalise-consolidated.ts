"use server";

import { headers } from "next/headers";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { renderResultPdf } from "@/lib/results/render-pdf";
import {
  isTemplateParamsLoadError,
  loadResultDocumentInput,
  loadTemplateParams,
  TEMPLATE_PARAMS_LOAD_FAILED,
} from "@/lib/results/loaders";
import { deriveEnabledParamIds } from "@/lib/results/enabled-params";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { scopeToAllowedSections } from "@/lib/visits/bulk-selection";
import { assertVisitPatientActive } from "@/lib/patients/require-active";
import { calculateAgeMonths, normalisePatientSex } from "@/lib/results/types";
import {
  buildValueRows,
  detectCrossings,
  mergeValueRows,
  valueRowsToDocValues,
  type ValueRow,
} from "@/lib/results/value-rows";
import { commitResultFinalise } from "@/lib/actions/results/result-edit-core";
import { releaseVisitSelection } from "@/lib/actions/visits/release-reports";
import {
  classifyFinaliseRelease,
  type FinaliseDeferral,
} from "@/lib/actions/results/finalise-release-outcome";

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
        deferredReason: FinaliseDeferral | null;
        /** Shown to the medtech: an "other" deferral's reason, or why a released report's patient wasn't notified. */
        releaseNote: string | null;
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

  // 0167: no finalise-and-release on an inactive record.
  const active = await assertVisitPatientActive(admin, input.visitId);
  if (!active.ok) return { ok: false, error: active.error };

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
  let templateParams: Awaited<ReturnType<typeof loadTemplateParams>>;
  try {
    templateParams = await loadTemplateParams(admin, template.id, { strict: true });
  } catch (e) {
    if (isTemplateParamsLoadError(e)) return { ok: false, error: TEMPLATE_PARAMS_LOAD_FAILED };
    throw e;
  }
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
    // Fresh finalise: insert the results row. `finalised_at` stays NULL
    // here (N5/M13 fix) — the advance_test_on_rtr_insert trigger reads
    // results.finalised_at at the moment the junction rows below are
    // inserted, and (for a 'structured' result) only flips
    // test_requests.status when it's already non-null. Setting it now
    // would advance ordinary chemistry tests to ready_for_release before
    // the PDF has even been rendered, let alone uploaded — exactly the
    // gap that left a medtech unable to recover from an upload failure
    // (the consolidated entry page's ACTIVE_STATUSES excludes
    // ready_for_release) and left the visit page willing to release a
    // fileless test. finalised_at is written for real in step 8, in the
    // SAME update as storage_path — only once the PDF is safely stored —
    // which is also when the flip is meant to happen.
    const { data: resultsRow, error: rErr } = await admin
      .from("results")
      .insert({
        report_group_id: input.groupId,
        finalised_by_staff_id: session.user_id,
        generation_kind: "structured",
        finalised_at: null,
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
  // 5) Values, flags and crossings — computed here, written below in ONE
  // transaction with the PDF pointer (0172 result_finalise_commit). Flags use
  // the same pickRangeForPatient + computeFlag pair as the single-test path.
  //
  // The written set is COMPLETE: values outside this call's enabled scope
  // (none in practice — a resume covers exactly the original services, see
  // isCleanResumableState) are kept, every in-scope value is replaced by what
  // the form sent. The form omits empty fields, so a value the medtech
  // CLEARED before retrying disappears (and so does its critical alert)
  // rather than surviving on the database and the PDF.
  // ---------------------------------------------------------------------
  const finalisedNow = new Date();
  const patientForRanges = {
    sex: patientSex,
    ageMonths: calculateAgeMonths(patientRaw.birthdate ?? null, finalisedNow),
  };
  const newRows = buildValueRows(
    Object.fromEntries(
      input.values.map((v) => [
        v.parameter_id,
        {
          numeric_value_si: v.numeric_value_si,
          numeric_value_conv: v.numeric_value_conv,
          text_value: null,
          select_value: null,
          is_blank: false,
        },
      ]),
    ),
    paramsById,
    patientForRanges,
  );
  const { data: storedRows, error: storedErr } = await admin
    .from("result_values")
    .select("parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, flag, is_blank")
    .eq("result_id", resultId);
  if (storedErr) return { ok: false, error: translatePgError(storedErr) };
  const keptRows: ValueRow[] = (storedRows ?? [])
    .filter((r) => !enabledParamIds.has(r.parameter_id))
    .map((r) => ({ ...r, flag: r.flag as ValueRow["flag"] }));
  const completeRows = mergeValueRows(keptRows, newRows);

  // Each crossing is filed under the member whose service enables the
  // parameter (report_group_service_params), so the alert carries a real
  // test_request_id.
  const serviceIdToTestRequestId = new Map(
    claimRows.map((r) => [flatService(r.services)?.id ?? "", r.id]),
  );
  const paramIdToTestRequestId = new Map<string, string>();
  for (const m of mapRows ?? []) {
    const trId = serviceIdToTestRequestId.get(m.service_id);
    if (trId) paramIdToTestRequestId.set(m.parameter_id, trId);
  }
  const alerts = detectCrossings(
    newRows,
    paramsById,
    patientForRanges,
    (paramId) => paramIdToTestRequestId.get(paramId) ?? null,
  );

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");

  // ---------------------------------------------------------------------
  // 6) Render the PDF from the values about to be written, then commit
  // values + PDF pointer + finalised_at + alerts in one transaction. Writing
  // finalised_at fires advance_test_on_result_upload INSIDE that
  // transaction, so every linked test flips to result_uploaded /
  // ready_for_release together with the PDF or not at all — no test can be
  // advanced (or released, step 9) without a downloadable PDF. The upload
  // goes to a path unique to this attempt (result-edit-core), so a retry
  // never overwrites the object a committed row points at, and a failed
  // attempt leaves every test at in_progress: the medtech reopens the page
  // and step 4 resumes from this no-PDF result row. A second finalise of an
  // already-finalised result is refused inside the lock (P0066).
  // ---------------------------------------------------------------------
  const docInput = await loadResultDocumentInput(resultId, {
    finalisedAtOverride: finalisedNow,
    valuesOverride: valueRowsToDocValues(completeRows),
  });
  const pdfBuf = await renderResultPdf(docInput);
  const committed = await commitResultFinalise({
    resultId,
    finaliserId: session.user_id,
    base: resultId,
    pdf: pdfBuf,
    finalisedAt: finalisedNow,
    values: completeRows,
    image: null,
    alerts,
  });
  if (!committed.ok) return { ok: false, error: committed.error };

  if (committed.data.alertsAdded.length > 0) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: patientRaw.id,
      action: "result.critical_value_detected",
      resource_type: "result",
      resource_id: resultId,
      metadata: {
        test_request_ids: input.testRequestIds,
        alerts: committed.data.alertsAdded.map((a) => ({
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

  // ---------------------------------------------------------------------
  // 9) Release the report — WHOLE or not at all — through the same path as
  // the lab queue and the visit page (releaseVisitSelection, #261).
  //
  // Every member of this report is in input.testRequestIds (step 1 + the
  // resume check), so the planner sees the whole report. A member whose
  // service needs pathologist sign-off was left at 'result_uploaded' by the
  // step-8 trigger; the planner then refuses the report as unfinished and
  // NOTHING is released — never the ready members alone, which used to leave
  // the patient with a report the portal would not open (it serves the PDF
  // only once every member is released). The sign-off, then a release from
  // the queue, finishes it later.
  //
  // The payment gate (enforce_payment_before_release, 0133) and the consent
  // gate (ships OFF) still fire on the write and come back as a deferral:
  // the result stays finalised and is released once they're settled.
  //
  // releaseVisitSelection also sends the patient's "result ready" notice and
  // reception's alert — only for a report verified fully released after the
  // write — and audits each released line. There is no release-medium picker
  // on this form, so "other" is used (markDoctorLineDoneAction's convention
  // for non-interactive releases).
  // ---------------------------------------------------------------------
  const releaseOut = await releaseVisitSelection({
    supabase: admin,
    session,
    visitId: input.visitId,
    selectedIds: input.testRequestIds,
    medium: "other",
    auditMeta: { source: "finalise_consolidated", result_id: resultId },
  });
  const { releaseDeferred, deferredReason, releaseNote } = classifyFinaliseRelease(
    releaseOut,
    input.testRequestIds,
  );
  const releasedIds = [...releaseOut.changedIds, ...releaseOut.alsoReleasedIds];

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
      storage_path: committed.data.storagePath,
      release_deferred: releaseDeferred,
      deferred_reason: deferredReason,
      release_note: releaseNote,
    },
    ip_address: ip,
    user_agent: ua,
  });
  if (releasedIds.length > 0) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "result.released",
      resource_type: "result",
      resource_id: resultId,
      metadata: {
        test_request_ids: releasedIds,
        report_group_id: input.groupId,
        visit_id: input.visitId,
        release_medium: "other",
        patient_notified: releaseOut.announced.length > 0,
      },
      ip_address: ip,
      user_agent: ua,
    });
  }

  return {
    ok: true,
    data: { result_id: resultId, releaseDeferred, deferredReason, releaseNote },
  };
}
