"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { isSectionAllowed } from "@/lib/auth/section-access";
import { renderResultPdf } from "@/lib/results/render-pdf";
import { loadConsultantSignatures, resolvePerformer } from "@/lib/results/signatures";
import {
  calculateAgeMonths,
  filterParamsForPatient,
  normalisePatientSex,
  type PatientSex,
  type ResultDocumentInput,
  type ResultLayout,
  type TemplateParam,
} from "@/lib/results/types";
import { membersWithinSections, resultMemberSections } from "@/lib/results/report-section-gate";
import {
  isTemplateParamsLoadError,
  loadTemplateParams,
  TEMPLATE_PARAMS_LOAD_FAILED,
} from "@/lib/results/loaders";
import {
  buildValueRows,
  detectCrossings,
  mergeValueRows,
  missingParams,
  missingParamsError,
  valueRowsToDocValues,
  type ValueRow,
} from "@/lib/results/value-rows";
import { countValueChanges, isEditableStatus, validateEditReason } from "@/lib/results/result-edit";
import {
  auditAlertChanges,
  commitResultEdit,
  commitResultFinalise,
} from "@/lib/actions/results/result-edit-core";
import { translatePgError } from "@/lib/accounting/pg-errors";
import type { Json } from "@/types/database";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// Imaging-report attachments (ECG / X-ray / Ultrasound). Kept in sync with
// the bucket allowlist in migration 0038 and the UI's accept= attribute.
// HEIC/HEIF intentionally omitted — @react-pdf/renderer can't embed them
// natively, and avoiding a server-side conversion step keeps the surface
// minimal.
const IMAGING_ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const IMAGING_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// N1 (go-live): shared denial message for every mutating action on this
// route once it's section-gated (see role-sections.ts / section-access.ts).
// Wording matches the existing section gate in queue/actions.ts's
// claimTestAction ("outside the sections you can claim") rather than
// disguising the reason as a 404 — that disguise belongs to the page
// (queue/[id]/page.tsx uses notFound()), not to a Server Action a caller
// only reaches by already having a form open.
const SECTION_DENIED_ERROR = "This test is outside the sections you can access.";

function fileExtForMime(mime: string): string {
  return (
    {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "application/pdf": "pdf",
    }[mime] ?? "bin"
  );
}

export type UploadResult = { ok: true } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Structured-result actions (Phase 13 Slice 2)
// ---------------------------------------------------------------------------

// Wire-format value sent from the client form. The client never sends `flag`
// — that's computed by the DB trigger from the value vs. ref ranges.
export interface StructuredValueInput {
  numeric_value_si: number | null;
  numeric_value_conv: number | null;
  text_value: string | null;
  select_value: string | null;
  is_blank: boolean;
}

export interface StructuredPayload {
  values: Record<string, StructuredValueInput>; // keyed by param_id
}

export type StructuredResult =
  | { ok: true; resultId: string; controlNo: number | null }
  | { ok: false; error: string };

interface PreparedContext {
  testRequestId: string;
  visitId: string;
  patientId: string;
  serviceId: string;
  templateId: string;
  paramIds: Set<string>;
  resultId: string;
  isNewResult: boolean;
}

// Validate request preconditions and ensure a results row exists. Used by
// both saveDraftAction and finaliseStructuredAction so the upsert is shared.
async function prepareStructured(
  testRequestId: string,
  payload: StructuredPayload,
): Promise<{ ok: true; ctx: PreparedContext } | { ok: false; error: string }> {
  const session = await requireActiveStaff();
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: tr } = await supabase
    .from("test_requests")
    .select(
      `
        id, status, assigned_to, visit_id, service_id,
        services!inner ( id, section, is_send_out ),
        visits!inner ( id, patient_id )
      `,
    )
    .eq("id", testRequestId)
    // Queue-deleted lines (0125) accept no result work.
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .maybeSingle();

  if (!tr) return { ok: false, error: "Test not found." };
  // N1 (go-live): section gate — reception (and any role outside the
  // test's bench) may not enter/amend a result via this path. See
  // SECTION_DENIED_ERROR for why this isn't disguised as "not found".
  const gateSvc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
  if (!isSectionAllowed(sectionsForRole(session.role), gateSvc?.section ?? null)) {
    return { ok: false, error: SECTION_DENIED_ERROR };
  }
  if (tr.assigned_to !== session.user_id) {
    return { ok: false, error: "You haven't claimed this test." };
  }
  if (!["in_progress", "result_uploaded"].includes(tr.status)) {
    return {
      ok: false,
      error: `Cannot edit values while status is ${tr.status}.`,
    };
  }

  const svc = Array.isArray(tr.services) ? tr.services[0] : tr.services;
  const visit = Array.isArray(tr.visits) ? tr.visits[0] : tr.visits;
  if (!svc || !visit) return { ok: false, error: "Missing service or visit." };
  if (svc.is_send_out) {
    return {
      ok: false,
      error: "Send-out tests use the PDF upload flow, not structured entry.",
    };
  }

  // Active templates only. An inactive per-service template is history — 0053
  // deactivated the 12 per-service chemistry templates when the consolidated
  // one replaced them, and entering values against one would write a result
  // no current template renders. (Prod 2026-09-25: the only other inactive
  // single-service template is the NA send-out placeholder, which the
  // send-out check above already refuses.) amendStructuredResultAction has the
  // same filter.
  const { data: tpl } = await supabase
    .from("result_templates")
    .select("id")
    .eq("service_id", tr.service_id)
    .eq("is_active", true)
    .maybeSingle();
  if (!tpl) {
    return { ok: false, error: "No active template is configured for this service." };
  }

  // Restrict the payload to params that actually belong to this template.
  const { data: paramRows } = await supabase
    .from("result_template_params")
    .select("id")
    .eq("template_id", tpl.id);
  const paramIds = new Set((paramRows ?? []).map((r) => r.id));
  for (const k of Object.keys(payload.values)) {
    if (!paramIds.has(k)) {
      return { ok: false, error: "Unknown parameter in payload." };
    }
  }

  // Ensure a draft results row exists (one per test_request).
  const { data: existingLink } = await admin
    .from("result_test_requests")
    .select("result_id, results!inner(id, generation_kind, finalised_at)")
    .eq("test_request_id", testRequestId)
    .maybeSingle();
  const existing = existingLink
    ? (Array.isArray(existingLink.results)
        ? existingLink.results[0]
        : existingLink.results) ?? null
    : null;

  let resultId = existing?.id ?? null;
  let isNewResult = false;

  if (!resultId) {
    const { data: inserted, error: insErr } = await admin
      .from("results")
      .insert({
        generation_kind: "structured",
        storage_path: null,
        uploaded_by: session.user_id,
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      return {
        ok: false,
        error: `Could not create result: ${insErr?.message ?? "unknown"}`,
      };
    }
    const { error: jErr } = await admin
      .from("result_test_requests")
      .insert({ result_id: inserted.id, test_request_id: testRequestId });
    if (jErr) {
      return {
        ok: false,
        error: `Could not link result: ${jErr.message}`,
      };
    }
    resultId = inserted.id;
    isNewResult = true;
  } else if (existing?.generation_kind !== "structured") {
    return {
      ok: false,
      error:
        "This test already has an uploaded PDF result; structured entry is not available.",
    };
  } else if (existing.finalised_at) {
    // 0172: a finished structured result changes only through Edit, which
    // keeps a version and checks nobody else edited it first. The database
    // refuses a draft or a second finalise too (result_save_draft /
    // result_finalise_commit, P0066); this is the friendly early answer.
    return {
      ok: false,
      error: "This result is already finalised. Use Edit results to change it.",
    };
  }

  return {
    ok: true,
    ctx: {
      testRequestId,
      visitId: visit.id,
      patientId: visit.patient_id,
      serviceId: tr.service_id,
      templateId: tpl.id,
      paramIds,
      resultId,
      isNewResult,
    },
  };
}

