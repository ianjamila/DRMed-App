/**
 * Seeds result templates for the long-code service catalog so the medtech
 * queue page never falls back to the generic PDF upload form.
 *
 *   npm run seed:templates              # local Supabase
 *   npm run seed:templates -- --prod    # linked remote project
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
 *   Fixed (one row per service_code) — `simple` / `multi_section`
 *     CBC_PC, CREATININE, FBS_RBS, SGPT_ALT, SGOT_AST,
 *     LIPID_PROFILE, THYROID_FUNCTION_TSH_FT4, HBSAG_SCREENING, URINALYSIS, ECG
 *
 *   Section fanout — every active service in the section gets a template;
 *   per-section defaults map provides the params for the well-known codes,
 *   and anything not in the map gets a single-param numeric placeholder so
 *   the queue page can render *something* instead of falling back to PDF.
 *     chemistry, immunology, urinalysis, hematology, microbiology
 *
 *   Package fanout — multi-row `simple` panel composed inline from the
 *   chemistry param library so STANDARD_CHEMISTRY etc. render cleanly.
 *
 *   Imaging fanout — `imaging_report` (Findings + Impression + attached
 *   image at finalise time).
 *     XRAY_*       — section=imaging_xray
 *     ULTRASOUND_* — section=imaging_ultrasound
 *
 * Local-dev caveat: the local catalog only contains the handful of codes
 * seeded by `seed-services.ts` plus whatever you've imported via
 * `import:tests`. The section fanout against local will therefore touch
 * far fewer rows than against prod — that's expected.
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

// ===========================================================================
// SECTION FANOUT — long-tail chemistry / immunology / urinalysis / hematology
// / microbiology / packages.
//
// Each section has a defaults map keyed by service `code`. The fanout walks
// every active service in the section and inserts a template using either
// the mapped params (well-known tests with curated units + refs) or a
// single-param placeholder (input_type='numeric', no unit, no range — admin
// fills via the /staff/admin/result-templates CRUD).
//
// Reference ranges are populated only where the standard PH-lab reference
// is well established. For everything else: leave null. Better to render an
// empty range than to publish wrong clinical values.
// ===========================================================================

interface SectionEntry {
  /** Template layout. Defaults to 'simple' for single-test templates. */
  layout?: Layout;
  /** Params for this template. */
  params: ParamSeed[];
}

/**
 * Build a single-numeric placeholder param. Used both as the fallback when a
 * service has no entry in its section's defaults map and as a shorthand for
 * the many chem/immuno tests we know the name of but not a published ref.
 */
function placeholderNumeric(parameterName: string, unitSi?: string): ParamSeed {
  return {
    parameter_name: parameterName,
    input_type: "numeric",
    ...(unitSi ? { unit_si: unitSi } : {}),
  };
}

/** Qualitative serology select (Non-Reactive / Reactive). */
const REACTIVE_SELECT: Pick<
  ParamSeed,
  "input_type" | "allowed_values" | "abnormal_values"
> = {
  input_type: "select",
  allowed_values: ["Non-Reactive", "Reactive"],
  abnormal_values: ["Reactive"],
};

/** Qualitative positive/negative select. */
const POS_NEG_SELECT: Pick<
  ParamSeed,
  "input_type" | "allowed_values" | "abnormal_values"
> = {
  input_type: "select",
  allowed_values: ["Negative", "Positive"],
  abnormal_values: ["Positive"],
};

