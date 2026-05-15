/**
 * Seeds result templates for the long-code service catalog so the medtech
 * queue page never falls back to the generic PDF upload form.
 *
 *   npm run seed:templates
 *
 * Idempotent: removes the existing template + params for the target service
 * codes before re-inserting, so seed edits are safe to re-run.
 *
 * Targets long-code services that reception/HMOs actually use day-to-day
 * (`CBC_PC`, `FBS_RBS`, `LIPID_PROFILE`, `XRAY_CHEST_PA`, etc.). The compact
 * codes (`CBC`, `FBS`, …) the previous seed targeted are `is_active=false`
 * on prod and not what staff orders against.
 *
 * Templates seeded:
 *   Chemistry / Hematology — `simple`
 *     CBC_PC, CREATININE, FBS_RBS, SGPT_ALT, SGOT_AST,
 *     LIPID_PROFILE, THYROID_FUNCTION_TSH_FT4, HBSAG_SCREENING
 *   Urinalysis              — `multi_section` (Physical / Chemical / Microscopic)
 *     URINALYSIS
 *   Imaging                 — `imaging_report` (Findings + Impression text +
 *                              image attached at finalise)
 *     ECG  (single service)
 *     XRAY_*       — replicated across every active long-code XRAY service
 *     ULTRASOUND_* — replicated across every active long-code US service
 *
 * Reference: drmed.ph LAB RESULTS FORM Sheet
 *   1UZrH4EYAkXiu5gMMQUJoAddpSqqwTmfrk1k8ykaqikQ
 */
import { createClient } from "@supabase/supabase-js";
import type { Database, TablesInsert } from "../src/types/database";
import { requireLocalOrExplicitProd } from "./lib/env-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

requireLocalOrExplicitProd("seed:templates");

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
// CBC + PC (CBC_PC) — Complete Blood Count + Platelet Count  →  'simple'
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
// CREATININE — Creatinine  →  'simple', gender-banded
// ---------------------------------------------------------------------------
const crea: TemplateSeed = {
  service_code: "CREATININE",
  layout: "simple",
  params: [
    {
      parameter_name: "Creatinine", input_type: "numeric",
      unit_si: "mg/dL", gender: "F",
      ref_low_si: 0.6, ref_high_si: 1.1,
    },
    {
      parameter_name: "Creatinine", input_type: "numeric",
      unit_si: "mg/dL", gender: "M",
      ref_low_si: 0.7, ref_high_si: 1.3,
    },
  ],
};

// ---------------------------------------------------------------------------
// FBS_RBS — Fasting / Random Blood Sugar  →  'simple'
// Same numeric range applies to both fasting and random screens.
// ---------------------------------------------------------------------------
const fbs: TemplateSeed = {
  service_code: "FBS_RBS",
  layout: "simple",
  params: [
    {
      parameter_name: "Blood Sugar (FBS / RBS)", input_type: "numeric",
      unit_si: "mg/dL",
      ref_low_si: 70, ref_high_si: 110,
    },
  ],
};

// ---------------------------------------------------------------------------
// SGPT_ALT (ALT)  →  'simple', gender-banded upper limit
// ---------------------------------------------------------------------------
const sgpt: TemplateSeed = {
  service_code: "SGPT_ALT",
  layout: "simple",
  params: [
    {
      parameter_name: "SGPT (ALT)", input_type: "numeric",
      unit_si: "U/L", gender: "F",
      ref_low_si: 0, ref_high_si: 33,
    },
    {
      parameter_name: "SGPT (ALT)", input_type: "numeric",
      unit_si: "U/L", gender: "M",
      ref_low_si: 0, ref_high_si: 41,
    },
  ],
};

// ---------------------------------------------------------------------------
// SGOT_AST (AST)  →  'simple', gender-banded upper limit
// ---------------------------------------------------------------------------
const sgot: TemplateSeed = {
  service_code: "SGOT_AST",
  layout: "simple",
  params: [
    {
      parameter_name: "SGOT (AST)", input_type: "numeric",
      unit_si: "U/L", gender: "F",
      ref_low_si: 0, ref_high_si: 31,
    },
    {
      parameter_name: "SGOT (AST)", input_type: "numeric",
      unit_si: "U/L", gender: "M",
      ref_low_si: 0, ref_high_si: 37,
    },
  ],
};

// ---------------------------------------------------------------------------
// LIPID_PROFILE — Lipid Profile  →  'simple', 5 params
// ---------------------------------------------------------------------------
const lipid: TemplateSeed = {
  service_code: "LIPID_PROFILE",
  layout: "simple",
  params: [
    {
      parameter_name: "Triglycerides", input_type: "numeric",
      unit_si: "mg/dL",
      ref_low_si: 0, ref_high_si: 150,
    },
    {
      parameter_name: "Total Cholesterol", input_type: "numeric",
      unit_si: "mg/dL",
      ref_low_si: 0, ref_high_si: 200,
    },
    {
      // HDL — only a lower bound is clinically meaningful; values above 40
      // (M) / 50 (F) are protective. We use 40 as a conservative cut-off;
      // admin can refine via CRUD if needed.
      parameter_name: "HDL", input_type: "numeric",
      unit_si: "mg/dL",
      ref_low_si: 40,
    },
    {
      parameter_name: "LDL", input_type: "numeric",
      unit_si: "mg/dL",
      ref_low_si: 0, ref_high_si: 100,
    },
    {
      parameter_name: "VLDL", input_type: "numeric",
      unit_si: "mg/dL",
      ref_low_si: 0, ref_high_si: 30,
    },
  ],
};