// A draft save: flags computed here, written by result_save_draft under the
// result's row lock (0172), which refuses once the result is finalised.
async function saveDraftValues(
  resultId: string,
  rows: ValueRow[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (rows.length === 0) return { ok: true };
  const admin = createAdminClient();
  const { error } = await admin.rpc("result_save_draft", {
    p_result_id: resultId,
    p_values: rows as unknown as Json,
  });
  if (error) return { ok: false, error: translatePgError(error) };
  return { ok: true };
}

// Load template params + patient (sex, birthdate) for one prepared context.
// Both saveDraft and finalise need this before computing flags.
async function loadParamsAndPatient(
  ctx: PreparedContext,
  ageAsOf: Date = new Date(),
): Promise<
  | { ok: true; params: TemplateParam[]; patientSex: PatientSex; patientAgeMonths: number | null }
  | { ok: false; error: string }
> {
  const admin = createAdminClient();
  // Strict: flags and critical alerts are computed from these ranges — a
  // failed read must abort, never save values with no flags (loaders.ts).
  let params: TemplateParam[];
  try {
    params = await loadTemplateParams(admin, ctx.templateId, { strict: true });
  } catch (e) {
    if (isTemplateParamsLoadError(e)) return { ok: false, error: TEMPLATE_PARAMS_LOAD_FAILED };
    throw e;
  }
  const { data: pat } = await admin
    .from("patients")
    .select("sex, birthdate")
    .eq("id", ctx.patientId)
    .single();
  const patientSex = normalisePatientSex(pat?.sex ?? null);
  const patientAgeMonths = calculateAgeMonths(pat?.birthdate ?? null, ageAsOf);
  return { ok: true, params, patientSex, patientAgeMonths };
}

export async function saveDraftAction(
  testRequestId: string,
  payload: StructuredPayload,
): Promise<StructuredResult> {
  const prep = await prepareStructured(testRequestId, payload);
  if (!prep.ok) return prep;

  const loaded = await loadParamsAndPatient(prep.ctx);
  if (!loaded.ok) return loaded;
  const { params, patientSex, patientAgeMonths } = loaded;
  const ups = await saveDraftValues(
    prep.ctx.resultId,
    buildValueRows(payload.values, new Map(params.map((p) => [p.id, p])), {
      sex: patientSex,
      ageMonths: patientAgeMonths,
    }),
  );
  if (!ups.ok) return ups;

  const session = await requireActiveStaff();
  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.draft_saved",
    resource_type: "result",
    resource_id: prep.ctx.resultId,
    metadata: {
      test_request_id: testRequestId,
      param_count: Object.keys(payload.values).length,
      first_save: prep.ctx.isNewResult,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/queue/${testRequestId}`);
  return { ok: true, resultId: prep.ctx.resultId, controlNo: null };
}

export async function finaliseStructuredAction(
  testRequestId: string,
  formData: FormData,
): Promise<StructuredResult> {
  // Parse the structured-values JSON. We send it as a string field inside
  // FormData so the same endpoint can carry the optional `image` File for
  // imaging_report layouts. saveDraftAction is untouched — drafts of an
  // imaging report skip the image; it's only required at finalise.
  const raw = formData.get("values");
  if (typeof raw !== "string") {
    return { ok: false, error: "Missing values payload." };
  }
  let payload: StructuredPayload;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("values" in parsed) ||
      typeof (parsed as { values: unknown }).values !== "object"
    ) {
      return { ok: false, error: "Invalid values payload." };
    }
    payload = parsed as StructuredPayload;
  } catch {
    return { ok: false, error: "Could not parse values payload." };
  }

  const prep = await prepareStructured(testRequestId, payload);
  if (!prep.ok) return prep;
  const ctx = prep.ctx;
  const admin = createAdminClient();
  const session = await requireActiveStaff();

  // 1) Params + patient. Age is taken at the instant printed on the PDF.
  const finalisedNow = new Date();
  const loaded = await loadParamsAndPatient(ctx, finalisedNow);
  if (!loaded.ok) return loaded;
  const { params, patientSex, patientAgeMonths } = loaded;
  const patientForRanges = { sex: patientSex, ageMonths: patientAgeMonths };
  const paramsById = new Map(params.map((p) => [p.id, p]));
  const newRows = buildValueRows(payload.values, paramsById, patientForRanges);

  // 2) Keep the medtech's entries even when finalise stops below (a missing
  //    value, a missing image) — the same thing the old upsert-first order
  //    guaranteed.
  const draft = await saveDraftValues(ctx.resultId, newRows);
  if (!draft.ok) return draft;

  // Validate against only the params relevant to this patient's sex —
  // gender-specific rows (e.g. Hemoglobin F + Hemoglobin M) are filtered to
  // the matching one so the form's view and the server's view agree.
  const visibleParams = filterParamsForPatient(params, patientSex);
  const missing = missingParams(visibleParams, payload.values);
  if (missing.length > 0) {
    return { ok: false, error: missingParamsError(missing) };
  }

  // 3) The COMPLETE value set this finalise writes and prints: the stored
  //    draft rows (restricted to this template) overlaid with the form's.
  const { data: storedRows, error: storedErr } = await admin
    .from("result_values")
    .select(
      "parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, flag, is_blank",
    )
    .eq("result_id", ctx.resultId);
  if (storedErr) return { ok: false, error: translatePgError(storedErr) };
  const completeRows = mergeValueRows(
    (storedRows ?? [])
      .filter((r) => ctx.paramIds.has(r.parameter_id))
      .map((r) => ({ ...r, flag: r.flag as ValueRow["flag"] })),
    newRows,
  );
  const values = valueRowsToDocValues(completeRows);

  // 4) Load template + service + patient + medtech for the document.
  const { data: tplRow } = await admin
    .from("result_templates")
    .select("layout, header_notes, footer_notes")
    .eq("id", ctx.templateId)
    .single();

  const { data: svc } = await admin
    .from("services")
    .select("code, name")
    .eq("id", ctx.serviceId)
    .single();

  const { data: visit } = await admin
    .from("visits")
    .select("visit_number")
    .eq("id", ctx.visitId)
    // prepareStructured already proved the visit was live, but that was a
    // separate round trip — restate it (0125) so a visit deleted in between
    // fails the render rather than stamping a deleted visit's number on a PDF.
    // Null is already handled by the !visit guard below.
    .is("deleted_at", null)
    .single();

  const { data: patient } = await admin
    .from("patients")
    .select("drm_id, first_name, last_name, sex, birthdate")
    .eq("id", ctx.patientId)
    .single();

  const { data: medtech } = await admin
    .from("staff_profiles")
    .select("full_name, prc_license_kind, prc_license_no")
    .eq("id", session.user_id)
    .single();

  if (!tplRow || !svc || !visit || !patient) {
    return { ok: false, error: "Failed to load record for PDF render." };
  }

  // 5) Imaging-report layouts require an image attachment at finalise. We
  //    deliberately don't accept the image at saveDraftAction time — drafts
  //    skip it. Validate now, BEFORE rendering the PDF, so we can fail fast
  //    if the file is missing / oversized / wrong mime.
  const isImaging = tplRow.layout === "imaging_report";
  let image: { body: Buffer; mime: string; filename: string; size: number; ext: string } | null =
    null;

  if (isImaging) {
    const rawImage = formData.get("image");
    if (!(rawImage instanceof File) || rawImage.size === 0) {
      return {
        ok: false,
        error: "Image upload is required for imaging reports.",
      };
    }
    if (!IMAGING_ALLOWED_MIMES.has(rawImage.type)) {
      return {
        ok: false,
        error:
          "Unsupported image type — please upload JPEG, PNG, WebP, or PDF.",
      };
    }
    if (rawImage.size > IMAGING_MAX_BYTES) {
      return {
        ok: false,
        error: "Image must be 25 MB or less.",
      };
    }
    image = {
      body: Buffer.from(await rawImage.arrayBuffer()),
      mime: rawImage.type,
      filename: rawImage.name || `attachment.${fileExtForMime(rawImage.type)}`,
      size: rawImage.size,
      ext: fileExtForMime(rawImage.type),
    };
  }

  // 6) Read control_no — set by the sequence default on insert, so always
  //    present by the time we get here.
  const { data: pre } = await admin
    .from("results")
    .select("control_no")
    .eq("id", ctx.resultId)
    .single();
  const controlNo = pre?.control_no ?? null;

  // 7) Render the PDF (embedding the image when present) from the values
  //    about to be written.
  const consultants = await loadConsultantSignatures();
  const performer = await resolvePerformer({
    service: { code: svc.code, kind: null },
    finalisedByStaffId: session.user_id,
  });

  const docInput: ResultDocumentInput = {
    template: {
      layout: tplRow.layout as ResultLayout,
      header_notes: tplRow.header_notes,
      footer_notes: tplRow.footer_notes,
    },
    params,
    values,
    service: { code: svc.code, name: svc.name },
    patient: {
      drm_id: patient.drm_id,
      last_name: patient.last_name,
      first_name: patient.first_name,
      sex: normalisePatientSex(patient.sex),
      birthdate: patient.birthdate,
    },
    visit: { visit_number: visit.visit_number },
    controlNo,
    finalisedAt: finalisedNow,
    ageAsOf: finalisedNow,
    medtech: medtech
      ? {
          full_name: medtech.full_name,
          prc_license_kind: medtech.prc_license_kind,
          prc_license_no: medtech.prc_license_no,
        }
      : null,
    performer,
    consultantPathologist: consultants.pathologist,
    imageAttachment: image
      ? { data: new Uint8Array(image.body), mime: image.mime, filename: image.filename }
      : undefined,
  };

  const pdf = await renderResultPdf(docInput);

  // 8) Upload (attempt-unique paths) and commit values + PDF pointer +
  //    finalised_at + image + critical alerts in ONE transaction (0172
  //    result_finalise_commit). Writing finalised_at fires the status flip
  //    inside it, so the test advances together with its PDF or not at all.
  //    The notification bell subscribes to critical_alerts inserts, so
  //    pathologists + admins are paged the moment this commits.
  const alerts = detectCrossings(
    completeRows,
    new Map(visibleParams.map((p) => [p.id, p])),
    patientForRanges,
    () => testRequestId,
  );
  const committed = await commitResultFinalise({
    resultId: ctx.resultId,
    finaliserId: session.user_id,
    base: `${ctx.patientId}/${ctx.visitId}/${ctx.testRequestId}`,
    pdf,
    finalisedAt: finalisedNow,
    values: completeRows,
    image,
    alerts,
  });
  if (!committed.ok) return { ok: false, error: committed.error };

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.finalised",
    resource_type: "result",
    resource_id: ctx.resultId,
    metadata: {
      test_request_id: testRequestId,
      visit_id: ctx.visitId,
      control_no: controlNo,
      param_count: completeRows.length,
      abnormal_count: completeRows.filter((v) => v.flag).length,
      pdf_size_bytes: pdf.byteLength,
      storage_path: committed.data.storagePath,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  if (image && committed.data.imagePath) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      action: "result.imaging_attached",
      resource_type: "result",
      resource_id: ctx.resultId,
      metadata: {
        test_request_id: testRequestId,
        image_storage_path: committed.data.imagePath,
        image_mime_type: image.mime,
        image_size_bytes: image.size,
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

  if (committed.data.alertsAdded.length > 0) {
    await audit({
      actor_id: session.user_id,
      actor_type: "staff",
      patient_id: ctx.patientId,
      action: "result.critical_value_detected",
      resource_type: "result",
      resource_id: ctx.resultId,
      metadata: {
        test_request_id: testRequestId,
        alerts: committed.data.alertsAdded.map((a) => ({
          parameter: a.parameter_name,
          direction: a.direction,
          observed: a.observed_value_si,
          threshold: a.threshold_si,
        })),
      },
      ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: h.get("user-agent"),
    });
  }

  revalidatePath(`/staff/queue`);
  revalidatePath(`/staff/queue/${testRequestId}`);
  revalidatePath(`/staff/visits/${ctx.visitId}`);
  return { ok: true, resultId: ctx.resultId, controlNo };
}

export async function uploadResultAction(
  testRequestId: string,
  formData: FormData,
): Promise<UploadResult> {
  const session = await requireActiveStaff();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Please attach a PDF file." };
  }
  if (file.type !== "application/pdf") {
    return { ok: false, error: "File must be a PDF." };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: "PDF must be 10 MB or less." };
  }

  const notes = (formData.get("notes") ?? "").toString().trim();

  const supabase = await createClient();
  const { data: testRequest } = await supabase
    .from("test_requests")
    .select(
      `
        id, status, visit_id, service_id,
        services!inner ( section ),
        visits!inner ( id, patient_id )
      `,
    )
    .eq("id", testRequestId)
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .maybeSingle();

  if (!testRequest) return { ok: false, error: "Test not found." };
  // N1 (go-live): section gate — same predicate as the claim/reassign
  // actions in ../actions.ts.
  {
    const gateSvc = Array.isArray(testRequest.services)
      ? testRequest.services[0]
      : testRequest.services;
    if (!isSectionAllowed(sectionsForRole(session.role), gateSvc?.section ?? null)) {
      return { ok: false, error: SECTION_DENIED_ERROR };
    }
  }
  if (testRequest.status !== "in_progress") {
    return {
      ok: false,
      error: `Test must be in_progress to upload (currently ${testRequest.status}).`,
    };
  }
  const visit = Array.isArray(testRequest.visits)
    ? testRequest.visits[0]
    : testRequest.visits;
  if (!visit) return { ok: false, error: "Visit not found." };

  const path = `${visit.patient_id}/${visit.id}/${testRequest.id}.pdf`;
  const admin = createAdminClient();

  // If a junction already exists (e.g. the first upload's status-flip trigger
  // failed pre-0059 and left the test stuck at in_progress), replace the
  // existing uploaded result in place instead of inserting a duplicate —
  // result_test_requests has a unique constraint on test_request_id.
  const { data: existingLink } = await admin
    .from("result_test_requests")
    .select("result_id, results!inner(id, generation_kind)")
    .eq("test_request_id", testRequest.id)
    .maybeSingle();
  const existingResult = existingLink
    ? (Array.isArray(existingLink.results)
        ? existingLink.results[0]
        : existingLink.results) ?? null
    : null;
  if (existingResult && existingResult.generation_kind !== "uploaded") {
    return {
      ok: false,
      error:
        "This test already has a structured result; use Amend to revise it.",
    };
  }

  // Upload (overwrite if a previous attempt left a stray file).
  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadErr } = await admin.storage
    .from("results")
    .upload(path, buffer, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadErr) {
    return { ok: false, error: `Upload failed: ${uploadErr.message}` };
  }

  let resultId: string;
  if (existingResult) {
    // Replace-in-place path: update the existing result row. The 0059
    // junction trigger isn't involved here (junction is unchanged), so
    // re-advance the test_request status explicitly if it's still stuck.
    const { error: updateErr } = await admin
      .from("results")
      .update({
        storage_path: path,
        file_size_bytes: file.size,
        uploaded_by: session.user_id,
        uploaded_at: new Date().toISOString(),
        notes: notes || null,
      })
      .eq("id", existingResult.id);
    if (updateErr) {
      return { ok: false, error: `Could not update result: ${updateErr.message}` };
    }
    resultId = existingResult.id;

    if (testRequest.status === "in_progress") {
      const { data: svcRow } = await admin
        .from("services")
        .select("requires_signoff")
        .eq("id", testRequest.service_id)
        .maybeSingle();
      const nextStatus = svcRow?.requires_signoff
        ? "result_uploaded"
        : "ready_for_release";
      await admin
        .from("test_requests")
        .update({
          status: nextStatus,
          completed_at: new Date().toISOString(),
        })
        .eq("id", testRequest.id);
    }
  } else {
    // First-time path: insert results then junction. Junction insert fires
    // trg_rtr_advance_test (migration 0059) to flip test_requests.status.
    const { data: resultRow, error: insertErr } = await admin
      .from("results")
      .insert({
        storage_path: path,
        file_size_bytes: file.size,
        uploaded_by: session.user_id,
        notes: notes || null,
      })
      .select("id")
      .single();

    if (insertErr || !resultRow) {
      await admin.storage.from("results").remove([path]);
      return {
        ok: false,
        error: insertErr?.message ?? "Could not record the result.",
      };
    }

    const { error: jErr } = await admin
      .from("result_test_requests")
      .insert({ result_id: resultRow.id, test_request_id: testRequest.id });
    if (jErr) {
      await admin.storage.from("results").remove([path]);
      return { ok: false, error: `Could not link result: ${jErr.message}` };
    }
    resultId = resultRow.id;
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.uploaded",
    resource_type: "result",
    resource_id: resultId,
    metadata: {
      test_request_id: testRequest.id,
      visit_id: visit.id,
      storage_path: path,
      file_size_bytes: file.size,
      replaced_existing: existingResult ? true : false,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath("/staff/queue");
  revalidatePath(`/staff/queue/${testRequest.id}`);
  revalidatePath(`/staff/visits/${visit.id}`);
  return { ok: true };
}

export type AmendResult = { ok: true } | { ok: false; error: string };

// A consolidated (report-group) result is ONE results row shared by every
// member test (the chemistry panel). Both amend actions below are single-test
// by construction: they load ONE test's per-service template and rewrite the
// whole result. Called on a chemistry test, the structured path picked up the
// per-service template 0053 deactivated (its lookup has no is_active filter)
// and deleted every member's values. The page never offered it — the test
// page redirects chemistry to the consolidated route — but a Server Action is
// callable directly, so refuse here.
const SHARED_REPORT_AMEND_ERROR =
  "This test is part of a combined report (such as Chemistry), so it can't be edited on its own.";

async function isSharedReport(
  admin: ReturnType<typeof createAdminClient>,
  resultId: string,
  serviceReportGroupId: string | null,
  resultReportGroupId: string | null,
): Promise<boolean> {
  if (serviceReportGroupId || resultReportGroupId) return true;
  const { count } = await admin
    .from("result_test_requests")
    .select("test_request_id", { count: "exact", head: true })
    .eq("result_id", resultId);
  return (count ?? 0) > 1;
}

// The form carries the amendment_count it was opened on; result_edit_commit
// refuses the save (P0065) when someone else edited the result since.
function parseExpectedAmendmentCount(formData: FormData): number | null {
  const raw = (formData.get("expected_amendment_count") ?? "").toString();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

const MISSING_VERSION_ERROR =
  "This form is out of date. Reload the page and make your change again.";

// Amend an already-released (or result_uploaded / ready_for_release)
// result by replacing its PDF (uploaded send-out PDFs). The prior version is
// snapshotted and kept at its old path — never overwritten — and the new file
// commits through result_edit_commit (0172): version check, snapshot and
// pointer swap in one transaction.
export async function amendResultAction(
  testRequestId: string,
  formData: FormData,
): Promise<AmendResult> {
  const session = await requireActiveStaff();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Please attach the corrected PDF." };
  }
  if (file.type !== "application/pdf") {
    return { ok: false, error: "File must be a PDF." };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: "PDF must be 10 MB or less." };
  }
  const reasonCheck = validateEditReason(formData.get("reason"));
  if (!reasonCheck.ok) return reasonCheck;
  const reason = reasonCheck.reason;
  const expected = parseExpectedAmendmentCount(formData);
  if (expected == null) return { ok: false, error: MISSING_VERSION_ERROR };

  const admin = createAdminClient();

  // Load the current result + parent test_request + visit context.
  const { data: resultLink } = await admin
    .from("result_test_requests")
    .select("result_id, results!inner(id, storage_path, amendment_count, report_group_id)")
    .eq("test_request_id", testRequestId)
    .maybeSingle();
  const result = resultLink
    ? (Array.isArray(resultLink.results)
        ? resultLink.results[0]
        : resultLink.results) ?? null
    : null;
  if (!result || !result.storage_path) {
    return { ok: false, error: "No result on file to amend." };
  }

  const { data: testRow } = await admin
    .from("test_requests")
    .select(
      "id, status, visit_id, services!inner ( section, report_group_id ), visits!inner ( id, patient_id )",
    )
    .eq("id", testRequestId)
    // Queue-deleted lines (0125) accept no result work.
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .maybeSingle();
  if (!testRow) return { ok: false, error: "Test not found." };
  // N1 (go-live): section gate. This read runs on the admin client (no RLS),
  // so the role check has to happen here explicitly.
  {
    const gateSvc = Array.isArray(testRow.services)
      ? testRow.services[0]
      : testRow.services;
    if (!isSectionAllowed(sectionsForRole(session.role), gateSvc?.section ?? null)) {
      return { ok: false, error: SECTION_DENIED_ERROR };
    }
    if (
      await isSharedReport(
        admin,
        result.id,
        gateSvc?.report_group_id ?? null,
        result.report_group_id,
      )
    ) {
      return { ok: false, error: SHARED_REPORT_AMEND_ERROR };
    }
  }
  const visit = Array.isArray(testRow.visits) ? testRow.visits[0] : testRow.visits;
  if (!visit) return { ok: false, error: "Visit not found." };

  // Allowed amendment statuses: anything past the medtech editing stage
  // — including released. Tests still in progress should be edited via
  // the normal workflow, not amended. result_edit_commit re-checks (P0066).
  if (!isEditableStatus(testRow.status)) {
    return {
      ok: false,
      error: `Test status is ${testRow.status} — amend only applies after a result has been recorded.`,
    };
  }
  // Fast answer for a stale form; the RPC is the real check.
  if ((result.amendment_count ?? 0) !== expected) {
    return { ok: false, error: translatePgError({ code: "P0065" }) };
  }

  const committed = await commitResultEdit({
    resultId: result.id,
    expectedAmendmentCount: expected,
    currentStoragePath: result.storage_path,
    editorId: session.user_id,
    reason,
    anchorTestRequestId: testRow.id,
    pdf: Buffer.from(await file.arrayBuffer()),
    values: null,
    newImage: null,
    alerts: null,
  });
  if (!committed.ok) return committed;

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.amended",
    resource_type: "result",
    resource_id: result.id,
    metadata: {
      test_request_id: testRow.id,
      visit_id: visit.id,
      amendment_seq: committed.data.amendmentSeq,
      reason,
      prior_storage_path: committed.data.priorStoragePath,
      new_storage_path: committed.data.newStoragePath,
      replayed: committed.data.replayed,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/queue/${testRow.id}`);
  revalidatePath(`/staff/visits/${visit.id}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Structured-result amendment
// ---------------------------------------------------------------------------
// When a finalised structured result needs correction, the medtech re-opens
// the structured form pre-filled with the current values, edits, and
// submits with a reason. The new PDF is rendered from the new values and the
// whole edit — snapshot of the prior values / PDF / image, the new values,
// the new PDF pointer, critical-alert reconciliation — commits in one
// transaction through result_edit_commit (0172). The prior PDF stays at its
// path for the history panel's "View replaced version" link.
//
// Distinct from amendResultAction (PDF-replace), which remains for
// generation_kind = 'uploaded' results (send-out PDFs).
export async function amendStructuredResultAction(
  testRequestId: string,
  formData: FormData,
): Promise<StructuredResult> {
  // 1) Parse + validate the FormData fields. Same wording / thresholds as
  //    amendResultAction so errors are consistent across the two paths.
  const raw = formData.get("values");
  if (typeof raw !== "string") {
    return { ok: false, error: "Missing values payload." };
  }
  let payload: StructuredPayload;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("values" in parsed) ||
      typeof (parsed as { values: unknown }).values !== "object"
    ) {
      return { ok: false, error: "Invalid values payload." };
    }
    payload = parsed as StructuredPayload;
  } catch {
    return { ok: false, error: "Could not parse values payload." };
  }

  const reasonCheck = validateEditReason(formData.get("reason"));
  if (!reasonCheck.ok) return reasonCheck;
  const reason = reasonCheck.reason;
  const expected = parseExpectedAmendmentCount(formData);
  if (expected == null) return { ok: false, error: MISSING_VERSION_ERROR };

  const session = await requireActiveStaff();
  const admin = createAdminClient();

  // 2) Load the result + parent test_request + visit context. Status must
  //    be past medtech editing AND generation_kind must be 'structured'
  //    (PDF-only results use the amendResultAction path).
  const { data: resultLink } = await admin
    .from("result_test_requests")
    .select(
      `result_id, results!inner(
        id, storage_path, amendment_count, generation_kind, finalised_at,
        report_group_id, control_no,
        image_storage_path, image_filename, image_mime_type
      )`,
    )
    .eq("test_request_id", testRequestId)
    .maybeSingle();
  const result = resultLink
    ? (Array.isArray(resultLink.results)
        ? resultLink.results[0]
        : resultLink.results) ?? null
    : null;
  if (!result || !result.storage_path) {
    return { ok: false, error: "No result on file to amend." };
  }
  if (result.generation_kind !== "structured") {
    return {
      ok: false,
      error:
        "This result was uploaded as a PDF — use the PDF amend flow instead.",
    };
  }
  if (!result.finalised_at) {
    return {
      ok: false,
      error: "Cannot amend a draft — finalise it first.",
    };
  }

  const { data: testRow } = await admin
    .from("test_requests")
    .select(
      `id, status, visit_id, service_id,
       services!inner ( id, code, name, section, report_group_id ),
       visits!inner ( id, patient_id, visit_number )`,
    )
    .eq("id", testRequestId)
    // Queue-deleted lines (0125) accept no result work.
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .maybeSingle();
  if (!testRow) return { ok: false, error: "Test not found." };
  const visit = Array.isArray(testRow.visits)
    ? testRow.visits[0]
    : testRow.visits;
  const svc = Array.isArray(testRow.services)
    ? testRow.services[0]
    : testRow.services;
  if (!visit || !svc) {
    return { ok: false, error: "Missing service or visit." };
  }
  // N1 (go-live): section gate. This read runs on the admin client (no
  // RLS), so the role check has to happen here explicitly.
  if (!isSectionAllowed(sectionsForRole(session.role), svc.section)) {
    return { ok: false, error: SECTION_DENIED_ERROR };
  }
  if (await isSharedReport(admin, result.id, svc.report_group_id, result.report_group_id)) {
    return { ok: false, error: SHARED_REPORT_AMEND_ERROR };
  }

  if (!isEditableStatus(testRow.status)) {
    return {
      ok: false,
      error: `Test status is ${testRow.status} — amend only applies after a result has been recorded.`,
    };
  }
  if ((result.amendment_count ?? 0) !== expected) {
    return { ok: false, error: translatePgError({ code: "P0065" }) };
  }

  // 3) Load the ACTIVE template + restrict payload to its params (mirrors
  //    the paramIds guard in prepareStructured). Without is_active a
  //    deactivated per-service template could be picked up.
  const { data: tpl } = await admin
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes")
    .eq("service_id", testRow.service_id)
    .eq("is_active", true)
    .maybeSingle();
  if (!tpl) {
    return { ok: false, error: "No active template is configured for this service." };
  }
  let params: Awaited<ReturnType<typeof loadTemplateParams>>;
  try {
    params = await loadTemplateParams(admin, tpl.id, { strict: true });
  } catch (e) {
    if (isTemplateParamsLoadError(e)) return { ok: false, error: TEMPLATE_PARAMS_LOAD_FAILED };
    throw e;
  }
  const paramsById = new Map(params.map((p) => [p.id, p]));
  for (const k of Object.keys(payload.values)) {
    if (!paramsById.has(k)) {
      return { ok: false, error: "Unknown parameter in payload." };
    }
  }

  // 4) Patient. An edited report keeps its ORIGINAL date, and the age band
  //    behind every range, flag and critical threshold is taken on that
  //    date too — a correction after a birthday cannot move the band.
  const reportDate = new Date(result.finalised_at);
  const { data: pat } = await admin
    .from("patients")
    .select("drm_id, first_name, last_name, sex, birthdate")
    .eq("id", visit.patient_id)
    .single();
  if (!pat) {
    return { ok: false, error: "Patient record not found." };
  }
  const patientSex = normalisePatientSex(pat.sex);
  const patientForRanges = {
    sex: patientSex,
    ageMonths: calculateAgeMonths(pat.birthdate, reportDate),
  };

  // Validate visible params have values — same shape as finalise. We do
  // this BEFORE any storage / DB writes so the user sees the error early.
  const visibleParams = filterParamsForPatient(params, patientSex);
  const missing = missingParams(visibleParams, payload.values);
  if (missing.length > 0) {
    return { ok: false, error: missingParamsError(missing) };
  }

  // The edit REPLACES the value set: a parameter the form no longer sends
  // is removed (the prior rows are kept in the amendment's snapshot).
  const newRows = buildValueRows(payload.values, paramsById, patientForRanges);
  const values = valueRowsToDocValues(newRows);

  // 5) Imaging branch — optional new image. If absent, the current image is
  //    re-downloaded for the PDF embed and its columns stay untouched.
  const isImaging = tpl.layout === "imaging_report";
  let newImage: { body: Buffer; mime: string; filename: string; size: number; ext: string } | null =
    null;
  if (isImaging) {
    const rawImage = formData.get("image");
    if (rawImage instanceof File && rawImage.size > 0) {
      if (!IMAGING_ALLOWED_MIMES.has(rawImage.type)) {
        return {
          ok: false,
          error:
            "Unsupported image type — please upload JPEG, PNG, WebP, or PDF.",
        };
      }
      if (rawImage.size > IMAGING_MAX_BYTES) {
        return { ok: false, error: "Image must be 25 MB or less." };
      }
      newImage = {
        body: Buffer.from(await rawImage.arrayBuffer()),
        mime: rawImage.type,
        filename: rawImage.name || `attachment.${fileExtForMime(rawImage.type)}`,
        size: rawImage.size,
        ext: fileExtForMime(rawImage.type),
      };
    }
  }

  let pdfImage: { data: Uint8Array; mime: string; filename: string } | undefined;
  if (newImage) {
    pdfImage = { data: new Uint8Array(newImage.body), mime: newImage.mime, filename: newImage.filename };
  } else if (isImaging && result.image_storage_path && result.image_mime_type) {
    const { data: dl, error: dlErr } = await admin.storage
      .from("result-images")
      .download(result.image_storage_path);
    if (dlErr || !dl) {
      return {
        ok: false,
        error: `Could not load existing image: ${dlErr?.message ?? "unknown"}`,
      };
    }
    pdfImage = {
      data: new Uint8Array(await dl.arrayBuffer()),
      mime: result.image_mime_type,
      filename: result.image_filename ?? "attachment",
    };
  }

  // 6) Prior values, for the audit's change count only — the authoritative
  //    snapshot is taken by result_edit_commit under the row lock.
  const { data: priorRows } = await admin
    .from("result_values")
    .select("parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, is_blank")
    .eq("result_id", result.id);

  // 7) Render the new PDF. It signs as the editor (owner decision
  //    2026-09-24) and keeps the control number and the original date.
  const { data: medtech } = await admin
    .from("staff_profiles")
    .select("full_name, prc_license_kind, prc_license_no")
    .eq("id", session.user_id)
    .single();
  const amendConsultants = await loadConsultantSignatures();
  const amendPerformer = await resolvePerformer({
    service: { code: svc.code, kind: null },
    finalisedByStaffId: session.user_id,
  });

  const docInput: ResultDocumentInput = {
    template: {
      layout: tpl.layout as ResultLayout,
      header_notes: tpl.header_notes,
      footer_notes: tpl.footer_notes,
    },
    params,
    values,
    service: { code: svc.code, name: svc.name },
    patient: {
      drm_id: pat.drm_id,
      last_name: pat.last_name,
      first_name: pat.first_name,
      sex: patientSex,
      birthdate: pat.birthdate,
    },
    visit: { visit_number: visit.visit_number },
    controlNo: result.control_no ?? null,
    finalisedAt: reportDate,
    ageAsOf: reportDate,
    medtech: medtech
      ? {
          full_name: medtech.full_name,
          prc_license_kind: medtech.prc_license_kind,
          prc_license_no: medtech.prc_license_no,
        }
      : null,
    performer: amendPerformer,
    consultantPathologist: amendConsultants.pathologist,
    imageAttachment: pdfImage,
  };
  const pdf = await renderResultPdf(docInput);

  // 8) Commit. Critical alerts follow the NEW values: a new crossing pages,
  //    an unacknowledged alert the correction removed is withdrawn, an
  //    acknowledged one is never touched.
  const alerts = detectCrossings(
    newRows,
    new Map(visibleParams.map((p) => [p.id, p])),
    patientForRanges,
    () => testRow.id,
  );
  const committed = await commitResultEdit({
    resultId: result.id,
    expectedAmendmentCount: expected,
    currentStoragePath: result.storage_path,
    editorId: session.user_id,
    reason,
    anchorTestRequestId: testRow.id,
    pdf,
    values: newRows,
    newImage: newImage
      ? {
          ...newImage,
          currentImagePath: result.image_storage_path,
          fallbackBase: `${visit.patient_id}/${visit.id}/${testRow.id}`,
        }
      : null,
    alerts,
  });
  if (!committed.ok) return committed;

  // 9) Audit.
  const valueChangeCount = countValueChanges(
    new Map((priorRows ?? []).map((r) => [r.parameter_id, r])),
    new Map(newRows.map((r) => [r.parameter_id, r])),
  );
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.amended",
    resource_type: "result",
    resource_id: result.id,
    metadata: {
      test_request_id: testRow.id,
      visit_id: visit.id,
      amendment_seq: committed.data.amendmentSeq,
      reason,
      prior_storage_path: committed.data.priorStoragePath,
      new_storage_path: committed.data.newStoragePath,
      value_change_count: valueChangeCount,
      replayed: committed.data.replayed,
    },
    ip_address: ip,
    user_agent: ua,
  });
  await auditAlertChanges(committed.data, {
    actorId: session.user_id,
    patientId: visit.patient_id,
    resultId: result.id,
    testRequestIds: [testRow.id],
    ip,
    ua,
  });

  revalidatePath(`/staff/queue`);
  revalidatePath(`/staff/queue/${testRow.id}`);
  revalidatePath(`/staff/visits/${visit.id}`);
  return { ok: true, resultId: result.id, controlNo: result.control_no ?? null };
}

export async function getResultDownloadUrl(
  testRequestId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const session = await requireActiveStaff();
  const admin = createAdminClient();

  // N1 (go-live): section gate. This mints a 5-minute signed URL to the
  // actual result PDF — the read discloses patient data just as directly as
  // amending does, so it needs the same gate as every write action on this
  // route (RLS on `results`/`result_test_requests` includes reception per
  // 0051, so it does not save us here). Runs on the admin client, so the
  // role check has to happen here explicitly.
  const { data: gateRow } = await admin
    .from("test_requests")
    .select("services!inner ( section ), visits!inner ( id )")
    .eq("id", testRequestId)
    // Queue-deleted lines (0125), or lines on a deleted visit, mint no
    // signed URL to the result PDF.
    .is("deleted_at", null)
    .is("visits.deleted_at", null)
    .maybeSingle();
  const gateSvc = gateRow
    ? Array.isArray(gateRow.services)
      ? gateRow.services[0]
      : gateRow.services
    : null;
  if (!gateRow) return { ok: false, error: "Test not found." };
  if (!isSectionAllowed(sectionsForRole(session.role), gateSvc?.section ?? null)) {
    return { ok: false, error: SECTION_DENIED_ERROR };
  }

  const { data: resultLink } = await admin
    .from("result_test_requests")
    .select("result_id, results!inner(id, storage_path)")
    .eq("test_request_id", testRequestId)
    .maybeSingle();
  const result = resultLink
    ? (Array.isArray(resultLink.results)
        ? resultLink.results[0]
        : resultLink.results) ?? null
    : null;

  if (!result) return { ok: false, error: "No result file." };
  if (!result.storage_path) {
    return { ok: false, error: "Result is still a draft — no PDF yet." };
  }

  // A shared (chemistry) report is one file carrying every member's values,
  // so the gate above — THIS test's section — is not enough: every linked
  // test, deleted ones included, must be in the caller's sections too. Same
  // rule as the staff PDF route (report-section-gate.ts). A failed read denies.
  const memberSections = await resultMemberSections(admin, result.id);
  if (!membersWithinSections(sectionsForRole(session.role), memberSections ?? [])) {
    return { ok: false, error: "This report includes tests outside your sections." };
  }

  const { data: signed, error } = await admin.storage
    .from("results")
    .createSignedUrl(result.storage_path, 60 * 5); // 5 min

  if (error || !signed?.signedUrl) {
    return { ok: false, error: error?.message ?? "Could not sign URL." };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.viewed",
    resource_type: "result",
    resource_id: result.id,
    metadata: { test_request_id: testRequestId, viewer_role: session.role },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  return { ok: true, url: signed.signedUrl };
}
