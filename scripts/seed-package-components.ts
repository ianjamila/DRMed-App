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
 * Idempotent: ON CONFLICT DO NOTHING on the (package, component) PK so
 * re-runs are safe. To remove a component from a package, edit the map and
 * delete the row via SQL or admin UI (Phase 14.x).
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

async function findServiceIdByCode(code: string): Promise<string | null> {
  const { data, error } = await admin
    .from("services")
    .select("id")
    .eq("code", code)
    .single();
  if (error || !data) return null;
  return data.id;
}

async function seedPackage(
  packageCode: string,
  componentCodes: string[],
): Promise<{ pkg: string; inserted: number; skipped: number }> {
  const packageId = await findServiceIdByCode(packageCode);
  if (!packageId) {
    throw new Error(`Service code ${packageCode} not found in services table`);
  }

  let inserted = 0;
  const skipped = 0;
  for (let i = 0; i < componentCodes.length; i++) {
    const componentCode = componentCodes[i];
    const componentId = await findServiceIdByCode(componentCode);
    if (!componentId) {
      throw new Error(
        `Component code ${componentCode} (referenced by ${packageCode}) not found in services table`,
      );
    }
    const { error } = await admin
      .from("package_components")
      .upsert(
        {
          package_service_id: packageId,
          component_service_id: componentId,
          sort_order: i,
        },
        { onConflict: "package_service_id,component_service_id" },
      );
    if (error) {
      throw new Error(
        `Failed to upsert ${packageCode} → ${componentCode}: ${error.message}`,
      );
    }
    inserted++;
  }
  return { pkg: packageCode, inserted, skipped };
}

async function main() {
  console.log(
    `Seeding package_components against ${SUPABASE_URL}...`,
  );
  let totalRows = 0;
  for (const [pkgCode, componentCodes] of Object.entries(PACKAGE_COMPONENTS)) {
    const { pkg, inserted } = await seedPackage(pkgCode, componentCodes);
    console.log(`✓ ${pkg}: ${inserted} components`);
    totalRows += inserted;
  }
  console.log(
    `Done. ${totalRows} package_components rows across ${Object.keys(PACKAGE_COMPONENTS).length} packages.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
