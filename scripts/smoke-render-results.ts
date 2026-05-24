/**
 * Phase 13 Slice 1 smoke test: renders the three seeded archetype templates
 * to /tmp/drmed-result-{layout}.pdf so we can eyeball the layout without
 * spinning up the dev server / logging in.
 *
 *   npm run smoke:results
 */
import { writeFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { renderResultPdf } from "../src/lib/results/render-pdf";
import { buildPreviewValues } from "../src/lib/results/preview-data";
import { loadTemplateParams } from "../src/lib/results/loaders";
// NOTE: signatures.ts imports createAdminClient which has a `server-only`
// guard that tsx doesn't satisfy. We replicate the same logic inline here
// using the script's own admin client to avoid the module boundary error.
import type { SignatureBlockData } from "../src/lib/results/signatures";
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

async function loadSignatureForStaff(
  client: SupabaseClient<Database>,
  staffId: string,
): Promise<SignatureBlockData> {
  const { data, error } = await client
    .from("staff_profiles")
    .select("full_name, prc_license_no, prc_license_kind, signature_path")
    .eq("id", staffId)
    .single();
  if (error || !data) {
    throw new Error(
      `Failed to load staff_profile ${staffId}: ${error?.message ?? "row not found"}`,
    );
  }
  let png_bytes: Buffer | null = null;
  if (data.signature_path) {
    const { data: file, error: dlErr } = await client.storage
      .from("signatures")
      .download(data.signature_path);
    if (dlErr || !file) {
      throw new Error(
        `Failed to download signature ${data.signature_path}: ${dlErr?.message ?? "no file"}`,
      );
    }
    png_bytes = Buffer.from(await file.arrayBuffer());
  }
  return {
    full_name: data.full_name,
    prc_license_no: data.prc_license_no,
    prc_license_kind: data.prc_license_kind,
    png_bytes,
  };
}

async function loadConsultantSignaturesLocal(): Promise<{
  pathologist: SignatureBlockData;
  radiologist: SignatureBlockData;
  cardiologist: SignatureBlockData;
}> {
  const pId = process.env.CONSULTANT_PATHOLOGIST_STAFF_ID;
  const rId = process.env.CONSULTANT_RADIOLOGIST_STAFF_ID;
  const cId = process.env.CONSULTANT_CARDIOLOGIST_STAFF_ID;
  if (!pId || !rId || !cId) {
    throw new Error(
      "CONSULTANT_*_STAFF_ID env vars are required for smoke:results",
    );
  }
  return {
    pathologist: await loadSignatureForStaff(admin, pId),
    radiologist: await loadSignatureForStaff(admin, rId),
    cardiologist: await loadSignatureForStaff(admin, cId),
  };
}

const SERVICE_CODES = ["CBC_PC", "ROUTINE_PACKAGE", "URINALYSIS"];

async function renderOne(
  code: string,
  consultants: Awaited<ReturnType<typeof loadConsultantSignaturesLocal>>,
) {
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
    performer: consultants.pathologist,
    consultantPathologist: consultants.pathologist,
    isPreview: true,
  };

  const pdf = await renderResultPdf(input);
  const out = `/tmp/drmed-result-${tpl.layout}.pdf`;
  writeFileSync(out, pdf);
  console.log(`✓ ${code} (${tpl.layout}, ${params.length} params) → ${out} (${pdf.byteLength} bytes)`);
}

async function renderPackageSummary(
  consultants: Awaited<ReturnType<typeof loadConsultantSignaturesLocal>>,
) {
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
    performer: null,
    consultantPathologist: consultants.pathologist,
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
  const consultants = await loadConsultantSignaturesLocal();
  for (const code of SERVICE_CODES) {
    await renderOne(code, consultants);
  }
  await renderPackageSummary(consultants);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
