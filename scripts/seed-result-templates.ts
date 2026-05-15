/**
 * Seeds result templates for every in-house service currently in the
 * catalog, so the medtech queue page never falls back to the generic PDF
 * upload form. Real production templates are still refined / extended via
 * the admin CRUD UI; this script just gets us a working baseline.
 *
 *   npm run seed:templates
 *
 * Idempotent: removes the existing template + params for the target service
 * codes before re-inserting, so seed edits are safe to re-run.
 *
 * Templates seeded (all 12 in-house tests):
 *   Chemistry / Hematology — `simple`
 *     CBC, CREA, FBS, SGPT, SGOT, LIPID, THYROID, HBSAG
 *   Urinalysis              — `multi_section` (Physical / Chemical / Microscopic)
 *   Imaging                 — `imaging_report` (Findings + Impression text +
 *                              image attached at finalise)
 *     ECG, XRAYCHEST, USABDOMEN
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
// CBC + Differential + RBC Indices  →  'simple'
// ---------------------------------------------------------------------------
const cbc: TemplateSeed = {
  service_code: "CBC",
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
// CREA — Creatinine  →  'simple', gender-banded
// ---------------------------------------------------------------------------
const crea: TemplateSeed = {
  service_code: "CREA",
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
// FBS — Fasting Blood Sugar  →  'simple'
// ---------------------------------------------------------------------------
const fbs: TemplateSeed = {
  service_code: "FBS",
  layout: "simple",
  params: [
    {
      parameter_name: "Fasting Blood Sugar", input_type: "numeric",
      unit_si: "mg/dL",
      ref_low_si: 70, ref_high_si: 110,
    },
  ],
};

// ---------------------------------------------------------------------------
// SGPT (ALT)  →  'simple', gender-banded upper limit
// ---------------------------------------------------------------------------
const sgpt: TemplateSeed = {
  service_code: "SGPT",
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
// SGOT (AST)  →  'simple', gender-banded upper limit
// ---------------------------------------------------------------------------
const sgot: TemplateSeed = {
  service_code: "SGOT",
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
// LIPID — Lipid Profile  →  'simple', 5 params
// ---------------------------------------------------------------------------
const lipid: TemplateSeed = {
  service_code: "LIPID",
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
// THYROID — Thyroid Function (TSH + FT4)  →  'simple'
// ---------------------------------------------------------------------------
const thyroid: TemplateSeed = {
  service_code: "THYROID",
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
// HBSAG — Hepatitis B Surface Antigen  →  'simple', select
// ---------------------------------------------------------------------------
const hbsag: TemplateSeed = {
  service_code: "HBSAG",
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

const xrayChest: TemplateSeed = {
  service_code: "XRAYCHEST",
  layout: "imaging_report",
  params: [
    {
      parameter_name: "Findings", input_type: "free_text",
      placeholder: "Describe lung fields, mediastinum, heart size, bony thorax, etc.",
    },
    {
      parameter_name: "Impression", input_type: "free_text",
      placeholder: "Overall radiologic impression",
    },
  ],
};

const usAbdomen: TemplateSeed = {
  service_code: "USABDOMEN",
  layout: "imaging_report",
  params: [
    {
      parameter_name: "Findings", input_type: "free_text",
      placeholder:
        "Describe liver, gallbladder, biliary tree, pancreas, spleen, kidneys, urinary bladder.",
    },
    {
      parameter_name: "Impression", input_type: "free_text",
      placeholder: "Sonographic impression",
    },
  ],
};

const TEMPLATES: TemplateSeed[] = [
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
  xrayChest,
  usAbdomen,
];

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

  // Wipe existing template. result_template_params has ON DELETE CASCADE,
  // but result_values.parameter_id does NOT — if any historic result rows
  // reference this template's params we have to clear those first or the
  // delete fails silently inside @supabase/postgrest-js. This is a dev seed,
  // so dropping orphaned result_values is the right call; production data
  // would be touched only via the admin CRUD UI which does soft updates.
  const { data: priorTemplate } = await admin
    .from("result_templates")
    .select("id")
    .eq("service_id", serviceId)
    .maybeSingle();
  if (priorTemplate?.id) {
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
        throw new Error(
          `clear result_values for ${t.service_code}: ${rvErr.message}`,
        );
      }
    }
    const { error: delErr } = await admin
      .from("result_templates")
      .delete()
      .eq("id", priorTemplate.id);
    if (delErr) {
      throw new Error(`delete template ${t.service_code}: ${delErr.message}`);
    }
  }

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
  const rangeRows: TablesInsert<"result_template_param_ranges">[] = [];
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
    `✓ seeded ${t.service_code} (${t.layout}) with ${rows.length} params${
      rangeRows.length ? ` + ${rangeRows.length} age-banded ranges` : ""
    }`,
  );
}

async function main() {
  console.log(`Seeding ${TEMPLATES.length} result templates...`);
  for (const t of TEMPLATES) {
    await upsertTemplate(t);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