// ---------------------------------------------------------------------------
// chemistry defaults — single-param numeric tests with curated refs.
// ---------------------------------------------------------------------------
const CHEMISTRY_DEFAULTS: Record<string, SectionEntry> = {
  ALBUMIN: {
    params: [{ parameter_name: "Albumin", input_type: "numeric", unit_si: "g/L", ref_low_si: 35, ref_high_si: 55 }],
  },
  ALP: {
    params: [{ parameter_name: "ALP", input_type: "numeric", unit_si: "U/L", ref_low_si: 30, ref_high_si: 120 }],
  },
  AMYLASE: {
    params: [{ parameter_name: "Amylase", input_type: "numeric", unit_si: "U/L", ref_low_si: 25, ref_high_si: 125 }],
  },
  BILIRUBIN: {
    params: [{ parameter_name: "Bilirubin (Total)", input_type: "numeric", unit_si: "µmol/L", ref_low_si: 0, ref_high_si: 21 }],
  },
  BUA_URIC_ACID: {
    // Gender-banded — F 142–339, M 202–416 µmol/L
    params: [
      { parameter_name: "Uric Acid", input_type: "numeric", unit_si: "µmol/L", gender: "F", ref_low_si: 142, ref_high_si: 339 },
      { parameter_name: "Uric Acid", input_type: "numeric", unit_si: "µmol/L", gender: "M", ref_low_si: 202, ref_high_si: 416 },
    ],
  },
  BUN: {
    params: [{
      parameter_name: "BUN",
      input_type: "numeric",
      unit_si: "mmol/L", ref_low_si: 2.1, ref_high_si: 7.1,
      unit_conv: "mg/dL", ref_low_conv: 5.88, ref_high_conv: 19.89,
      si_to_conv_factor: 2.8,
    }],
  },
  CA: {
    params: [{ parameter_name: "Calcium", input_type: "numeric", unit_si: "mmol/L", ref_low_si: 2.15, ref_high_si: 2.50 }],
  },
  CHOLESTEROL: {
    params: [{
      parameter_name: "Total Cholesterol",
      input_type: "numeric",
      unit_si: "mmol/L", ref_low_si: 0, ref_high_si: 5.2,
      unit_conv: "mg/dL", ref_low_conv: 0, ref_high_conv: 200,
      si_to_conv_factor: 38.67,
    }],
  },
  CK_MB: {
    params: [{ parameter_name: "CK-MB", input_type: "numeric", unit_si: "U/L", ref_low_si: 0, ref_high_si: 25 }],
  },
  CK_MM: {
    params: [placeholderNumeric("CK-MM", "U/L")],
  },
  CK_TOTAL_CREATINE_KINASE: {
    params: [{ parameter_name: "CK Total (Creatine Kinase)", input_type: "numeric", unit_si: "U/L", ref_low_si: 0, ref_high_si: 200 }],
  },
  CL: {
    params: [{ parameter_name: "Chloride", input_type: "numeric", unit_si: "mmol/L", ref_low_si: 98, ref_high_si: 107 }],
  },
  FERRITIN: {
    // Gender-banded — leave actual numbers for admin since values vary widely
    // by lab + assay. Admin fills via CRUD.
    params: [placeholderNumeric("Ferritin", "ng/mL")],
  },
  FSH: {
    params: [
      { parameter_name: "FSH", input_type: "numeric", unit_si: "mIU/mL", gender: "F", ref_low_si: 2.5, ref_high_si: 10.2 },
      { parameter_name: "FSH", input_type: "numeric", unit_si: "mIU/mL", gender: "M", ref_low_si: 1.5, ref_high_si: 12.4 },
    ],
  },
  FT3: {
    params: [{ parameter_name: "FT3", input_type: "numeric", unit_si: "pmol/L", ref_low_si: 3.1, ref_high_si: 6.8 }],
  },
  FT4: {
    params: [{ parameter_name: "FT4", input_type: "numeric", unit_si: "pmol/L", ref_low_si: 9.0, ref_high_si: 19.0 }],
  },
  GGTP: {
    params: [{ parameter_name: "GGTP", input_type: "numeric", unit_si: "U/L", ref_low_si: 0, ref_high_si: 55 }],
  },
  GLOBULIN: {
    params: [placeholderNumeric("Globulin", "g/L")],
  },
  HBA1C: {
    params: [{ parameter_name: "HbA1c", input_type: "numeric", unit_si: "%", ref_low_si: 4.5, ref_high_si: 6.5 }],
  },
  HDL_LDL_VLDL: {
    params: [
      { parameter_name: "HDL", input_type: "numeric", unit_si: "mg/dL", ref_low_si: 40 },
      { parameter_name: "LDL", input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 100 },
      { parameter_name: "VLDL", input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 30 },
    ],
  },
  ICA: {
    params: [placeholderNumeric("Ionized Calcium", "mmol/L")],
  },
  K: {
    params: [{ parameter_name: "Potassium", input_type: "numeric", unit_si: "mmol/L", ref_low_si: 3.5, ref_high_si: 5.0 }],
  },
  LDH: {
    params: [{ parameter_name: "LDH", input_type: "numeric", unit_si: "U/L", ref_low_si: 0, ref_high_si: 250 }],
  },
  LH: {
    params: [
      { parameter_name: "LH", input_type: "numeric", unit_si: "mIU/mL", gender: "F", ref_low_si: 1.9, ref_high_si: 12.5 },
      { parameter_name: "LH", input_type: "numeric", unit_si: "mIU/mL", gender: "M", ref_low_si: 1.7, ref_high_si: 8.6 },
    ],
  },
  LIPASE: {
    params: [placeholderNumeric("Lipase", "U/L")],
  },
  MG: {
    params: [{ parameter_name: "Magnesium", input_type: "numeric", unit_si: "mmol/L", ref_low_si: 0.66, ref_high_si: 1.07 }],
  },
  NA: {
    params: [{ parameter_name: "Sodium", input_type: "numeric", unit_si: "mmol/L", ref_low_si: 135, ref_high_si: 145 }],
  },
  OGTT_100G: {
    // 100g OGTT — 4-hour curve. Pregnancy screen.
    params: [
      { parameter_name: "Fasting", input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 95 },
      { parameter_name: "1 Hour",  input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 180 },
      { parameter_name: "2 Hour",  input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 155 },
      { parameter_name: "3 Hour",  input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 140 },
    ],
  },
  OGTT_75G: {
    // 75g OGTT — fasting + 2h.
    params: [
      { parameter_name: "Fasting", input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 92 },
      { parameter_name: "1 Hour",  input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 180 },
      { parameter_name: "2 Hour",  input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 153 },
    ],
  },
  PHOSPHORUS: {
    params: [{ parameter_name: "Phosphorus", input_type: "numeric", unit_si: "mmol/L", ref_low_si: 0.81, ref_high_si: 1.45 }],
  },
  PROLACTIN: {
    params: [
      { parameter_name: "Prolactin", input_type: "numeric", unit_si: "ng/mL", gender: "F", ref_low_si: 4.79, ref_high_si: 23.3 },
      { parameter_name: "Prolactin", input_type: "numeric", unit_si: "ng/mL", gender: "M", ref_low_si: 4.04, ref_high_si: 15.2 },
    ],
  },
  T3: {
    params: [placeholderNumeric("T3", "nmol/L")],
  },
  T4: {
    params: [placeholderNumeric("T4", "nmol/L")],
  },
  TIBC: {
    params: [placeholderNumeric("TIBC", "µmol/L")],
  },
  TOTAL_ACID_PHOSPHATASE: {
    params: [placeholderNumeric("Total Acid Phosphatase", "U/L")],
  },
  TOTAL_PROTEIN: {
    params: [{ parameter_name: "Total Protein", input_type: "numeric", unit_si: "g/L", ref_low_si: 60, ref_high_si: 80 }],
  },
  TPAG: {
    // Total Protein, Albumin, Globulin + A/G ratio
    params: [
      { parameter_name: "Total Protein", input_type: "numeric", unit_si: "g/L", ref_low_si: 60, ref_high_si: 80 },
      { parameter_name: "Albumin",       input_type: "numeric", unit_si: "g/L", ref_low_si: 35, ref_high_si: 55 },
      placeholderNumeric("Globulin", "g/L"),
      placeholderNumeric("A/G Ratio"),
    ],
  },
  TRIGLYCERIDES: {
    params: [{
      parameter_name: "Triglycerides",
      input_type: "numeric",
      unit_si: "mmol/L", ref_low_si: 0, ref_high_si: 1.7,
      unit_conv: "mg/dL", ref_low_conv: 0, ref_high_conv: 150,
      si_to_conv_factor: 88.5,
    }],
  },
  TSH: {
    params: [{ parameter_name: "TSH", input_type: "numeric", unit_si: "mIU/L", ref_low_si: 0.4, ref_high_si: 4.0 }],
  },
};

