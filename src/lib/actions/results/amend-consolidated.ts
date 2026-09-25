import "server-only";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit/log";
import { translatePgError } from "@/lib/accounting/pg-errors";
import { sectionsForRole } from "@/lib/auth/role-sections";
import { isSectionAllowed } from "@/lib/auth/section-access";
import { renderResultPdf } from "@/lib/results/render-pdf";
import { loadResultDocumentInput, loadTemplateParams } from "@/lib/results/loaders";
import { calculateAgeMonths, normalisePatientSex } from "@/lib/results/types";
import { countValueChanges, isEditableStatus, validateEditReason } from "@/lib/results/result-edit";
import { buildValueRows, detectCrossings, valueRowsToDocValues } from "@/lib/results/value-rows";
import { auditAlertChanges, commitResultEdit } from "@/lib/actions/results/result-edit-core";

// Editing a FINISHED combined report (chemistry): one results row + one PDF
// shared by every member test. Owner decisions 2026-09-24: any medtech in the
// report's section may edit (no claim needed), the new PDF signs as the
// editor, and there is no patient-facing "amended" marker — the PDF is
// replaced and staff see the history.

export interface AmendConsolidatedInput {
  resultId: string;
  expectedAmendmentCount: number;
  reason: string;
  values: Array<{
    parameter_id: string;
    numeric_value_si: number | null;
    numeric_value_conv: number | null;
  }>;
}

export type AmendConsolidatedResult =
  | { ok: true; data: { amendmentSeq: number } }
  | { ok: false; error: string; stale?: boolean };

type One<T> = T | T[] | null;
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

interface MemberRow {
  test_request_id: string;
  test_requests: One<{
    id: string;
    status: string;
    deleted_at: string | null;
    visit_id: string;
    requested_at: string;
    services: One<{ id: string; section: string | null }>;
    visits: One<{ id: string; deleted_at: string | null; patient_id: string }>;
  }>;
}

