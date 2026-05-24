// Shared template-param loading. Used by:
//   - the medtech form page (queue/[id]/page.tsx)
//   - the structured-result Server Actions (queue/[id]/actions.ts)
//   - the admin preview route handler
//   - the smoke-test script
//
// Returns TemplateParam[] with `ranges` populated from the age-band table
// added in migration 0009. A second query keeps the type assertions simple
// vs. trying to use a PostgREST embedded select.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { ParamRange, PatientSex, TemplateParam } from "./types";

type AnyClient = SupabaseClient<Database>;

const PARAM_COLS =
  "id, sort_order, section, is_section_header, parameter_name, input_type, unit_si, unit_conv, ref_low_si, ref_high_si, ref_low_conv, ref_high_conv, gender, si_to_conv_factor, allowed_values, abnormal_values, placeholder";

const RANGE_COLS =
  "id, parameter_id, age_min_months, age_max_months, gender, band_label, ref_low_si, ref_high_si, ref_low_conv, ref_high_conv, critical_low_si, critical_high_si, critical_low_conv, critical_high_conv, sort_order";

export async function loadTemplateParams(
  client: AnyClient,
  templateId: string,
): Promise<TemplateParam[]> {
  const { data: paramRows } = await client
    .from("result_template_params")
    .select(PARAM_COLS)
    .eq("template_id", templateId)
    .order("sort_order", { ascending: true });

  const params = paramRows ?? [];
  if (params.length === 0) return [];

  const { data: rangeRows } = await client
    .from("result_template_param_ranges")
    .select(RANGE_COLS)
    .in(
      "parameter_id",
      params.map((p) => p.id),
    )
    .order("sort_order", { ascending: true });

  const rangesByParam = new Map<string, ParamRange[]>();
  for (const r of rangeRows ?? []) {
    const arr = rangesByParam.get(r.parameter_id) ?? [];
    arr.push({
      id: r.id,
      age_min_months: r.age_min_months,
      age_max_months: r.age_max_months,
      gender: (r.gender ?? null) as PatientSex,
      band_label: r.band_label,
      ref_low_si: r.ref_low_si,
      ref_high_si: r.ref_high_si,
      ref_low_conv: r.ref_low_conv,
      ref_high_conv: r.ref_high_conv,
      critical_low_si: r.critical_low_si,
      critical_high_si: r.critical_high_si,
      critical_low_conv: r.critical_low_conv,
      critical_high_conv: r.critical_high_conv,
      sort_order: r.sort_order,
    });
    rangesByParam.set(r.parameter_id, arr);
  }

  return params.map((p) => ({
    id: p.id,
    sort_order: p.sort_order,
    section: p.section,
    is_section_header: p.is_section_header,
    parameter_name: p.parameter_name,
    input_type: p.input_type as TemplateParam["input_type"],
    unit_si: p.unit_si,
    unit_conv: p.unit_conv,
    ref_low_si: p.ref_low_si,
    ref_high_si: p.ref_high_si,
    ref_low_conv: p.ref_low_conv,
    ref_high_conv: p.ref_high_conv,
    gender: (p.gender ?? null) as PatientSex,
    si_to_conv_factor: p.si_to_conv_factor,
    allowed_values: p.allowed_values,
    abnormal_values: p.abnormal_values,
    placeholder: p.placeholder,
    ranges: rangesByParam.get(p.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// loadResultDocumentInput
// ---------------------------------------------------------------------------

import { createAdminClient } from "@/lib/supabase/admin";
import { loadConsultantSignatures, resolvePerformer } from "./signatures";
import type { ResultDocumentInput, ResultLayout } from "./types";

// Explicit shape for the deeply-nested junction query. Supabase's TypeScript
// inference breaks on string-concatenated selects, so we cast to this type.
interface LinkedRow {
  test_requests: {
    id: string;
    visit_id: string;
    service_id: string;
    services: {
      id: string;
      code: string;
      name: string;
      kind: string | null;
      report_group_id: string | null;
    };
    visits: {
      id: string;
      visit_number: string;
      patients: {
        drm_id: string;
        last_name: string;
        first_name: string;
        sex: string | null;
        birthdate: string | null;
      };
    };
  };
}

interface TemplateRow {
  id: string;
  layout: string;
  header_notes: string | null;
  footer_notes: string | null;
}

/**
 * Builds a complete ResultDocumentInput for a given results.id. Handles
 * both single-service results (results.report_group_id is null) and
 * consolidated group results (results.report_group_id is set).
 *
 * Used by:
 *   - finaliseConsolidatedReport (Task 6's consolidated-form action)
 *   - any future caller that needs a one-stop render-input loader
 *
 * The three existing inline builders (preview route, queue actions,
 * portal cover action) are NOT replaced by this helper in this task —
 * that's a follow-up DRY refactor.
 */
export async function loadResultDocumentInput(
  resultId: string,
): Promise<ResultDocumentInput> {
  const admin = createAdminClient();

  const { data: results, error: rErr } = await admin
    .from("results")
    .select("id, control_no, finalised_at, finalised_by_staff_id, report_group_id, notes")
    .eq("id", resultId)
    .single();
  if (rErr || !results) {
    throw new Error(
      `loadResultDocumentInput: results ${resultId} not found`,
    );
  }

  // Junction → test_requests → services → visits → patients.
  // The select string is a single literal to preserve PostgREST type-narrowing;
  // we still cast to LinkedRow[] below because the nested shape is too complex
  // for Supabase's generic inference to resolve correctly.
  const { data: linkedRaw, error: lErr } = await admin
    .from("result_test_requests")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- complex nested select; shape asserted via LinkedRow
    .select("test_requests!inner(id, visit_id, service_id, services!inner(id, code, name, kind, report_group_id), visits!inner(id, visit_number, patients!inner(drm_id, last_name, first_name, sex, birthdate)))" as any)
    .eq("result_id", resultId);
  if (lErr || !linkedRaw || linkedRaw.length === 0) {
    throw new Error(
      `loadResultDocumentInput: no junction rows for results ${resultId}`,
    );
  }
  const linked = linkedRaw as unknown as LinkedRow[];

  // All linked test_requests share the same visit + patient.
  const first = linked[0].test_requests;
  const patient = first.visits.patients;
  const visit = first.visits;

  // Template lookup: keyed by report_group_id when grouped, else by service_id.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic query builder
  let templateQuery: any = admin
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes")
    .eq("is_active", true);
  if (results.report_group_id) {
    templateQuery = templateQuery.eq("report_group_id", results.report_group_id);
  } else {
    templateQuery = templateQuery.eq("service_id", first.services.id);
  }
  const { data: templateRaw, error: tErr } = await templateQuery.maybeSingle();
  if (tErr || !templateRaw) {
    throw new Error(
      `loadResultDocumentInput: no active template for results ${resultId}`,
    );
  }
  const template = templateRaw as TemplateRow;

  const templateParams = await loadTemplateParams(admin, template.id);

  const { data: valueRows } = await admin
    .from("result_values")
    .select("parameter_id, numeric_value_si, numeric_value_conv, text_value, select_value, flag, is_blank")
    .eq("result_id", resultId);

  const values: ResultDocumentInput["values"] = {};
  for (const v of valueRows ?? []) {
    values[v.parameter_id] = {
      numeric_value_si: v.numeric_value_si,
      numeric_value_conv: v.numeric_value_conv,
      text_value: v.text_value,
      select_value: v.select_value,
      flag: v.flag as "H" | "L" | "A" | null,
      is_blank: v.is_blank,
    };
  }

  // Group payload — only populated when grouped.
  let reportGroup: ResultDocumentInput["reportGroup"] | undefined;
  if (results.report_group_id) {
    const { data: group } = await admin
      .from("report_groups")
      .select("code, name")
      .eq("id", results.report_group_id)
      .single();
    reportGroup = {
      code: group?.code ?? "",
      name: group?.name ?? "",
      orderedTests: linked.map((l) => ({
        code: l.test_requests.services.code,
        name: l.test_requests.services.name,
      })),
    };
  }

  // Signatures
  const consultants = await loadConsultantSignatures();
  const performer = await resolvePerformer({
    service: {
      code: first.services.code,
      kind: first.services.kind ?? null,
    },
    finalisedByStaffId: results.finalised_by_staff_id,
  });

  return {
    template: {
      layout: template.layout as ResultLayout,
      header_notes: template.header_notes,
      footer_notes: template.footer_notes,
    },
    params: templateParams,
    values,
    service: reportGroup
      ? undefined
      : { code: first.services.code, name: first.services.name },
    reportGroup,
    patient: {
      drm_id: patient.drm_id,
      last_name: patient.last_name,
      first_name: patient.first_name,
      sex: patient.sex as "F" | "M" | null,
      birthdate: patient.birthdate,
    },
    visit: { visit_number: visit.visit_number },
    controlNo: results.control_no,
    finalisedAt: results.finalised_at ? new Date(results.finalised_at) : null,
    performer,
    consultantPathologist: consultants.pathologist,
    medtech: performer
      ? {
          full_name: performer.full_name,
          prc_license_kind: performer.prc_license_kind,
          prc_license_no: performer.prc_license_no,
        }
      : null,
  };
}
