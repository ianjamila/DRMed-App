/**
 * Seeds the three archetype result templates so Phase 13 can be exercised
 * end-to-end without admin first creating templates by hand.
 *
 *   npm run seed:templates
 *
 * Idempotent: removes the existing template + params for the target service
 * codes before re-inserting, so seed edits are safe to re-run. Real production
 * templates are built / refined via the admin CRUD UI in a later phase.
 *
 * Templates seeded:
 *   - CBC_PC          → 'simple'        (CBC + Differential + RBC indices)
 *   - ROUTINE_PACKAGE → 'dual_unit'     (12-test chemistry panel, SI + Conv)
 *   - URINALYSIS      → 'multi_section' (Physical + Chemical + Microscopic)
 *
 * Reference: drmed.ph LAB RESULTS FORM Sheet
 *   1UZrH4EYAkXiu5gMMQUJoAddpSqqwTmfrk1k8ykaqikQ
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Layout = "simple" | "dual_unit" | "multi_section" | "imaging_report";
type InputType = "numeric" | "free_text" | "select";

interface RangeSeed {
  band_label: string;
  age_min_months?: number;
  age_max_months?: number;
  gender?: "F" | "M";
  ref_low_si?: number;
  ref_high_si?: number;
  ref_low_conv?: number;
  ref_high_conv?: number;
}

interface ParamSeed {
  parameter_name: string;
  input_type: InputType;
  section?: string;
  is_section_header?: boolean;
  unit_si?: string;
  unit_conv?: string;
  ref_low_si?: number;
  ref_high_si?: number;
  ref_low_conv?: number;
  ref_high_conv?: number;
  gender?: "F" | "M";
  si_to_conv_factor?: number;
  allowed_values?: string[];
  abnormal_values?: string[];
  placeholder?: string;
  // Optional age-banded ranges that override the param defaults for matching
  // patients. The picker prefers explicit-gender bands first, then null-gender
  // bands; falls back to ref_*_si / ref_*_conv when no band matches.
  ranges?: RangeSeed[];
}

interface TemplateSeed {
  service_code: string;
  layout: Layout;
  header_notes?: string;
  footer_notes?: string;
  params: ParamSeed[];
}

// ---------------------------------------------------------------------------
// CBC + Differential + RBC Indices  →  'simple'
// ---------------------------------------------------------------------------
const cbc: TemplateSeed = {
  service_code: "CBC_PC",
  layout: "simple",
  params: [
    {
      parameter_name: "WBC Count",
      input_type: "numeric",
      unit_si: "x 10^9/L",
      ref_low_si: 5,
      ref_high_si: 10,
    },
    {
      parameter_name: "Differential Count",
      input_type: "free_text",
      is_section_header: true,
    },
    { parameter_name: "Segmenters",  input_type: "numeric", unit_si: "%", ref_low_si: 55, ref_high_si: 70 },
    { parameter_name: "Lymphocytes", input_type: "numeric", unit_si: "%", ref_low_si: 20, ref_high_si: 40 },
    { parameter_name: "Monocytes",   input_type: "numeric", unit_si: "%", ref_low_si: 2,  ref_high_si: 8 },
    { parameter_name: "Eosinophils", input_type: "numeric", unit_si: "%", ref_low_si: 1,  ref_high_si: 4 },
    { parameter_name: "Basophils",   input_type: "numeric", unit_si: "%", ref_low_si: 0,  ref_high_si: 1 },

    {
      parameter_name: "RBC Indices",
      input_type: "free_text",
      is_section_header: true,
      section: "RBC",
    },
    // Gender-specific ranges → two rows with the same parameter_name; the
    // form shows whichever row matches the patient's `sex`. Each gendered row
    // also carries age-banded ranges (Neonate / Infant / Pediatric) that
    // override the adult default for younger patients — neonatal Hgb is
    // dramatically higher (14–24) than adult, and adult thresholds would
    // mis-flag normal newborns. Sources: WHO + Nelson Pediatric Reference.
    {
      parameter_name: "Hemoglobin", input_type: "numeric", section: "RBC", unit_si: "g/dL",
      gender: "F", ref_low_si: 12, ref_high_si: 16,
      ranges: [
        { band_label: "Neonate (0–1 mo)",    age_min_months: 0,   age_max_months: 1,   ref_low_si: 14,  ref_high_si: 24 },
        { band_label: "Infant (1–24 mo)",    age_min_months: 1,   age_max_months: 24,  ref_low_si: 9.5, ref_high_si: 13.5 },
        { band_label: "Pediatric (2–13 y)",  age_min_months: 24,  age_max_months: 156, ref_low_si: 11,  ref_high_si: 14.5 },
      ],
    },
    {
      parameter_name: "Hemoglobin", input_type: "numeric", section: "RBC", unit_si: "g/dL",
      gender: "M", ref_low_si: 14, ref_high_si: 18,
      ranges: [
        { band_label: "Neonate (0–1 mo)",    age_min_months: 0,   age_max_months: 1,   ref_low_si: 14,  ref_high_si: 24 },
        { band_label: "Infant (1–24 mo)",    age_min_months: 1,   age_max_months: 24,  ref_low_si: 9.5, ref_high_si: 13.5 },
        { band_label: "Pediatric (2–13 y)",  age_min_months: 24,  age_max_months: 156, ref_low_si: 11,  ref_high_si: 14.5 },
      ],
    },
    {
      parameter_name: "Hematocrit", input_type: "numeric", section: "RBC", unit_si: "%",
      gender: "F", ref_low_si: 37, ref_high_si: 47,
      ranges: [
        { band_label: "Neonate (0–1 mo)",    age_min_months: 0,   age_max_months: 1,   ref_low_si: 42,  ref_high_si: 65 },
        { band_label: "Infant (1–24 mo)",    age_min_months: 1,   age_max_months: 24,  ref_low_si: 28,  ref_high_si: 41 },
        { band_label: "Pediatric (2–13 y)",  age_min_months: 24,  age_max_months: 156, ref_low_si: 33,  ref_high_si: 43 },
      ],
    },
    {
      parameter_name: "Hematocrit", input_type: "numeric", section: "RBC", unit_si: "%",
      gender: "M", ref_low_si: 42, ref_high_si: 52,
      ranges: [
        { band_label: "Neonate (0–1 mo)",    age_min_months: 0,   age_max_months: 1,   ref_low_si: 42,  ref_high_si: 65 },
        { band_label: "Infant (1–24 mo)",    age_min_months: 1,   age_max_months: 24,  ref_low_si: 28,  ref_high_si: 41 },
        { band_label: "Pediatric (2–13 y)",  age_min_months: 24,  age_max_months: 156, ref_low_si: 33,  ref_high_si: 43 },
      ],
    },
    { parameter_name: "RBC Count",    input_type: "numeric", section: "RBC", unit_si: "x 10^12/L", ref_low_si: 4.0, ref_high_si: 5.3 },
    { parameter_name: "MCV",          input_type: "numeric", section: "RBC", unit_si: "fL",        ref_low_si: 80,  ref_high_si: 99 },
    { parameter_name: "MCH",          input_type: "numeric", section: "RBC", unit_si: "pg",        ref_low_si: 26,  ref_high_si: 32 },
    { parameter_name: "MCHC",         input_type: "numeric", section: "RBC", unit_si: "g/dL",      ref_low_si: 32,  ref_high_si: 36 },
    { parameter_name: "Platelet Count", input_type: "numeric", section: "RBC", unit_si: "x 10^9/L", ref_low_si: 150, ref_high_si: 450 },

    { parameter_name: "Remarks", input_type: "free_text", placeholder: "(optional)" },
  ],
};

// ---------------------------------------------------------------------------
// Chemistry panel  →  'dual_unit'
// Attached to ROUTINE_PACKAGE because that's what the reference Sheet's
// chemistry tab matches. Standalone chemistry services (FBS_RBS, BUN, etc.)
// can have their own one-row templates added via the admin UI later.
// ---------------------------------------------------------------------------
const chem: TemplateSeed = {
  service_code: "ROUTINE_PACKAGE",
  layout: "dual_unit",
  params: [
    {
      parameter_name: "FBS",
      input_type: "numeric",
      unit_si: "mmol/L", ref_low_si: 4.1, ref_high_si: 5.9,
      unit_conv: "mg/dL", ref_low_conv: 73.87, ref_high_conv: 106.31,
      si_to_conv_factor: 18.02,
    },
    {
      parameter_name: "BUN",
      input_type: "numeric",
      unit_si: "mmol/L", ref_low_si: 2.1, ref_high_si: 7.1,
      unit_conv: "mg/dL", ref_low_conv: 5.88, ref_high_conv: 19.89,
      si_to_conv_factor: 2.8,
    },
    {
      parameter_name: "Creatinine",
      input_type: "numeric", gender: "F",
      unit_si: "umol/L", ref_low_si: 45, ref_high_si: 84,
      unit_conv: "mg/dL", ref_low_conv: 0.51, ref_high_conv: 0.95,
      si_to_conv_factor: 0.0113,
    },
    {
      parameter_name: "Creatinine",
      input_type: "numeric", gender: "M",
      unit_si: "umol/L", ref_low_si: 59, ref_high_si: 104,
      unit_conv: "mg/dL", ref_low_conv: 0.67, ref_high_conv: 1.18,
      si_to_conv_factor: 0.0113,
    },
    {
      parameter_name: "Uric Acid",
      input_type: "numeric", gender: "F",
      unit_si: "umol/L", ref_low_si: 142, ref_high_si: 339,
      unit_conv: "mg/dL", ref_low_conv: 2.38, ref_high_conv: 5.7,
      si_to_conv_factor: 0.0168,
    },
    {
      parameter_name: "Uric Acid",
      input_type: "numeric", gender: "M",
      unit_si: "umol/L", ref_low_si: 202.3, ref_high_si: 416.5,
      unit_conv: "mg/dL", ref_low_conv: 3.4, ref_high_conv: 6.99,
      si_to_conv_factor: 0.0168,
    },
    {
      parameter_name: "Triglycerides",
      input_type: "numeric",
      unit_si: "mmol/L", ref_low_si: 0, ref_high_si: 1.7,
      unit_conv: "mg/dL", ref_low_conv: 0, ref_high_conv: 150.44,
      si_to_conv_factor: 88.5,
    },
    {
      parameter_name: "Cholesterol",
      input_type: "numeric",
      unit_si: "mmol/L", ref_low_si: 0, ref_high_si: 5.2,
      unit_conv: "mg/dL", ref_low_conv: 0, ref_high_conv: 200,
      si_to_conv_factor: 38.46,
    },
    {
      parameter_name: "HDL",
      input_type: "numeric",
      unit_si: "mmol/L", ref_low_si: 0.78, ref_high_si: 2.2,
      unit_conv: "mg/dL", ref_low_conv: 30, ref_high_conv: 85,
      si_to_conv_factor: 38.46,
    },
    {
      parameter_name: "LDL",
      input_type: "numeric",
      unit_si: "mmol/L", ref_low_si: 0, ref_high_si: 3.3,
      unit_conv: "mg/dL", ref_low_conv: 0, ref_high_conv: 127.41,
      si_to_conv_factor: 38.61,
    },
    {
      parameter_name: "VLDL",
      input_type: "numeric",
      unit_si: "mmol/L", ref_low_si: 0, ref_high_si: 0.78,
      unit_conv: "mg/dL", ref_low_conv: 0, ref_high_conv: 30,
      si_to_conv_factor: 38.46,
    },
    {
      parameter_name: "SGPT (ALT)",
      input_type: "numeric",
      unit_si: "U/L",  ref_low_si: 0, ref_high_si: 41,
      unit_conv: "U/L", ref_low_conv: 0, ref_high_conv: 41,
      si_to_conv_factor: 1,
    },
    {
      parameter_name: "SGOT (AST)",
      input_type: "numeric",
      unit_si: "U/L",  ref_low_si: 0, ref_high_si: 37,
      unit_conv: "U/L", ref_low_conv: 0, ref_high_conv: 37,
      si_to_conv_factor: 1,
    },
    {
      parameter_name: "HbA1c",
      input_type: "numeric",
      unit_si: "%",  ref_low_si: 4.5, ref_high_si: 6.5,
      unit_conv: "%", ref_low_conv: 4.5, ref_high_conv: 6.5,
      si_to_conv_factor: 1,
    },
  ],
};

// ---------------------------------------------------------------------------
// Urinalysis  →  'multi_section'
// ---------------------------------------------------------------------------
const URINE_NEG_AS_NORMAL = ["NEGATIVE", "TRACE", "1+", "2+", "3+", "4+"];
const URINE_NEG_ABNORMAL = ["TRACE", "1+", "2+", "3+", "4+"];
const URINE_AMOUNT = ["NONE", "RARE", "FEW", "MODERATE", "MANY"];
const URINE_AMOUNT_ABNORMAL = ["MODERATE", "MANY"];

const urinalysis: TemplateSeed = {
  service_code: "URINALYSIS",
  layout: "multi_section",
  params: [
    // ----- PHYSICAL -----
    { parameter_name: "PHYSICAL", input_type: "free_text", section: "PHYSICAL", is_section_header: true },
    { parameter_name: "Color",        input_type: "free_text", section: "PHYSICAL", placeholder: "e.g. YELLOW" },
    { parameter_name: "Transparency", input_type: "free_text", section: "PHYSICAL", placeholder: "e.g. CLEAR" },

    // ----- CHEMICAL -----
    { parameter_name: "CHEMICAL", input_type: "free_text", section: "CHEMICAL", is_section_header: true },
    {
      parameter_name: "Specific Gravity", input_type: "numeric", section: "CHEMICAL",
      unit_si: "", ref_low_si: 1.005, ref_high_si: 1.030,
    },
    {
      parameter_name: "pH", input_type: "numeric", section: "CHEMICAL",
      unit_si: "", ref_low_si: 4.6, ref_high_si: 8.0,
    },
    { parameter_name: "Protein",      input_type: "select", section: "CHEMICAL", allowed_values: URINE_NEG_AS_NORMAL, abnormal_values: URINE_NEG_ABNORMAL },
    { parameter_name: "Glucose",      input_type: "select", section: "CHEMICAL", allowed_values: URINE_NEG_AS_NORMAL, abnormal_values: URINE_NEG_ABNORMAL },
    { parameter_name: "Bilirubin",    input_type: "select", section: "CHEMICAL", allowed_values: ["NEGATIVE", "1+", "2+", "3+"], abnormal_values: ["1+", "2+", "3+"] },
    { parameter_name: "Blood",        input_type: "select", section: "CHEMICAL", allowed_values: URINE_NEG_AS_NORMAL, abnormal_values: URINE_NEG_ABNORMAL },
    { parameter_name: "Leukocytes",   input_type: "select", section: "CHEMICAL", allowed_values: URINE_NEG_AS_NORMAL, abnormal_values: URINE_NEG_ABNORMAL },
    { parameter_name: "Nitrites",     input_type: "select", section: "CHEMICAL", allowed_values: ["NEGATIVE", "POSITIVE"], abnormal_values: ["POSITIVE"] },
    { parameter_name: "Ketone",       input_type: "select", section: "CHEMICAL", allowed_values: URINE_NEG_AS_NORMAL, abnormal_values: URINE_NEG_ABNORMAL },
    { parameter_name: "Urobilinogen", input_type: "select", section: "CHEMICAL", allowed_values: ["NORMAL", "1+", "2+", "3+"], abnormal_values: ["1+", "2+", "3+"] },

    // ----- MICROSCOPIC -----
    { parameter_name: "MICROSCOPIC", input_type: "free_text", section: "MICROSCOPIC", is_section_header: true },
    { parameter_name: "RBC",              input_type: "free_text", section: "MICROSCOPIC", placeholder: "e.g. 0-3/HPF" },
    { parameter_name: "WBC",              input_type: "free_text", section: "MICROSCOPIC", placeholder: "e.g. 0-5/HPF" },
    { parameter_name: "Epithelial Cells", input_type: "select",    section: "MICROSCOPIC", allowed_values: URINE_AMOUNT, abnormal_values: URINE_AMOUNT_ABNORMAL },
    { parameter_name: "Mucus Threads",    input_type: "select",    section: "MICROSCOPIC", allowed_values: URINE_AMOUNT, abnormal_values: URINE_AMOUNT_ABNORMAL },
    { parameter_name: "Bacteria",         input_type: "select",    section: "MICROSCOPIC", allowed_values: URINE_AMOUNT, abnormal_values: URINE_AMOUNT_ABNORMAL },
    { parameter_name: "Cast",             input_type: "free_text", section: "MICROSCOPIC", placeholder: "e.g. NONE" },
    { parameter_name: "Crystals",         input_type: "free_text", section: "MICROSCOPIC", placeholder: "e.g. NONE" },
    { parameter_name: "Yeast Cells",      input_type: "select",    section: "MICROSCOPIC", allowed_values: URINE_AMOUNT, abnormal_values: URINE_AMOUNT_ABNORMAL },

    // ----- REMARKS -----
    { parameter_name: "Remarks", input_type: "free_text", placeholder: "(optional)" },
  ],
};

const TEMPLATES: TemplateSeed[] = [cbc, chem, urinalysis];

async function findServiceId(code: string): Promise<string | null> {
  const { data } = await admin
    .from("services")
    .select("id")
    .eq("code", code)
    .maybeSingle();
  return data?.id ?? null;
}

async function upsertTemplate(t: TemplateSeed) {
  const serviceId = await findServiceId(t.service_code);
  if (!serviceId) {
    console.warn(`! ${t.service_code}: no matching service — skipping`);
    return;
  }

  // Wipe existing template (cascade drops params and any unrelated values).
  // Safe in seed because only admin can have templates so far.
  await admin.from("result_templates").delete().eq("service_id", serviceId);

  const { data: tmpl, error: tErr } = await admin
    .from("result_templates")
    .insert({
      service_id: serviceId,
      layout: t.layout,
      header_notes: t.header_notes ?? null,
      footer_notes: t.footer_notes ?? null,
    })
    .select("id")
    .single();
  if (tErr || !tmpl) throw new Error(`insert template ${t.service_code}: ${tErr?.message}`);

  const rows = t.params.map((p, i) => ({
    template_id: tmpl.id,
    sort_order: i,
    section: p.section ?? null,
    is_section_header: p.is_section_header ?? false,
    parameter_name: p.parameter_name,
    input_type: p.input_type,
    unit_si: p.unit_si ?? null,
    unit_conv: p.unit_conv ?? null,
    ref_low_si: p.ref_low_si ?? null,
    ref_high_si: p.ref_high_si ?? null,
    ref_low_conv: p.ref_low_conv ?? null,
    ref_high_conv: p.ref_high_conv ?? null,
    gender: p.gender ?? null,
    si_to_conv_factor: p.si_to_conv_factor ?? null,
    allowed_values: p.allowed_values ?? null,
    abnormal_values: p.abnormal_values ?? null,
    placeholder: p.placeholder ?? null,
  }));

  const { data: insertedParams, error: pErr } = await admin
    .from("result_template_params")
    .insert(rows)
    .select("id");
  if (pErr || !insertedParams)
    throw new Error(`insert params ${t.service_code}: ${pErr?.message}`);

  // Insert age-banded ranges for params that declared them. The .insert
  // above returns rows in insertion order — match by index back to t.params.
  const rangeRows: Array<Record<string, unknown>> = [];
  insertedParams.forEach((row, idx) => {
    const seed = t.params[idx];
    if (!seed.ranges || seed.ranges.length === 0) return;
    seed.ranges.forEach((r, j) => {
      rangeRows.push({
        parameter_id: row.id,
        sort_order: j,
        age_min_months: r.age_min_months ?? null,
        age_max_months: r.age_max_months ?? null,
        gender: r.gender ?? null,
        band_label: r.band_label,
        ref_low_si: r.ref_low_si ?? null,
        ref_high_si: r.ref_high_si ?? null,
        ref_low_conv: r.ref_low_conv ?? null,
        ref_high_conv: r.ref_high_conv ?? null,
      });
    });
  });

  if (rangeRows.length > 0) {
    const { error: rErr } = await admin
      .from("result_template_param_ranges")
      .insert(rangeRows);
    if (rErr) throw new Error(`insert ranges ${t.service_code}: ${rErr.message}`);
  }

  console.log(
    `✓ ${t.service_code} (${t.layout}): ${rows.length} parameters, ${rangeRows.length} age-banded ranges`,
  );
}

async function main() {
  console.log("Seeding result templates...");
  for (const t of TEMPLATES) {
    await upsertTemplate(t);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
