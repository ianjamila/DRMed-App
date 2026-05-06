"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit/log";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { renderResultPdf } from "@/lib/results/render-pdf";
import {
  calculateAgeMonths,
  computeFlag,
  detectCritical,
  filterParamsForPatient,
  normalisePatientSex,
  pickRangeForPatient,
  type PatientSex,
  type ResultDocumentInput,
  type ResultLayout,
  type ParamValue,
  type TemplateParam,
} from "@/lib/results/types";
import { loadTemplateParams } from "@/lib/results/loaders";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

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
        services!inner ( id, is_send_out ),
        visits!inner ( id, patient_id )
      `,
    )
    .eq("id", testRequestId)
    .maybeSingle();

  if (!tr) return { ok: false, error: "Test not found." };
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

  const { data: tpl } = await supabase
    .from("result_templates")
    .select("id")
    .eq("service_id", tr.service_id)
    .maybeSingle();
  if (!tpl) {
    return { ok: false, error: "No template configured for this service." };
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
  const { data: existing } = await admin
    .from("results")
    .select("id, generation_kind")
    .eq("test_request_id", testRequestId)
    .maybeSingle();

  let resultId = existing?.id ?? null;
  let isNewResult = false;

  if (!resultId) {
    const { data: inserted, error: insErr } = await admin
      .from("results")
      .insert({
        test_request_id: testRequestId,
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
    resultId = inserted.id;
    isNewResult = true;
  } else if (existing?.generation_kind !== "structured") {
    return {
      ok: false,
      error:
        "This test already has an uploaded PDF result; structured entry is not available.",
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

async function upsertValues(
  resultId: string,
  payload: StructuredPayload,
  params: TemplateParam[],
  patientSex: PatientSex,
  patientAgeMonths: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = createAdminClient();
  const paramsById = new Map(params.map((p) => [p.id, p]));

  const rows = Object.entries(payload.values).map(([paramId, v]) => {
    const param = paramsById.get(paramId);
    let flag: "H" | "L" | "A" | null = null;
    if (param) {
      const range = pickRangeForPatient(param, patientSex, patientAgeMonths);
      flag = computeFlag(param, range, v);
    }
    return {
      result_id: resultId,
      parameter_id: paramId,
      numeric_value_si: v.numeric_value_si,
      numeric_value_conv: v.numeric_value_conv,
      text_value: v.text_value,
      select_value: v.select_value,
      is_blank: v.is_blank,
      flag,
    };
  });

  if (rows.length === 0) return { ok: true };

  const { error } = await admin
    .from("result_values")
    .upsert(rows, { onConflict: "result_id,parameter_id" });

  if (error) {
    return { ok: false, error: `Could not save values: ${error.message}` };
  }
  return { ok: true };
}

// Load template params + patient (sex, birthdate) for one prepared context.
// Both saveDraft and finalise need this before computing flags.
async function loadParamsAndPatient(ctx: PreparedContext): Promise<{
  params: TemplateParam[];
  patientSex: PatientSex;
  patientAgeMonths: number | null;
}> {
  const admin = createAdminClient();
  const params = await loadTemplateParams(admin, ctx.templateId);
  const { data: pat } = await admin
    .from("patients")
    .select("sex, birthdate")
    .eq("id", ctx.patientId)
    .single();
  const patientSex = normalisePatientSex(pat?.sex ?? null);
  const patientAgeMonths = calculateAgeMonths(pat?.birthdate ?? null);
  return { params, patientSex, patientAgeMonths };
}

export async function saveDraftAction(
  testRequestId: string,
  payload: StructuredPayload,
): Promise<StructuredResult> {
  const prep = await prepareStructured(testRequestId, payload);
  if (!prep.ok) return prep;

  const { params, patientSex, patientAgeMonths } = await loadParamsAndPatient(
    prep.ctx,
  );
  const ups = await upsertValues(
    prep.ctx.resultId,
    payload,
    params,
    patientSex,
    patientAgeMonths,
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
  payload: StructuredPayload,
): Promise<StructuredResult> {
  const prep = await prepareStructured(testRequestId, payload);
  if (!prep.ok) return prep;
  const ctx = prep.ctx;
  const admin = createAdminClient();

  // 1) Load params + patient up-front so we can compute flags during the
  //    upsert (the DB trigger that used to do this was dropped in 0010).
  const { params, patientSex, patientAgeMonths } = await loadParamsAndPatient(
    ctx,
  );

  // 2) Persist the values + flags.
  const ups = await upsertValues(
    ctx.resultId,
    payload,
    params,
    patientSex,
    patientAgeMonths,
  );
  if (!ups.ok) return ups;

  // Validate against only the params relevant to this patient's sex —
  // gender-specific rows (e.g. Hemoglobin F + Hemoglobin M) are filtered to
  // the matching one so the form's view and the server's view agree.
  const visibleParams = filterParamsForPatient(params, patientSex);

  const missing = visibleParams
    .filter((p) => !p.is_section_header)
    .filter((p) => {
      const v = payload.values[p.id];
      if (!v) return true;
      if (v.is_blank) return false;
      if (p.input_type === "numeric") {
        return v.numeric_value_si == null && v.numeric_value_conv == null;
      }
      if (p.input_type === "select") {
        return !v.select_value;
      }
      return !v.text_value || !v.text_value.trim();
    });

  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing values for: ${missing
        .slice(0, 5)
        .map((p) => p.parameter_name)
        .join(", ")}${missing.length > 5 ? "…" : ""}. Mark blank if you didn't run the sub-test.`,
    };
  }

  // 3) Re-read the persisted values (with computed flags) for the PDF.
  const { data: valueRows } = await admin
    .from("result_values")
    .select(
      "parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, flag, is_blank",
    )
    .eq("result_id", ctx.resultId);

  const values: Record<string, ParamValue> = {};
  for (const r of valueRows ?? []) {
    values[r.parameter_id] = {
      numeric_value_si: r.numeric_value_si,
      numeric_value_conv: r.numeric_value_conv,
      text_value: r.text_value,
      select_value: r.select_value,
      flag: r.flag as ParamValue["flag"],
      is_blank: r.is_blank,
    };
  }

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
    .single();

  const { data: patient } = await admin
    .from("patients")
    .select("drm_id, first_name, last_name, sex, birthdate")
    .eq("id", ctx.patientId)
    .single();

  const session = await requireActiveStaff();
  const { data: medtech } = await admin
    .from("staff_profiles")
    .select("full_name, prc_license_kind, prc_license_no")
    .eq("id", session.user_id)
    .single();

  if (!tplRow || !svc || !visit || !patient) {
    return { ok: false, error: "Failed to load record for PDF render." };
  }

  // 5) Read control_no — set by the sequence default on insert, so always
  //    present by the time we get here.
  const { data: pre } = await admin
    .from("results")
    .select("control_no")
    .eq("id", ctx.resultId)
    .single();
  const controlNo = pre?.control_no ?? null;

  // 6) Render the PDF.
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
    finalisedAt: new Date(),
    medtech: medtech
      ? {
          full_name: medtech.full_name,
          prc_license_kind: medtech.prc_license_kind,
          prc_license_no: medtech.prc_license_no,
        }
      : null,
  };

  const pdf = await renderResultPdf(docInput);

  // 7) Upload to storage.
  const path = `${ctx.patientId}/${ctx.visitId}/${ctx.testRequestId}.pdf`;
  const { error: upErr } = await admin.storage
    .from("results")
    .upload(path, pdf, { contentType: "application/pdf", upsert: true });
  if (upErr) return { ok: false, error: `PDF upload failed: ${upErr.message}` };

  // 8) Mark the row finalised. The trigger advances test_requests.status when
  //    finalised_at transitions NULL → not-NULL.
  const { error: finErr } = await admin
    .from("results")
    .update({
      storage_path: path,
      file_size_bytes: pdf.byteLength,
      finalised_at: new Date().toISOString(),
      uploaded_by: session.user_id,
    })
    .eq("id", ctx.resultId);
  if (finErr) {
    await admin.storage.from("results").remove([path]);
    return { ok: false, error: `Finalise failed: ${finErr.message}` };
  }

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
      param_count: Object.keys(payload.values).length,
      abnormal_count: Object.values(values).filter((v) => v.flag).length,
      pdf_size_bytes: pdf.byteLength,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  // 9) Critical-value detection. For each param with a numeric value
  //    that crosses a configured critical threshold (per-band
  //    critical_low_si / critical_high_si), insert a critical_alerts
  //    row. The notification bell subscribes to inserts on this table
  //    so pathologists + admins are paged in real time.
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
  for (const param of visibleParams) {
    if (param.is_section_header) continue;
    const v = values[param.id];
    if (!v) continue;
    const range = pickRangeForPatient(param, patientSex, patientAgeMonths);
    const hit = detectCritical(param, range, v);
    if (hit) {
      alerts.push({
        result_id: ctx.resultId,
        test_request_id: testRequestId,
        parameter_id: param.id,
        parameter_name: param.parameter_name,
        direction: hit.direction,
        observed_value_si: hit.observed_si,
        threshold_si: hit.threshold_si,
        patient_id: ctx.patientId,
        patient_drm_id: patient.drm_id,
      });
    }
  }
  if (alerts.length > 0) {
    const { error: alertErr } = await admin
      .from("critical_alerts")
      .insert(alerts);
    if (alertErr) {
      // Don't fail the finalise — the PDF + result row are already
      // committed. Surface in the audit log so the gap is investigatable.
      console.error("critical_alerts insert failed", alertErr);
    } else {
      await audit({
        actor_id: session.user_id,
        actor_type: "staff",
        patient_id: ctx.patientId,
        action: "result.critical_value_detected",
        resource_type: "result",
        resource_id: ctx.resultId,
        metadata: {
          test_request_id: testRequestId,
          alerts: alerts.map((a) => ({
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
        id, status, visit_id,
        visits!inner ( id, patient_id )
      `,
    )
    .eq("id", testRequestId)
    .maybeSingle();

  if (!testRequest) return { ok: false, error: "Test not found." };
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

  // Insert results row — trigger auto-flips test_requests.status.
  const { data: resultRow, error: insertErr } = await admin
    .from("results")
    .insert({
      test_request_id: testRequest.id,
      storage_path: path,
      file_size_bytes: file.size,
      uploaded_by: session.user_id,
      notes: notes || null,
    })
    .select("id")
    .single();

  if (insertErr || !resultRow) {
    // Best-effort cleanup of the storage object so we don't orphan it.
    await admin.storage.from("results").remove([path]);
    return {
      ok: false,
      error: insertErr?.message ?? "Could not record the result.",
    };
  }

  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "result.uploaded",
    resource_type: "result",
    resource_id: resultRow.id,
    metadata: {
      test_request_id: testRequest.id,
      visit_id: visit.id,
      storage_path: path,
      file_size_bytes: file.size,
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

// Amend an already-released (or result_uploaded / ready_for_release)
// result. Snapshots the prior version into result_amendments and
// replaces results.storage_path with the new file. Original PDF is
// retained at its old path — never overwritten — so the audit trail
// can serve historical versions if needed later.
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
  const reason = (formData.get("reason") ?? "").toString().trim();
  if (reason.length < 5) {
    return {
      ok: false,
      error: "Please describe the reason for amendment (5+ characters).",
    };
  }
  if (reason.length > 2000) {
    return { ok: false, error: "Reason is too long (2000 char max)." };
  }

  const admin = createAdminClient();

  // Load the current result + parent test_request + visit context.
  const { data: result } = await admin
    .from("results")
    .select(
      "id, storage_path, file_size_bytes, uploaded_by, uploaded_at, notes, amendment_count, test_request_id",
    )
    .eq("test_request_id", testRequestId)
    .maybeSingle();
  if (!result || !result.storage_path) {
    return { ok: false, error: "No result on file to amend." };
  }

  const { data: testRow } = await admin
    .from("test_requests")
    .select("id, status, visit_id, visits!inner ( id, patient_id )")
    .eq("id", testRequestId)
    .maybeSingle();
  if (!testRow) return { ok: false, error: "Test not found." };
  const visit = Array.isArray(testRow.visits) ? testRow.visits[0] : testRow.visits;
  if (!visit) return { ok: false, error: "Visit not found." };

  // Allowed amendment statuses: anything past the medtech editing stage
  // — including released. Tests still in progress should be edited via
  // the normal workflow, not amended.
  const allowed = new Set([
    "result_uploaded",
    "ready_for_release",
    "released",
  ]);
  if (!allowed.has(testRow.status)) {
    return {
      ok: false,
      error: `Test status is ${testRow.status} — amend only applies after a result has been recorded.`,
    };
  }

  const nextSeq = (result.amendment_count ?? 0) + 1;
  const newPath = `${visit.patient_id}/${visit.id}/${testRow.id}.v${nextSeq + 1}.pdf`;

  // Upload new file BEFORE writing the snapshot, so a failed upload
  // doesn't leave a half-amended row.
  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadErr } = await admin.storage
    .from("results")
    .upload(newPath, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (uploadErr) {
    return { ok: false, error: `Upload failed: ${uploadErr.message}` };
  }

  // Snapshot the prior version into result_amendments.
  const { error: snapErr } = await admin.from("result_amendments").insert({
    result_id: result.id,
    test_request_id: testRow.id,
    prior_storage_path: result.storage_path,
    prior_uploaded_by: result.uploaded_by,
    prior_uploaded_at: result.uploaded_at,
    prior_file_size_bytes: result.file_size_bytes,
    prior_notes: result.notes,
    reason,
    amended_by: session.user_id,
    amendment_seq: nextSeq,
  });
  if (snapErr) {
    // Roll back the new upload so the storage doesn't orphan.
    await admin.storage.from("results").remove([newPath]);
    return { ok: false, error: snapErr.message };
  }

  // Swap the canonical row over to the new file.
  const nowIso = new Date().toISOString();
  const { error: updErr } = await admin
    .from("results")
    .update({
      storage_path: newPath,
      file_size_bytes: file.size,
      uploaded_by: session.user_id,
      uploaded_at: nowIso,
      amended_at: nowIso,
      amendment_count: nextSeq,
    })
    .eq("id", result.id);
  if (updErr) {
    // The snapshot row exists but pointer didn't move; surface the
    // error so the operator knows the state is inconsistent and can
    // retry.
    return { ok: false, error: updErr.message };
  }

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
      amendment_seq: nextSeq,
      reason,
      prior_storage_path: result.storage_path,
      new_storage_path: newPath,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  revalidatePath(`/staff/queue/${testRow.id}`);
  revalidatePath(`/staff/visits/${visit.id}`);
  return { ok: true };
}

export async function getResultDownloadUrl(
  testRequestId: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const session = await requireActiveStaff();
  const admin = createAdminClient();

  const { data: result } = await admin
    .from("results")
    .select("id, storage_path, test_request_id")
    .eq("test_request_id", testRequestId)
    .maybeSingle();

  if (!result) return { ok: false, error: "No result file." };
  if (!result.storage_path) {
    return { ok: false, error: "Result is still a draft — no PDF yet." };
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