export async function amendConsolidatedReport(
  input: AmendConsolidatedInput,
): Promise<AmendConsolidatedResult> {
  const session = await requireActiveStaff();
  const allowedSections = sectionsForRole(session.role);
  // [] is a DENY (reception), never "no filter".
  if (allowedSections !== null && allowedSections.length === 0) {
    return { ok: false, error: "Your role can't edit lab results." };
  }

  const reasonCheck = validateEditReason(input.reason);
  if (!reasonCheck.ok) return reasonCheck;
  const reason = reasonCheck.reason;

  const admin = createAdminClient();

  // 1) The result.
  const { data: result } = await admin
    .from("results")
    .select(
      "id, storage_path, generation_kind, finalised_at, amendment_count, report_group_id",
    )
    .eq("id", input.resultId)
    .maybeSingle();
  if (!result || !result.storage_path || !result.finalised_at) {
    return { ok: false, error: "This report has no finished PDF to edit." };
  }
  if (result.generation_kind !== "structured" || !result.report_group_id) {
    return { ok: false, error: "This result is not a combined report." };
  }

  // 2) Every member, deleted ones included [R3]: the section rule covers
  //    every linked test (a deleted member's values still sit on the shared
  //    result); the finished rule and "at least one" cover LIVE tests only.
  const { data: memberRaw } = await admin
    .from("result_test_requests")
    .select(
      "test_request_id, test_requests!inner(id, status, deleted_at, visit_id, requested_at, services!inner(id, section), visits!inner(id, deleted_at, patient_id))",
    )
    .eq("result_id", result.id)
    .returns<MemberRow[]>();
  const members = (memberRaw ?? [])
    .map((m) => one(m.test_requests))
    .filter((t): t is NonNullable<typeof t> => t != null);
  if (members.some((t) => !isSectionAllowed(allowedSections, one(t.services)?.section ?? null))) {
    return { ok: false, error: "This report is outside the sections you can edit." };
  }
  const live = members
    .filter((t) => t.deleted_at == null && one(t.visits)?.deleted_at == null)
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at) || a.id.localeCompare(b.id));
  if (live.length === 0) {
    return { ok: false, error: "Every test on this report was deleted." };
  }
  if (live.some((t) => !isEditableStatus(t.status))) {
    return { ok: false, error: "A test on this report is not finished yet." };
  }
  const visitIds = new Set(live.map((t) => t.visit_id));
  if (visitIds.size !== 1) {
    return { ok: false, error: "This report's tests don't belong to one visit." };
  }
  const anchor = live[0];
  const patientId = one(anchor.visits)!.patient_id;

  // The same rule, asked of the database as the signed-in user — the page
  // shows no Edit button when this is false, so a form is never submitted
  // over values the editor could not read.
  const supabase = await createClient();
  const { data: canRead, error: canReadErr } = await supabase.rpc(
    "staff_can_read_finished_result",
    { p_result_id: result.id },
  );
  if (canReadErr) return { ok: false, error: translatePgError(canReadErr) };
  if (!canRead) {
    return { ok: false, error: "This report is outside the sections you can edit." };
  }

  // Fast answer for a stale form; result_edit_commit is the real check.
  if (result.amendment_count !== input.expectedAmendmentCount) {
    return { ok: false, error: translatePgError({ code: "P0065" }), stale: true };
  }

  // 3) Template + which fields this report may hold: the parameters the live
  //    members' services enable, plus any parameter already holding a value
  //    (a mapping edited since finalise must not strand a printed value).
  const { data: template } = await admin
    .from("result_templates")
    .select("id")
    .eq("report_group_id", result.report_group_id)
    .eq("is_active", true)
    .maybeSingle();
  if (!template) {
    return { ok: false, error: "No active template is configured for this report group." };
  }
  const templateParams = await loadTemplateParams(admin, template.id);
  const paramsById = new Map(templateParams.map((p) => [p.id, p]));
  const liveServiceIds = live.map((t) => one(t.services)?.id ?? "");
  const { data: mapRows } =
    templateParams.length > 0
      ? await admin
          .from("report_group_service_params")
          .select("service_id, parameter_id")
          .in("parameter_id", templateParams.map((p) => p.id))
          .in("service_id", liveServiceIds)
      : { data: [] };
  const { data: storedRows } = await admin
    .from("result_values")
    .select("parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, is_blank")
    .eq("result_id", result.id);
  const allowed = new Set<string>([
    ...(mapRows ?? []).map((m) => m.parameter_id),
    ...(storedRows ?? []).map((r) => r.parameter_id),
  ]);

  if (input.values.length === 0) {
    return { ok: false, error: "Enter at least one value." };
  }
  if (input.values.some((v) => !allowed.has(v.parameter_id) || !paramsById.has(v.parameter_id))) {
    return {
      ok: false,
      error:
        "The fields for this report changed since the form was opened. Reload the page and make your change again.",
      stale: true,
    };
  }
  if (new Set(input.values.map((v) => v.parameter_id)).size !== input.values.length) {
    return { ok: false, error: "A field was sent twice. Reload the page and try again." };
  }

  // 4) Flags and crossings on the ORIGINAL report date: an edit keeps the
  //    report's date, so the patient's age band cannot move.
  const reportDate = new Date(result.finalised_at);
  const { data: pat } = await admin
    .from("patients")
    .select("sex, birthdate")
    .eq("id", patientId)
    .single();
  const patientForRanges = {
    sex: normalisePatientSex(pat?.sex ?? null),
    ageMonths: calculateAgeMonths(pat?.birthdate ?? null, reportDate),
  };
  const rows = buildValueRows(
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

  // Each crossing is filed under the member whose service enables the
  // parameter; a stored-only parameter falls back to the anchor.
  const serviceToTest = new Map(live.map((t) => [one(t.services)?.id ?? "", t.id]));
  const paramToTest = new Map<string, string>();
  for (const m of mapRows ?? []) {
    const trId = serviceToTest.get(m.service_id);
    if (trId && !paramToTest.has(m.parameter_id)) paramToTest.set(m.parameter_id, trId);
  }
  const alerts = detectCrossings(
    rows,
    paramsById,
    patientForRanges,
    (paramId) => paramToTest.get(paramId) ?? anchor.id,
  );

  // 5) Render the new PDF from the new values, signed by the editor, with the
  //    original control number and date — then commit.
  const docInput = await loadResultDocumentInput(result.id, {
    valuesOverride: valueRowsToDocValues(rows),
    signerStaffId: session.user_id,
  });
  const pdf = await renderResultPdf(docInput);
  const committed = await commitResultEdit({
    resultId: result.id,
    expectedAmendmentCount: input.expectedAmendmentCount,
    currentStoragePath: result.storage_path,
    editorId: session.user_id,
    reason,
    anchorTestRequestId: anchor.id,
    pdf,
    values: rows,
    newImage: null,
    alerts,
  });
  if (!committed.ok) {
    return {
      ok: false,
      error: committed.error,
      stale: committed.error === translatePgError({ code: "P0065" }),
    };
  }

  // 6) Audit.
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const ua = h.get("user-agent");
  const memberIds = live.map((t) => t.id);
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    patient_id: patientId,
    action: "result.amended",
    resource_type: "result",
    resource_id: result.id,
    metadata: {
      test_request_ids: memberIds,
      report_group_id: result.report_group_id,
      visit_id: anchor.visit_id,
      amendment_seq: committed.data.amendmentSeq,
      reason,
      prior_storage_path: committed.data.priorStoragePath,
      new_storage_path: committed.data.newStoragePath,
      value_change_count: countValueChanges(
        new Map((storedRows ?? []).map((r) => [r.parameter_id, r])),
        new Map(rows.map((r) => [r.parameter_id, r])),
      ),
      replayed: committed.data.replayed,
    },
    ip_address: ip,
    user_agent: ua,
  });
  await auditAlertChanges(committed.data, {
    actorId: session.user_id,
    patientId,
    resultId: result.id,
    testRequestIds: memberIds,
    ip,
    ua,
  });

  revalidatePath("/staff/queue");
  revalidatePath(`/staff/queue/consolidated/${anchor.visit_id}/${result.report_group_id}`);
  revalidatePath(`/staff/visits/${anchor.visit_id}`);
  revalidatePath("/staff/results");
  return { ok: true, data: { amendmentSeq: committed.data.amendmentSeq } };
}
