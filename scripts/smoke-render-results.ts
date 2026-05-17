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
import { loadTemplateParams } from "../src/lib/results/loaders";
import type {
  ResultDocumentInput,
  ResultLayout,
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

  const params = await loadTemplateParams(admin, tpl.id);

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

async function renderPackageSummary() {
  const coverSample: ResultDocumentInput = {
    template: {
      layout: "package_summary",
      header_notes: null,
      footer_notes: null,
    },
    params: [],
    values: {},
    service: {
      code: "EXECUTIVE_PACKAGE_STANDARD",
      name: "Executive Package - Standard",
    },
    patient: {
      drm_id: "DRM-PREVIEW",
      last_name: "DOE",
      first_name: "JANE",
      sex: "F",
      birthdate: "1985-04-12",
    },
    visit: { visit_number: "0007" },
    controlNo: 7777,
    finalisedAt: new Date(),
    medtech: null,
    packageSummary: {
      packageCode: "EXECUTIVE_PACKAGE_STANDARD",
      packageName: "Executive Package - Standard",
      components: [
        { code: "CBC_PC", name: "CBC + PC", status: "released" },
        { code: "URINALYSIS", name: "Urinalysis", status: "released" },
        { code: "FBS_RBS", name: "FBS/RBS", status: "released" },
        { code: "ECG", name: "12-Lead ECG", status: "released" },
        {
          code: "XRAY_CHEST_PA_LAT_ADULT",
          name: "Chest X-Ray PA/LAT (Adult)",
          status: "released",
        },
      ],
    },
  };
  const coverPdf = await renderResultPdf(coverSample);
  const out = "/tmp/drmed-package-summary.pdf";
  writeFileSync(out, coverPdf);
  console.log(
    `✓ package_summary cover → ${out} (${coverPdf.byteLength} bytes)`,
  );
}

async function main() {
  for (const code of SERVICE_CODES) {
    await renderOne(code);
  }
  await renderPackageSummary();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
