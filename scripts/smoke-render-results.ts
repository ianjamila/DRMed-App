/**
 * Phase 13 Slice 1 smoke test: renders the three seeded archetype templates
 * to /tmp/drmed-result-{layout}.pdf so we can eyeball the layout without
 * spinning up the dev server / logging in.
 *
 *   npm run smoke:results
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { renderResultPdf } from "../src/lib/results/render-pdf";
import { buildPreviewValues } from "../src/lib/results/preview-data";
import type {
  ResultDocumentInput,
  ResultLayout,
  TemplateParam,
} from "../src/lib/results/types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SERVICE_CODES = ["CBC_PC", "ROUTINE_PACKAGE", "URINALYSIS"];

async function renderOne(code: string) {
  const { data: svc } = await admin
    .from("services")
    .select("id, code, name")
    .eq("code", code)
    .maybeSingle();
  if (!svc) {
    console.warn(`! ${code}: service not found`);
    return;
  }

  const { data: tpl } = await admin
    .from("result_templates")
    .select("id, layout, header_notes, footer_notes")
    .eq("service_id", svc.id)
    .maybeSingle();
  if (!tpl) {
    console.warn(`! ${code}: template not found`);
    return;
  }

  const { data: paramRows } = await admin
    .from("result_template_params")
    .select(
      "id, sort_order, section, is_section_header, parameter_name, input_type, unit_si, unit_conv, ref_low_si, ref_high_si, ref_low_conv, ref_high_conv, gender, si_to_conv_factor, allowed_values, abnormal_values, placeholder",
    )
    .eq("template_id", tpl.id)
    .order("sort_order", { ascending: true });

  const params: TemplateParam[] = (paramRows ?? []).map((r) => ({
    id: r.id,
    sort_order: r.sort_order,
    section: r.section,
    is_section_header: r.is_section_header,
    parameter_name: r.parameter_name,
    input_type: r.input_type as TemplateParam["input_type"],
    unit_si: r.unit_si,
    unit_conv: r.unit_conv,
    ref_low_si: r.ref_low_si,
    ref_high_si: r.ref_high_si,
    ref_low_conv: r.ref_low_conv,
    ref_high_conv: r.ref_high_conv,
    gender: (r.gender ?? null) as TemplateParam["gender"],
    si_to_conv_factor: r.si_to_conv_factor,
    allowed_values: r.allowed_values,
    abnormal_values: r.abnormal_values,
    placeholder: r.placeholder,
  }));

  const input: ResultDocumentInput = {
    template: {
      layout: tpl.layout as ResultLayout,
      header_notes: tpl.header_notes,
      footer_notes: tpl.footer_notes,
    },
    params,
    values: buildPreviewValues(params),
    service: { code: svc.code, name: svc.name },
    patient: {
      drm_id: "DRM-PREVIEW",
      last_name: "DOE",
      first_name: "JANE",
      sex: "F",
      birthdate: "1985-04-12",
    },
    visit: { visit_number: "PREVIEW" },
    controlNo: null,
    finalisedAt: null,
    medtech: {
      full_name: "M. SMOKETEST, RMT",
      prc_license_kind: "RMT",
      prc_license_no: "0000000",
    },
    isPreview: true,
  };

  const pdf = await renderResultPdf(input);
  const out = `/tmp/drmed-result-${tpl.layout}.pdf`;
  writeFileSync(out, pdf);
  console.log(`✓ ${code} (${tpl.layout}, ${params.length} params) → ${out} (${pdf.byteLength} bytes)`);
}

async function main() {
  for (const code of SERVICE_CODES) {
    await renderOne(code);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