// ---------------------------------------------------------------------------
// immunology defaults — mostly qualitative select; some quantitative numeric.
// ---------------------------------------------------------------------------
const IMMUNOLOGY_DEFAULTS: Record<string, SectionEntry> = {
  AFP: {
    params: [{ parameter_name: "AFP", input_type: "numeric", unit_si: "ng/mL", ref_low_si: 0, ref_high_si: 8.5 }],
  },
  ANA: {
    // Antinuclear antibody — qualitative + titer commonly reported. Keep
    // simple: Non-Reactive/Reactive, admin can add titer params later.
    params: [{ parameter_name: "ANA", ...REACTIVE_SELECT }],
  },
  ANTI_HAV_IGG: { params: [{ parameter_name: "Anti-HAV IgG", ...REACTIVE_SELECT }] },
  ANTI_HAV_IGM: { params: [{ parameter_name: "Anti-HAV IgM", ...REACTIVE_SELECT }] },
  ANTI_HBC_IGG: { params: [{ parameter_name: "Anti-HBc IgG", ...REACTIVE_SELECT }] },
  ANTI_HBC_IGM: { params: [{ parameter_name: "Anti-HBc IgM", ...REACTIVE_SELECT }] },
  ANTI_HBE:     { params: [{ parameter_name: "Anti-HBe",     ...REACTIVE_SELECT }] },
  ANTI_HBS:     { params: [{ parameter_name: "Anti-HBs",     ...REACTIVE_SELECT }] },
  ANTI_HCV:     { params: [{ parameter_name: "Anti-HCV",     ...REACTIVE_SELECT }] },
  ASO: {
    params: [{ parameter_name: "ASO", input_type: "numeric", unit_si: "U/mL", ref_low_si: 0, ref_high_si: 200 }],
  },
  B_HCG: {
    // Pregnancy quantitative — leave numeric placeholder (range varies by
    // gestation week).
    params: [placeholderNumeric("Beta-HCG", "mIU/mL")],
  },
  CA_125:  { params: [{ parameter_name: "CA 125",  input_type: "numeric", unit_si: "U/mL",  ref_low_si: 0, ref_high_si: 35 }] },
  CA_15_3: { params: [{ parameter_name: "CA 15-3", input_type: "numeric", unit_si: "U/mL",  ref_low_si: 0, ref_high_si: 25 }] },
  CA_19_9: { params: [{ parameter_name: "CA 19-9", input_type: "numeric", unit_si: "U/mL",  ref_low_si: 0, ref_high_si: 37 }] },
  CEA: {
    params: [{ parameter_name: "CEA", input_type: "numeric", unit_si: "ng/mL", ref_low_si: 0, ref_high_si: 5.0 }],
  },
  CRP: {
    params: [{ parameter_name: "CRP", input_type: "numeric", unit_si: "mg/L", ref_low_si: 0, ref_high_si: 10 }],
  },
  DENGUE_BLOT_IGG_IGM: {
    params: [
      { parameter_name: "Dengue IgG", ...REACTIVE_SELECT },
      { parameter_name: "Dengue IgM", ...REACTIVE_SELECT },
    ],
  },
  DENGUE_DUO: {
    params: [
      { parameter_name: "Dengue IgG", ...REACTIVE_SELECT },
      { parameter_name: "Dengue IgM", ...REACTIVE_SELECT },
    ],
  },
  DENGUE_NS1: {
    params: [{ parameter_name: "Dengue NS1", ...REACTIVE_SELECT }],
  },
  H_PYLORI_AB: {
    params: [{ parameter_name: "H. pylori Ab", ...REACTIVE_SELECT }],
  },
  HBEAG: {
    params: [{ parameter_name: "HBeAg", ...REACTIVE_SELECT }],
  },
  // HBSAG_SCREENING already covered by the fixed `hbsag` template above; the
  // section fanout will skip it via the `clearExistingTemplate` re-seed.
  HBSAG_TITER: {
    // Titer is quantitative
    params: [placeholderNumeric("HBsAg Titer", "IU/mL")],
  },
  HEPA_A_SCREENING: {
    params: [{ parameter_name: "Hepatitis A Screening", ...REACTIVE_SELECT }],
  },
  HEPATITIS_A_PROFILE: {
    params: [
      { parameter_name: "Anti-HAV IgG", ...REACTIVE_SELECT },
      { parameter_name: "Anti-HAV IgM", ...REACTIVE_SELECT },
    ],
  },
  HEPATITIS_B_PROFILE: {
    params: [
      { parameter_name: "HBsAg",        ...REACTIVE_SELECT },
      { parameter_name: "Anti-HBs",     ...REACTIVE_SELECT },
      { parameter_name: "Anti-HBc",     ...REACTIVE_SELECT },
      { parameter_name: "HBeAg",        ...REACTIVE_SELECT },
      { parameter_name: "Anti-HBe",     ...REACTIVE_SELECT },
    ],
  },
  HEPATITIS_A_B_C_PROFILE: {
    params: [
      { parameter_name: "Anti-HAV IgM", ...REACTIVE_SELECT },
      { parameter_name: "HBsAg",        ...REACTIVE_SELECT },
      { parameter_name: "Anti-HCV",     ...REACTIVE_SELECT },
    ],
  },
  HIV_1_2_SCREENING_QUALITATIVE: {
    params: [{ parameter_name: "HIV 1 & 2 Screening", ...REACTIVE_SELECT }],
  },
  HS_CRP: {
    params: [{ parameter_name: "hs-CRP", input_type: "numeric", unit_si: "mg/L", ref_low_si: 0, ref_high_si: 3.0 }],
  },
  PREGNANCY_TEST: {
    params: [{ parameter_name: "Pregnancy Test", ...POS_NEG_SELECT }],
  },
  PSA: {
    params: [{ parameter_name: "PSA", input_type: "numeric", unit_si: "ng/mL", ref_low_si: 0, ref_high_si: 4.0 }],
  },
  RA_RF_RHEUMATOID_FACTOR: {
    params: [{ parameter_name: "Rheumatoid Factor (RA/RF)", input_type: "numeric", unit_si: "IU/mL", ref_low_si: 0, ref_high_si: 14 }],
  },
  SYPHILIS_TPHA_SCREENING_TREPONEMA_PALLID: {
    params: [{ parameter_name: "TPHA Screening", ...REACTIVE_SELECT }],
  },
  SYPHILIS_TPHA_WITH_TITER: {
    params: [
      { parameter_name: "TPHA",  ...REACTIVE_SELECT },
      placeholderNumeric("Titer"),
    ],
  },
  TYPHIDOT_TYPHOID_SCREENING: {
    params: [
      { parameter_name: "Typhidot IgG", ...REACTIVE_SELECT },
      { parameter_name: "Typhidot IgM", ...REACTIVE_SELECT },
    ],
  },
  VDRL_RPR: {
    params: [{ parameter_name: "VDRL/RPR", ...REACTIVE_SELECT }],
  },
};

