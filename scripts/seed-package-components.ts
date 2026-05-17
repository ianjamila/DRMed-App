/**
 * Seeds the `package_components` table from a hardcoded composition map.
 * One row per (package, component) pair.
 *
 *   npm run seed:package-components
 *
 * Run order:
 *   npm run seed:services            (creates the service codes we reference)
 *   npm run seed:package-components  (this script)
 *   npm run seed:templates           (templates per component service)
 *
 * Idempotent: re-runs safely overwrite `sort_order` to match the current map
 * via ON CONFLICT DO UPDATE (other columns are untouched since they aren't
 * in the upsert payload). Removing a component from a package requires
 * deleting the row via SQL or the (future) admin UI.
 *
 * Sourced from PACKAGE_PANELS in scripts/seed-result-templates.ts, minus the
 * INCLUDED("CBC") free-text placeholders — those are replaced by real
 * component services here.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { requireLocalOrExplicitProd } from "./lib/env-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

requireLocalOrExplicitProd("seed:package-components");

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Component codes in display / consolidated-PDF order.
const PACKAGE_COMPONENTS: Record<string, string[]> = {
  STANDARD_CHEMISTRY: [
    "FBS_RBS", "BUN", "CREATININE", "BUA_URIC_ACID",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
  ],
  BASIC_PACKAGE: ["CBC_PC", "URINALYSIS"],
  ROUTINE_PACKAGE: ["CBC_PC", "URINALYSIS", "FBS_RBS"],
  ANNUAL_PHYSICAL_EXAM: [
    "CBC_PC", "URINALYSIS",
    "FBS_RBS", "CHOLESTEROL", "CREATININE", "BUN",
    "XRAY_CHEST_PA_LAT_ADULT", "ECG",
  ],
  EXECUTIVE_PACKAGE_STANDARD: [
    "CBC_PC", "URINALYSIS",
    "FBS_RBS", "BUN", "CREATININE",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
    "ECG", "XRAY_CHEST_PA_LAT_ADULT",
  ],
  EXECUTIVE_PACKAGE_COMPREHENSIVE: [
    "CBC_PC", "URINALYSIS",
    "FBS_RBS", "BUN", "CREATININE",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
    "HBA1C", "BUA_URIC_ACID",
    "FECALYSIS", "ULTRASOUND_WHOLE_ABDOMEN",
    "ECG", "XRAY_CHEST_PA_LAT_ADULT",
  ],
  EXECUTIVE_PACKAGE_DELUXE_MEN_S: [
    "CBC_PC", "URINALYSIS",
    "FBS_RBS", "BUN", "CREATININE",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
    "HBA1C", "BUA_URIC_ACID", "PSA",
    "FECALYSIS", "ULTRASOUND_WHOLE_ABDOMEN",
    "ECG", "XRAY_CHEST_PA_LAT_ADULT",
  ],
  EXECUTIVE_PACKAGE_DELUXE_WOMEN_S: [
    "CBC_PC", "URINALYSIS",
    "FBS_RBS", "BUN", "CREATININE",
    "CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL",
    "SGPT_ALT", "SGOT_AST",
    "HBA1C", "BUA_URIC_ACID",
    "PAP_SMEAR", "FECALYSIS", "ULTRASOUND_WHOLE_ABDOMEN",
    "ECG", "XRAY_CHEST_PA_LAT_ADULT",
  ],
  PRE_EMPLOYMENT_PACKAGE: ["CBC_PC", "URINALYSIS", "XRAY_CHEST_PA_LAT_ADULT"],
  PREGNANCY_CARE_PACKAGE: [
    "CBC_PC", "URINALYSIS", "HBSAG_SCREENING",
    "BLOOD_TYPING_W_RH_FACTOR", "PREGNANCY_TEST",
  ],
  DIABETIC_HEALTH_PACKAGE: [
    "FBS_RBS", "HBA1C", "CHOLESTEROL", "TRIGLYCERIDES", "CREATININE",
  ],
  KIDNEY_FUNCTION_PACKAGE: [
    "BUN", "CREATININE", "BUA_URIC_ACID", "URINALYSIS", "URINE_PROTEIN",
  ],
  LIVER_FUNCTION_PACKAGE: [
    "SGPT_ALT", "SGOT_AST", "BILIRUBIN", "ALP", "TOTAL_PROTEIN", "ALBUMIN",
  ],
  LIPID_PROFILE_PACKAGE: ["CHOLESTEROL", "TRIGLYCERIDES", "HDL_LDL_VLDL"],
  THYROID_HEALTH_PACKAGE: ["TSH", "FT3", "FT4"],
  IRON_DEFICIENCY_PACKAGE: ["FERRITIN", "TIBC_IRON", "CBC_PC"],
  DENGUE_PACKAGE: ["DENGUE_NS1", "DENGUE_DUO"],
};

async function main() {
  console.log(
    `Seeding package_components against ${SUPABASE_URL}...`,
  );

  // 1. Collect all codes (packages + components) into a single set.
  const codes = new Set<string>();
  for (const [pkgCode, componentCodes] of Object.entries(PACKAGE_COMPONENTS)) {
    codes.add(pkgCode);
    componentCodes.forEach((c) => codes.add(c));
  }

  // 2. Single batch lookup of all service codes.
  const { data, error } = await admin
    .from("services")
    .select("id, code")
    .in("code", Array.from(codes));
  if (error) {
    console.error(`Failed to look up service codes: ${error.message}`);
    process.exit(1);
  }
  const codeToId = new Map((data ?? []).map((s) => [s.code, s.id]));

  // 3. Validate all codes present — list ALL missing codes at once.
  const missing = Array.from(codes).filter((c) => !codeToId.has(c));
  if (missing.length > 0) {
    console.error(
      `Missing service codes (run npm run seed:services first?):\n  - ${missing.join("\n  - ")}`,
    );
    process.exit(1);
  }

  // 4. Per-package: build row array + single batch upsert.
  let totalRows = 0;
  for (const [pkgCode, componentCodes] of Object.entries(PACKAGE_COMPONENTS)) {
    const packageId = codeToId.get(pkgCode)!;
    const rows = componentCodes.map((cmpCode, i) => ({
      package_service_id: packageId,
      component_service_id: codeToId.get(cmpCode)!,
      sort_order: i,
    }));
    const { error: upErr } = await admin
      .from("package_components")
      .upsert(rows, { onConflict: "package_service_id,component_service_id" });
    if (upErr) {
      console.error(`Failed to upsert ${pkgCode}: ${upErr.message}`);
      process.exit(1);
    }
    console.log(`✓ ${pkgCode}: ${rows.length} components`);
    totalRows += rows.length;
  }

  console.log(
    `Done. ${totalRows} package_components rows across ${Object.keys(PACKAGE_COMPONENTS).length} packages.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
