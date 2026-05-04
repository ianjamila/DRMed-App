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
  "id, parameter_id, age_min_months, age_max_months, gender, band_label, ref_low_si, ref_high_si, ref_low_conv, ref_high_conv, sort_order";

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