// ---------------------------------------------------------------------------
// urinalysis defaults (URINALYSIS itself is in FIXED_TEMPLATES).
// ---------------------------------------------------------------------------
const URINALYSIS_DEFAULTS: Record<string, SectionEntry> = {
  URINE_ALBUMIN: {
    // Microalbumin threshold is ~30 mg/L; admin can tighten.
    params: [{ parameter_name: "Urine Albumin", input_type: "numeric", unit_si: "mg/L", ref_low_si: 0, ref_high_si: 30 }],
  },
  URINE_CREATININE: {
    params: [placeholderNumeric("Urine Creatinine", "mmol/L")],
  },
  URINE_CREA_CLEARANCE: {
    params: [placeholderNumeric("Creatinine Clearance", "mL/min")],
  },
  URINE_PROTEIN: {
    params: [placeholderNumeric("Urine Protein", "g/L")],
  },
  URINE_RBC_MORPHOLOGY: {
    params: [
      { parameter_name: "RBC Morphology", input_type: "free_text", placeholder: "Describe RBC morphology (isomorphic / dysmorphic, etc.)" },
    ],
  },
  URINE_CULTURE_SENSITIVITY: {
    params: [
      { parameter_name: "Culture Result", input_type: "free_text", placeholder: "Describe isolated organism(s) and colony count" },
      { parameter_name: "Sensitivity",    input_type: "free_text", placeholder: "Antimicrobial susceptibility / resistance pattern" },
    ],
  },
  MICRAL_MICROALBUMIN: {
    params: [{ parameter_name: "Microalbumin", input_type: "numeric", unit_si: "mg/L", ref_low_si: 0, ref_high_si: 30 }],
  },
  PROTEIN_CREA_RATIO_URINE: {
    params: [placeholderNumeric("Protein/Creatinine Ratio", "mg/g")],
  },
  ALB_CREA_RATIO_URINE_UACR: {
    params: [{ parameter_name: "Albumin/Creatinine Ratio (UACR)", input_type: "numeric", unit_si: "mg/g", ref_low_si: 0, ref_high_si: 30 }],
  },
};