// ---------------------------------------------------------------------------
// THYROID_FUNCTION_TSH_FT4 — Thyroid Function (TSH + FT4)  →  'simple'
// ---------------------------------------------------------------------------
const thyroid: TemplateSeed = {
  service_code: "THYROID_FUNCTION_TSH_FT4",
  layout: "simple",
  params: [
    {
      parameter_name: "TSH", input_type: "numeric",
      unit_si: "mIU/L",
      ref_low_si: 0.4, ref_high_si: 4.0,
    },
    {
      parameter_name: "FT4", input_type: "numeric",
      unit_si: "pmol/L",
      ref_low_si: 9.0, ref_high_si: 19.0,
    },
  ],
};

// ---------------------------------------------------------------------------
// HBSAG_SCREENING — Hepatitis B Surface Antigen  →  'simple', select
// ---------------------------------------------------------------------------
const hbsag: TemplateSeed = {
  service_code: "HBSAG_SCREENING",
  layout: "simple",
  params: [
    {
      parameter_name: "HBsAg", input_type: "select",
      allowed_values: ["Non-Reactive", "Reactive"],
      abnormal_values: ["Reactive"],
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

// ---------------------------------------------------------------------------
// Imaging reports  →  'imaging_report'
// Two free-text params (Findings + Impression) + image attached at finalise
// time. The image is uploaded to the `result-images` bucket and embedded in
// the rendered PDF — see queue/[id]/actions.ts:finaliseStructuredAction.
//
// ECG has its own single-service template. X-ray and ultrasound modalities
// share template shape but must be attached to each individual long-code
// service row (e.g. XRAY_CHEST_PA, ULTRASOUND_WHOLE_ABDOMEN, etc.) — the
// schema enforces one template per service_id, so the seed fans out at
// runtime by querying the catalog. Placeholders are kept modality-generic
// so a single shape applies across every body part the lab supports.
// ---------------------------------------------------------------------------
const ecg: TemplateSeed = {
  service_code: "ECG",
  layout: "imaging_report",
  params: [
    {
      parameter_name: "Findings", input_type: "free_text",
      placeholder: "Describe rhythm, rate, axis, intervals, ST/T-wave changes, etc.",
    },
    {
      parameter_name: "Impression", input_type: "free_text",
      placeholder: "Overall ECG interpretation",
    },
  ],
};

const XRAY_IMAGING_PARAMS: ParamSeed[] = [
  {
    parameter_name: "Findings", input_type: "free_text",
    placeholder:
      "Describe the lung fields, mediastinum, heart size, bony thorax, and other relevant structures.",
  },
  {
    parameter_name: "Impression", input_type: "free_text",
    placeholder: "Overall radiologic impression",
  },
];

const ULTRASOUND_IMAGING_PARAMS: ParamSeed[] = [
  {
    parameter_name: "Findings", input_type: "free_text",
    placeholder:
      "Describe the liver, gallbladder, kidneys, urinary bladder, and other relevant organs / structures.",
  },
  {
    parameter_name: "Impression", input_type: "free_text",
    placeholder: "Sonographic impression",
  },
];

// Fixed-service templates (one row per `service_code`).
const FIXED_TEMPLATES: TemplateSeed[] = [
  cbc,
  crea,
  fbs,
  sgpt,
  sgot,
  lipid,
  thyroid,
  hbsag,
  urinalysis,
  ecg,
];

async function findServiceId(code: string): Promise<string | null> {
  const { data } = await admin
    .from("services")
    .select("id")
    .eq("code", code)
    .maybeSingle();
  return data?.id ?? null;
}

/** Wipe any existing template + dependent result_values for `serviceId`. */
async function clearExistingTemplate(serviceId: string, label: string) {
  // result_template_params has ON DELETE CASCADE, but result_values.parameter_id
  // does NOT — if any historic result rows reference this template's params we
  // have to clear those first or the delete fails silently inside
  // @supabase/postgrest-js. This is a dev seed, so dropping orphaned
  // result_values is the right call; production data is touched only via the
  // admin CRUD UI which does soft updates.
  const { data: priorTemplate } = await admin
    .from("result_templates")
    .select("id")
    .eq("service_id", serviceId)
    .maybeSingle();
  if (!priorTemplate?.id) return;

  const { data: priorParams } = await admin
    .from("result_template_params")
    .select("id")
    .eq("template_id", priorTemplate.id);
  const paramIds = (priorParams ?? []).map((r) => r.id);
  if (paramIds.length > 0) {
    const { error: rvErr } = await admin
      .from("result_values")
      .delete()
      .in("parameter_id", paramIds);
    if (rvErr) {
      throw new Error(`clear result_values for ${label}: ${rvErr.message}`);
    }
  }
  const { error: delErr } = await admin
    .from("result_templates")
    .delete()
    .eq("id", priorTemplate.id);
  if (delErr) {
    throw new Error(`delete template ${label}: ${delErr.message}`);
  }
}

/**
 * Insert a template + its params + any age-banded ranges for the given
 * service. Caller is responsible for calling `clearExistingTemplate` first
 * if the template might already exist.
 */
async function insertTemplate(
  serviceId: string,
  layout: Layout,
  params: ParamSeed[],
  label: string,
  headerNotes: string | null = null,
  footerNotes: string | null = null,
): Promise<{ paramCount: number; rangeCount: number }> {
  const { data: tmpl, error: tErr } = await admin
    .from("result_templates")
    .insert({
      service_id: serviceId,
      layout,
      header_notes: headerNotes,
      footer_notes: footerNotes,
    })
    .select("id")
    .single();
  if (tErr || !tmpl)
    throw new Error(`insert template ${label}: ${tErr?.message}`);

  const rows = params.map((p, i) => ({
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
    throw new Error(`insert params ${label}: ${pErr?.message}`);

  // Insert age-banded ranges for params that declared them. The .insert
  // above returns rows in insertion order — match by index back to params.
  const rangeRows: TablesInsert<"result_template_param_ranges">[] = [];
  insertedParams.forEach((row, idx) => {
    const seed = params[idx];
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
    if (rErr)
      throw new Error(`insert ranges ${label}: ${rErr.message}`);
  }

  return { paramCount: rows.length, rangeCount: rangeRows.length };
}

async function seedFixedTemplate(t: TemplateSeed): Promise<boolean> {
  const serviceId = await findServiceId(t.service_code);
  if (!serviceId) {
    if (t.service_code === "THYROID_FUNCTION_TSH_FT4") {
      console.error(
        `\nService THYROID_FUNCTION_TSH_FT4 not found — run \`npm run seed:services\` first.\n`,
      );
      process.exit(1);
    }
    console.warn(`! ${t.service_code}: no matching service — skipping`);
    return false;
  }

  await clearExistingTemplate(serviceId, t.service_code);
  const { paramCount, rangeCount } = await insertTemplate(
    serviceId,
    t.layout,
    t.params,
    t.service_code,
    t.header_notes ?? null,
    t.footer_notes ?? null,
  );

  console.log(
    `✓ seeded ${t.service_code} (${t.layout}) with ${paramCount} params${
      rangeCount ? ` + ${rangeCount} age-banded ranges` : ""
    }`,
  );
  return true;
}

async function seedImagingFanout(
  section: "imaging_xray" | "imaging_ultrasound",
  prefix: "XRAY_" | "ULTRASOUND_",
  params: ParamSeed[],
): Promise<number> {
  // Filter by `section` rather than `code LIKE 'XRAY_%'` — PostgREST's
  // `.like()` treats `_` as a single-char wildcard with no escape mechanism,
  // so `XRAY_%` would also match the compact-code `XRAYCHEST` row. The
  // importer sets section=imaging_xray / imaging_ultrasound for every
  // long-code imaging service, and the compact codes seeded by
  // `seed-services.ts` have section=NULL, so this filter is clean.
  const { data: matched, error } = await admin
    .from("services")
    .select("id, code")
    .eq("section", section)
    .eq("is_active", true)
    .order("code");
  if (error) {
    throw new Error(`look up section=${section} services: ${error.message}`);
  }
  const services = matched ?? [];
  if (services.length === 0) {
    console.warn(
      `! no active services with section='${section}' — skipping ${prefix.replace(/_$/, "")} fanout`,
    );
    return 0;
  }

  for (const svc of services) {
    await clearExistingTemplate(svc.id, svc.code);
    await insertTemplate(
      svc.id,
      "imaging_report",
      params,
      svc.code,
    );
  }
  console.log(
    `✓ seeded ${services.length} ${prefix}* services with imaging_report template`,
  );
  return services.length;
}

async function main() {
  console.log("Seeding result templates against long-code service catalog...");

  let total = 0;
  for (const t of FIXED_TEMPLATES) {
    const ok = await seedFixedTemplate(t);
    if (ok) total += 1;
  }

  const xrayCount = await seedImagingFanout(
    "imaging_xray",
    "XRAY_",
    XRAY_IMAGING_PARAMS,
  );
  const usCount = await seedImagingFanout(
    "imaging_ultrasound",
    "ULTRASOUND_",
    ULTRASOUND_IMAGING_PARAMS,
  );
  total += xrayCount + usCount;

  console.log(`Total: ${total} templates seeded.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