// ---------------------------------------------------------------------------
// hematology defaults (CBC_PC itself is in FIXED_TEMPLATES).
// ---------------------------------------------------------------------------
const HEMATOLOGY_DEFAULTS: Record<string, SectionEntry> = {
  BLEEDING_TIME: {
    params: [{ parameter_name: "Bleeding Time", input_type: "numeric", unit_si: "min", ref_low_si: 1, ref_high_si: 9 }],
  },
  CLOTTING_TIME: {
    params: [{ parameter_name: "Clotting Time", input_type: "numeric", unit_si: "min", ref_low_si: 5, ref_high_si: 15 }],
  },
  CT_BT: {
    params: [
      { parameter_name: "Clotting Time", input_type: "numeric", unit_si: "min", ref_low_si: 5, ref_high_si: 15 },
      { parameter_name: "Bleeding Time", input_type: "numeric", unit_si: "min", ref_low_si: 1, ref_high_si: 9 },
    ],
  },
  ESR: {
    params: [
      { parameter_name: "ESR", input_type: "numeric", unit_si: "mm/hr", gender: "F", ref_low_si: 0, ref_high_si: 20 },
      { parameter_name: "ESR", input_type: "numeric", unit_si: "mm/hr", gender: "M", ref_low_si: 0, ref_high_si: 15 },
    ],
  },
  PROTHROMBIN_TIME_PT_PROTIME: {
    params: [
      { parameter_name: "Prothrombin Time (PT)", input_type: "numeric", unit_si: "sec", ref_low_si: 11, ref_high_si: 13.5 },
      placeholderNumeric("INR"),
      placeholderNumeric("% Activity", "%"),
    ],
  },
  PARTIAL_THROMBOPLASTIN_TIME_PTT_APTT: {
    params: [{ parameter_name: "PTT (aPTT)", input_type: "numeric", unit_si: "sec", ref_low_si: 25, ref_high_si: 35 }],
  },
  BLOOD_TYPING_W_RH_FACTOR: {
    params: [
      {
        parameter_name: "Blood Type", input_type: "select",
        allowed_values: ["A", "B", "AB", "O"],
      },
      {
        parameter_name: "Rh Factor", input_type: "select",
        allowed_values: ["Positive", "Negative"],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// microbiology defaults — mostly descriptive free-text.
// ---------------------------------------------------------------------------
const MICROBIOLOGY_DEFAULTS: Record<string, SectionEntry> = {
  FECALYSIS: {
    params: [
      { parameter_name: "Color",         input_type: "free_text" },
      { parameter_name: "Consistency",   input_type: "free_text" },
      { parameter_name: "WBC",           input_type: "free_text", placeholder: "e.g. 0-2/HPF" },
      { parameter_name: "RBC",           input_type: "free_text", placeholder: "e.g. 0-2/HPF" },
      { parameter_name: "Parasites",     input_type: "free_text", placeholder: "e.g. NONE SEEN" },
      { parameter_name: "Others",        input_type: "free_text", placeholder: "(optional)" },
    ],
  },
  GRAM_STAIN: {
    params: [
      { parameter_name: "Result",  input_type: "free_text", placeholder: "Describe the organisms observed (e.g. Gram-positive cocci in clusters)" },
      { parameter_name: "Remarks", input_type: "free_text", placeholder: "(optional)" },
    ],
  },
  OCCULT_BLOOD_FOBT: {
    params: [{ parameter_name: "Occult Blood", ...POS_NEG_SELECT }],
  },
  SPUTUM_AFB: {
    params: [
      {
        parameter_name: "AFB Smear",
        input_type: "select",
        allowed_values: ["Negative", "Scanty", "1+", "2+", "3+"],
        abnormal_values: ["Scanty", "1+", "2+", "3+"],
      },
      { parameter_name: "Remarks", input_type: "free_text", placeholder: "(optional)" },
    ],
  },
  STOOL_CULTURE_SENSITIVITY: {
    params: [
      { parameter_name: "Culture Result", input_type: "free_text", placeholder: "Describe isolated organism(s)" },
      { parameter_name: "Sensitivity",    input_type: "free_text", placeholder: "Antimicrobial susceptibility / resistance pattern" },
    ],
  },
};

// ---------------------------------------------------------------------------
// package panels — multi-row `simple` templates composed inline. Params are
// copies (not references) so each panel is self-contained and renders with
// the right unit + ref range without runtime composition.
// ---------------------------------------------------------------------------

// Reusable chemistry row builders (copy, don't reference — TS object spread
// would alias the same object).
const FBS_ROW = (): ParamSeed => ({
  parameter_name: "FBS", input_type: "numeric",
  unit_si: "mg/dL", ref_low_si: 70, ref_high_si: 110,
});
const BUN_ROW = (): ParamSeed => ({
  parameter_name: "BUN", input_type: "numeric",
  unit_si: "mmol/L", ref_low_si: 2.1, ref_high_si: 7.1,
  unit_conv: "mg/dL", ref_low_conv: 5.88, ref_high_conv: 19.89,
  si_to_conv_factor: 2.8,
});
const CREATININE_ROW = (): ParamSeed => ({
  parameter_name: "Creatinine", input_type: "numeric",
  unit_si: "mg/dL", ref_low_si: 0.6, ref_high_si: 1.3,
});
const URIC_ACID_ROW = (): ParamSeed => ({
  parameter_name: "Uric Acid", input_type: "numeric",
  unit_si: "µmol/L", ref_low_si: 142, ref_high_si: 416,
});
const CHOL_ROW = (): ParamSeed => ({
  parameter_name: "Total Cholesterol", input_type: "numeric",
  unit_si: "mmol/L", ref_low_si: 0, ref_high_si: 5.2,
  unit_conv: "mg/dL", ref_low_conv: 0, ref_high_conv: 200,
  si_to_conv_factor: 38.67,
});
const TRIG_ROW = (): ParamSeed => ({
  parameter_name: "Triglycerides", input_type: "numeric",
  unit_si: "mmol/L", ref_low_si: 0, ref_high_si: 1.7,
  unit_conv: "mg/dL", ref_low_conv: 0, ref_high_conv: 150,
  si_to_conv_factor: 88.5,
});
const HDL_ROW = (): ParamSeed => ({
  parameter_name: "HDL", input_type: "numeric", unit_si: "mg/dL", ref_low_si: 40,
});
const LDL_ROW = (): ParamSeed => ({
  parameter_name: "LDL", input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 100,
});
const VLDL_ROW = (): ParamSeed => ({
  parameter_name: "VLDL", input_type: "numeric", unit_si: "mg/dL", ref_low_si: 0, ref_high_si: 30,
});
const SGPT_ROW = (): ParamSeed => ({
  parameter_name: "SGPT (ALT)", input_type: "numeric",
  unit_si: "U/L", ref_low_si: 0, ref_high_si: 41,
});
const SGOT_ROW = (): ParamSeed => ({
  parameter_name: "SGOT (AST)", input_type: "numeric",
  unit_si: "U/L", ref_low_si: 0, ref_high_si: 37,
});
const HBA1C_ROW = (): ParamSeed => ({
  parameter_name: "HbA1c", input_type: "numeric", unit_si: "%", ref_low_si: 4.5, ref_high_si: 6.5,
});
const ALBUMIN_ROW = (): ParamSeed => ({
  parameter_name: "Albumin", input_type: "numeric", unit_si: "g/L", ref_low_si: 35, ref_high_si: 55,
});
const TOTAL_PROTEIN_ROW = (): ParamSeed => ({
  parameter_name: "Total Protein", input_type: "numeric", unit_si: "g/L", ref_low_si: 60, ref_high_si: 80,
});
const BILIRUBIN_ROW = (): ParamSeed => ({
  parameter_name: "Bilirubin (Total)", input_type: "numeric", unit_si: "µmol/L", ref_low_si: 0, ref_high_si: 21,
});
const ALP_ROW = (): ParamSeed => ({
  parameter_name: "ALP", input_type: "numeric", unit_si: "U/L", ref_low_si: 30, ref_high_si: 120,
});
const TSH_ROW = (): ParamSeed => ({
  parameter_name: "TSH", input_type: "numeric", unit_si: "mIU/L", ref_low_si: 0.4, ref_high_si: 4.0,
});
const FT3_ROW = (): ParamSeed => ({
  parameter_name: "FT3", input_type: "numeric", unit_si: "pmol/L", ref_low_si: 3.1, ref_high_si: 6.8,
});
const FT4_ROW = (): ParamSeed => ({
  parameter_name: "FT4", input_type: "numeric", unit_si: "pmol/L", ref_low_si: 9.0, ref_high_si: 19.0,
});

// "Included test" placeholder for tests that have their own dedicated template
// (CBC, Urinalysis, Chest X-Ray, ECG, etc.) but appear inside a package panel
// — the medtech records a summary/notes here while the actual sub-test is
// finalised separately.
const INCLUDED = (label: string, placeholder?: string): ParamSeed => ({
  parameter_name: label,
  input_type: "free_text",
  placeholder: placeholder ?? "Summary / reference to the individual test result",
});

const PACKAGE_PANELS: Record<string, SectionEntry> = {
  STANDARD_CHEMISTRY: {
    params: [
      FBS_ROW(), BUN_ROW(), CREATININE_ROW(), URIC_ACID_ROW(),
      CHOL_ROW(), TRIG_ROW(), HDL_ROW(), LDL_ROW(), VLDL_ROW(),
      SGPT_ROW(), SGOT_ROW(),
    ],
  },
  BASIC_PACKAGE: {
    params: [
      INCLUDED("CBC", "CBC summary — see CBC + PC sub-test for full breakdown"),
      INCLUDED("Urinalysis", "Urinalysis summary — see URINALYSIS sub-test for full breakdown"),
    ],
  },
  ROUTINE_PACKAGE: {
    // Best-guess composition for a routine check-up.
    params: [
      INCLUDED("CBC"),
      INCLUDED("Urinalysis"),
      FBS_ROW(),
    ],
  },
  ANNUAL_PHYSICAL_EXAM: {
    params: [
      INCLUDED("CBC"),
      INCLUDED("Urinalysis"),
      FBS_ROW(),
      CHOL_ROW(),
      CREATININE_ROW(),
      BUN_ROW(),
      INCLUDED("Chest X-Ray", "Chest X-Ray reading"),
      INCLUDED("ECG", "ECG reading"),
    ],
  },
  EXECUTIVE_PACKAGE_STANDARD: {
    params: [
      INCLUDED("CBC"),
      INCLUDED("Urinalysis"),
      FBS_ROW(), BUN_ROW(), CREATININE_ROW(),
      CHOL_ROW(), TRIG_ROW(), HDL_ROW(), LDL_ROW(), VLDL_ROW(),
      SGPT_ROW(), SGOT_ROW(),
      INCLUDED("ECG", "ECG reading"),
      INCLUDED("Chest X-Ray", "Chest X-Ray reading"),
    ],
  },
  EXECUTIVE_PACKAGE_COMPREHENSIVE: {
    params: [
      INCLUDED("CBC"),
      INCLUDED("Urinalysis"),
      FBS_ROW(), BUN_ROW(), CREATININE_ROW(),
      CHOL_ROW(), TRIG_ROW(), HDL_ROW(), LDL_ROW(), VLDL_ROW(),
      SGPT_ROW(), SGOT_ROW(),
      HBA1C_ROW(),
      URIC_ACID_ROW(),
      INCLUDED("Fecalysis", "Stool exam result"),
      INCLUDED("Ultrasound", "Whole abdomen ultrasound reading"),
      INCLUDED("ECG", "ECG reading"),
      INCLUDED("Chest X-Ray", "Chest X-Ray reading"),
    ],
  },
  EXECUTIVE_PACKAGE_DELUXE_MEN_S: {
    params: [
      INCLUDED("CBC"),
      INCLUDED("Urinalysis"),
      FBS_ROW(), BUN_ROW(), CREATININE_ROW(),
      CHOL_ROW(), TRIG_ROW(), HDL_ROW(), LDL_ROW(), VLDL_ROW(),
      SGPT_ROW(), SGOT_ROW(),
      HBA1C_ROW(),
      URIC_ACID_ROW(),
      { parameter_name: "PSA", input_type: "numeric", unit_si: "ng/mL", ref_low_si: 0, ref_high_si: 4.0 },
      INCLUDED("Fecalysis", "Stool exam result"),
      INCLUDED("Ultrasound", "Whole abdomen ultrasound reading"),
      INCLUDED("ECG", "ECG reading"),
      INCLUDED("Chest X-Ray", "Chest X-Ray reading"),
    ],
  },
  EXECUTIVE_PACKAGE_DELUXE_WOMEN_S: {
    params: [
      INCLUDED("CBC"),
      INCLUDED("Urinalysis"),
      FBS_ROW(), BUN_ROW(), CREATININE_ROW(),
      CHOL_ROW(), TRIG_ROW(), HDL_ROW(), LDL_ROW(), VLDL_ROW(),
      SGPT_ROW(), SGOT_ROW(),
      HBA1C_ROW(),
      URIC_ACID_ROW(),
      INCLUDED("Pap Smear", "Pap smear cytology reading"),
      INCLUDED("Fecalysis", "Stool exam result"),
      INCLUDED("Ultrasound", "Whole abdomen ultrasound reading"),
      INCLUDED("ECG", "ECG reading"),
      INCLUDED("Chest X-Ray", "Chest X-Ray reading"),
    ],
  },
  PRE_EMPLOYMENT_PACKAGE: {
    params: [
      INCLUDED("CBC"),
      INCLUDED("Urinalysis"),
      INCLUDED("Chest X-Ray", "Chest X-Ray reading"),
      INCLUDED("Drug Test", "Drug test result"),
    ],
  },
  PREGNANCY_CARE_PACKAGE: {
    params: [
      INCLUDED("CBC"),
      INCLUDED("Urinalysis"),
      { parameter_name: "HBsAg", ...REACTIVE_SELECT },
      { parameter_name: "Blood Type", input_type: "select", allowed_values: ["A", "B", "AB", "O"] },
      { parameter_name: "Rh Factor", input_type: "select", allowed_values: ["Positive", "Negative"] },
      { parameter_name: "Pregnancy Test", ...POS_NEG_SELECT },
    ],
  },
  DIABETIC_HEALTH_PACKAGE: {
    params: [FBS_ROW(), HBA1C_ROW(), CHOL_ROW(), TRIG_ROW(), CREATININE_ROW()],
  },
  KIDNEY_FUNCTION_PACKAGE: {
    params: [
      BUN_ROW(), CREATININE_ROW(), URIC_ACID_ROW(),
      INCLUDED("Urinalysis"),
      placeholderNumeric("Urine Protein", "g/L"),
    ],
  },
  LIVER_FUNCTION_PACKAGE: {
    params: [
      SGPT_ROW(), SGOT_ROW(),
      BILIRUBIN_ROW(),
      ALP_ROW(),
      TOTAL_PROTEIN_ROW(),
      ALBUMIN_ROW(),
    ],
  },
  LIPID_PROFILE_PACKAGE: {
    params: [CHOL_ROW(), TRIG_ROW(), HDL_ROW(), LDL_ROW(), VLDL_ROW()],
  },
  THYROID_HEALTH_PACKAGE: {
    params: [TSH_ROW(), FT3_ROW(), FT4_ROW()],
  },
  IRON_DEFICIENCY_PACKAGE: {
    params: [
      placeholderNumeric("Ferritin", "ng/mL"),
      placeholderNumeric("Serum Iron", "µmol/L"),
      placeholderNumeric("TIBC", "µmol/L"),
      INCLUDED("CBC"),
    ],
  },
  DENGUE_PACKAGE: {
    params: [
      { parameter_name: "Dengue NS1", ...REACTIVE_SELECT },
      { parameter_name: "Dengue IgG", ...REACTIVE_SELECT },
      { parameter_name: "Dengue IgM", ...REACTIVE_SELECT },
    ],
  },
};

/**
 * Section fanout — walk every active service in `section` and seed a template
 * for each, using `defaults[code]` if present or a single-param placeholder
 * otherwise. Returns { seeded, fromDefaults, placeholders }.
 */
async function seedSectionFanout(
  section: string,
  defaults: Record<string, SectionEntry>,
  skipCodes: Set<string> = new Set(),
): Promise<{ seeded: number; fromDefaults: number; placeholders: number }> {
  const { data: matched, error } = await admin
    .from("services")
    .select("id, code, name")
    .eq("section", section)
    .eq("is_active", true)
    .eq("is_send_out", false)
    .order("code");
  if (error) {
    throw new Error(`look up section=${section} services: ${error.message}`);
  }
  const services = (matched ?? []).filter(
    (s) => !s.code.startsWith("CONSULT_") && !skipCodes.has(s.code),
  );

  if (services.length === 0) {
    console.warn(`! no active services with section='${section}' — skipping`);
    return { seeded: 0, fromDefaults: 0, placeholders: 0 };
  }

  let fromDefaults = 0;
  let placeholders = 0;
  for (const svc of services) {
    const entry = defaults[svc.code];
    const layout: Layout = entry?.layout ?? "simple";
    const params: ParamSeed[] = entry?.params ?? [
      // Placeholder: single numeric param named after the test, no unit, no
      // range. The medtech can still finalise; admin fills metadata via CRUD.
      placeholderNumeric(humaniseCode(svc.code)),
    ];

    await clearExistingTemplate(svc.id, svc.code);
    await insertTemplate(svc.id, layout, params, svc.code);

    if (entry) fromDefaults += 1;
    else placeholders += 1;
  }

  console.log(
    `✓ section=${section}: seeded ${services.length} templates ` +
      `(${fromDefaults} curated, ${placeholders} placeholder)`,
  );
  return { seeded: services.length, fromDefaults, placeholders };
}

/** Strip the section prefix / underscores and Title-Case the rest. */
function humaniseCode(code: string): string {
  return code
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
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

  // Codes already handled by FIXED_TEMPLATES — skip in section fanout so
  // we don't redo work (and so the fixed template's multi_section layout for
  // URINALYSIS doesn't get clobbered by a simple-layout placeholder).
  const FIXED_CODES = new Set(FIXED_TEMPLATES.map((t) => t.service_code));

  const chem = await seedSectionFanout("chemistry",   CHEMISTRY_DEFAULTS,   FIXED_CODES);
  const imm  = await seedSectionFanout("immunology",  IMMUNOLOGY_DEFAULTS,  FIXED_CODES);
  const uri  = await seedSectionFanout("urinalysis",  URINALYSIS_DEFAULTS,  FIXED_CODES);
  const hem  = await seedSectionFanout("hematology",  HEMATOLOGY_DEFAULTS,  FIXED_CODES);
  const mic  = await seedSectionFanout("microbiology", MICROBIOLOGY_DEFAULTS, FIXED_CODES);
  const pkg  = await seedSectionFanout("package",     PACKAGE_PANELS,       FIXED_CODES);
  total += chem.seeded + imm.seeded + uri.seeded + hem.seeded + mic.seeded + pkg.seeded;

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
