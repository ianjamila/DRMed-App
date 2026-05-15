/**
 * Imports the April 2026 test-list CSV (~150 items) into `services`.
 *
 *   npm run import:tests
 *
 * Idempotent: upserts on `code`. Existing services that don't appear in the
 * CSV are NOT deactivated (per Phase 6.6 spec: avoid surprise deletions).
 *
 * Section + kind inference is positional — rows in the CSV are grouped by
 * blank-row dividers in this order:
 *
 *   PACKAGES + HOME SERVICE  → kind=lab_package / home_service
 *   LAB TESTS (chemistry/heme/immuno/urinalysis/microbiology, mixed)
 *   VACCINES                  → kind=vaccine
 *   X-RAY IMAGING             → kind=lab_test, section=imaging_xray
 *   ULTRASOUND IMAGING        → kind=lab_test, section=imaging_ultrasound
 *   SEND-OUT (rows tagged "*")→ is_send_out=true, section=send_out
 *
 * Within the lab-tests block, section is inferred from the test name with a
 * coarse pattern match. Admin can refine via the prices page afterwards.
 *
 * After CSV upsert, 6 packages listed only on drmed.ph (Annual Physical Exam,
 * Diabetic Health, etc.) are added with their `includes` lists as descriptions.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/database";
import { requireLocalOrExplicitProd } from "./lib/env-guard";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CSV_PATH =
  process.argv[2] ??
  "/Users/jamila/Downloads/Untitled spreadsheet - TEST LIST APRIL 2026.csv";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local",
  );
  process.exit(1);
}

requireLocalOrExplicitProd("import-test-list");

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type ServiceKind =
  | "lab_test"
  | "lab_package"
  | "doctor_consultation"
  | "doctor_procedure"
  | "home_service"
  | "vaccine";

type ServiceSection =
  | "package"
  | "chemistry"
  | "hematology"
  | "immunology"
  | "urinalysis"
  | "microbiology"
  | "imaging_xray"
  | "imaging_ultrasound"
  | "vaccine"
  | "send_out"
  | "consultation"
  | "procedure"
  | "home_service";

interface ServiceRow {
  code: string;
  name: string;
  description: string | null;
  price_php: number;
  hmo_price_php: number | null;
  senior_discount_php: number | null;
  kind: ServiceKind;
  section: ServiceSection;
  is_send_out: boolean;
  send_out_lab: string | null;
}

// "₱1,999.00" → 1999 ; "" → null ; "₱  (144.00)" → 144
function parsePeso(v: string | undefined): number | null {
  if (!v) return null;
  const s = v.trim();
  if (!s) return null;
  // Senior column wraps the discount in parens.
  const m = s.match(/\(([0-9.,]+)\)/);
  const numStr = (m ? m[1] : s.replace(/[₱\s]/g, "")).replace(/,/g, "");
  if (!numStr) return null;
  const n = Number(numStr);
  return Number.isFinite(n) ? n : null;
}

function makeCode(name: string): string {
  return name
    .toUpperCase()
    .replace(/\*+$/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

function cleanName(raw: string): string {
  return raw.replace(/\*+$/g, "").trim();
}

// Coarse section inference for the lab-tests block (rows 22-127 in the CSV).
function inferLabSection(name: string): ServiceSection {
  const u = name.toUpperCase();
  if (
    u.includes("URINE") ||
    u === "URINALYSIS" ||
    u.includes("URINALYSIS") ||
    u.includes("MICRAL") ||
    u.includes("ALB/CREA RATIO URINE")
  )
    return "urinalysis";
  if (
    u.includes("STOOL") ||
    u.includes("FECAL") ||
    u.includes("OCCULT BLOOD") ||
    u.includes("CULTURE") ||
    u.includes("GRAM STAIN") ||
    u.includes("SPUTUM AFB")
  )
    return "microbiology";
  const HEMA = new Set([
    "CBC + PC",
    "ESR",
    "BLOOD TYPING W/ RH FACTOR",
    "PROTHROMBIN TIME PT (PROTIME)",
    "PARTIAL THROMBOPLASTIN TIME PTT (APTT)",
    "BLEEDING TIME",
    "CLOTTING TIME",
    "CT/BT",
  ]);
  if (HEMA.has(u)) return "hematology";
  const IMMUNO_KEYWORDS = [
    "ANA",
    "ASO",
    "CRP",
    "HS-CRP",
    "DENGUE",
    "H. PYLORI",
    "HIV",
    "RA/RF",
    "TYPHIDOT",
    "SYPHILIS",
    "VDRL",
    "ANTI-HAV",
    "ANTI-HBS",
    "ANTI-HBE",
    "ANTI-HBC",
    "ANTI-HCV",
    "HBSAG",
    "HEPA",
    "HEPATITIS",
    "HBEAG",
    "AFP",
    "B-HCG",
    "CA 125",
    "CA 15-3",
    "CA 19-9",
    "CEA",
    "PSA",
    "PREGNANCY TEST",
  ];
  if (IMMUNO_KEYWORDS.some((kw) => u.includes(kw))) return "immunology";
  return "chemistry";
}

// Section boundaries by 1-indexed CSV row.
type Block = {
  startRow: number;
  endRow: number;
  // null lab-tests block uses inferLabSection per row.
  defaultKind: ServiceKind;
  defaultSection: ServiceSection | null;
  isSendOut?: boolean;
  sendOutLab?: string;
};

const BLOCKS: Block[] = [
  // Packages
  { startRow: 5, endRow: 15, defaultKind: "lab_package", defaultSection: "package" },
  // Home services
  { startRow: 16, endRow: 19, defaultKind: "home_service", defaultSection: "home_service" },
  // Lab tests (mixed sub-sections — inferred per row)
  { startRow: 22, endRow: 126, defaultKind: "lab_test", defaultSection: null },
  // Vaccines
  { startRow: 128, endRow: 129, defaultKind: "vaccine", defaultSection: "vaccine" },
  // X-Ray
  { startRow: 131, endRow: 179, defaultKind: "lab_test", defaultSection: "imaging_xray" },
  // Ultrasound
  { startRow: 181, endRow: 195, defaultKind: "lab_test", defaultSection: "imaging_ultrasound" },
  // Send-out
  {
    startRow: 197,
    endRow: 999,
    defaultKind: "lab_test",
    defaultSection: "send_out",
    isSendOut: true,
    sendOutLab: "Hi Precision",
  },
];

function blockFor(rowNum: number): Block | null {
  return (
    BLOCKS.find((b) => rowNum >= b.startRow && rowNum <= b.endRow) ?? null
  );
}

interface ParsedRow {
  __row: number;
  name: string;
  drmed: string;
  hmo: string;
  senior: string;
}

function parseCsv(path: string): ParsedRow[] {
  const text = readFileSync(path, "utf8");
  const result = Papa.parse<string[]>(text, {
    skipEmptyLines: false,
    header: false,
  });
  if (result.errors.length > 0) {
    // Tolerate field-count warnings; surface anything else.
    const fatal = result.errors.filter(
      (e) => e.code !== "TooFewFields" && e.code !== "TooManyFields",
    );
    if (fatal.length > 0) {
      console.warn("CSV parse warnings:", fatal);
    }
  }
  return result.data.map((cols, i) => ({
    __row: i + 1,
    name: (cols[0] ?? "").trim(),
    drmed: (cols[1] ?? "").trim(),
    hmo: (cols[2] ?? "").trim(),
    senior: (cols[3] ?? "").trim(),
  }));
}

// drmed.ph packages not in the CSV — add with descriptions.
const WEBSITE_ONLY_PACKAGES: ServiceRow[] = [
  {
    code: "ANNUAL_PHYSICAL_EXAM",
    name: "Annual Physical Exam",
    description:
      "Doctor's Consultation, CBC, Urinalysis and Stool Analysis, Chest X-Ray (PA).",
    price_php: 1199,
    hmo_price_php: null,
    senior_discount_php: null,
    kind: "lab_package",
    section: "package",
    is_send_out: false,
    send_out_lab: null,
  },
  {
    code: "DIABETIC_HEALTH_PACKAGE",
    name: "Diabetic Health Package",
    description:
      "Fasting Blood Sugar / HbA1c, Lipid Profile, Kidney Function Tests, Urine Microalbumin, Doctor's Consultation.",
    price_php: 3599,
    hmo_price_php: null,
    senior_discount_php: null,
    kind: "lab_package",
    section: "package",
    is_send_out: false,
    send_out_lab: null,
  },
  {
    code: "LIPID_PROFILE_PACKAGE",
    name: "Lipid Profile Test Package",
    description: "Total Cholesterol, Triglycerides, HDL / LDL / VLDL.",
    price_php: 699,
    hmo_price_php: null,
    senior_discount_php: null,
    kind: "lab_package",
    section: "package",
    is_send_out: false,
    send_out_lab: null,
  },
  {
    code: "LIVER_FUNCTION_PACKAGE",
    name: "Liver Function Test Package",
    description: "SGOT / AST, SGPT / ALT, Bilirubin and ALP.",
    price_php: 999,
    hmo_price_php: null,
    senior_discount_php: null,
    kind: "lab_package",
    section: "package",
    is_send_out: false,
    send_out_lab: null,
  },
  {
    code: "KIDNEY_FUNCTION_PACKAGE",
    name: "Kidney Function Test Package",
    description: "Blood Urea Nitrogen (BUN), Creatinine, Blood Uric Acid (BUA).",
    price_php: 699,
    hmo_price_php: null,
    senior_discount_php: null,
    kind: "lab_package",
    section: "package",
    is_send_out: false,
    send_out_lab: null,
  },
  {
    code: "IRON_DEFICIENCY_PACKAGE",
    name: "Iron Deficiency Package",
    description: "Serum Iron, Total Iron Binding Capacity (TIBC), Ferritin.",
    price_php: 1099,
    hmo_price_php: null,
    senior_discount_php: null,
    kind: "lab_package",
    section: "package",
    is_send_out: false,
    send_out_lab: null,
  },
];

// Map CSV package codes → drmed.ph "includes" descriptions for enrichment.
const CSV_PACKAGE_DESCRIPTIONS: Record<string, string> = {
  BASIC_PACKAGE:
    "Complete Blood Count (CBC), Urinalysis, Chest X-Ray (PA).",
  ROUTINE_PACKAGE:
    "CBC, Fasting Blood Sugar (FBS), BUN, Creatinine, Blood Uric Acid, Lipid Profile, SGPT/SGOT, Urinalysis.",
  THYROID_HEALTH_PACKAGE: "TSH, FT3, FT4.",
  DENGUE_PACKAGE:
    "CBC with Platelet Count, NS1 Antigen, Dengue IgG and IgM.",
  EXECUTIVE_PACKAGE_STANDARD:
    "Consultation and Physical Exam; Urinalysis, Fecalysis, FOBT; CBC, FBS, BUN, Creatinine, BUA; Lipid Profile, SGOT/SGPT, HbA1c; Protein, Bilirubin, ALP, Electrolytes, TCa; Chest X-Ray and 12-Lead ECG.",
  EXECUTIVE_PACKAGE_COMPREHENSIVE:
    "All Standard Executive inclusions plus Micral Test, Thyroid Panel (FT3, FT4, TSH), Whole Abdomen Ultrasound.",
  EXECUTIVE_PACKAGE_DELUXE_MEN_S:
    "All Comprehensive Executive inclusions plus Amylase, LDH, CPK/CK, Bicarbonate, Phosphorus, CEA, PSA and prostate ultrasound.",
  EXECUTIVE_PACKAGE_DELUXE_WOMEN_S:
    "All Comprehensive Executive inclusions plus Amylase, LDH, CPK/CK, Bicarbonate, Phosphorus, CEA, Pap Smear and breast exam.",
};

async function main() {
  console.log(`Reading CSV: ${resolve(CSV_PATH)}`);
  const rows = parseCsv(CSV_PATH);

  const services: ServiceRow[] = [];
  const seenCodes = new Set<string>();

  for (const r of rows) {
    if (!r.name) continue;
    if (r.name.toUpperCase() === "TEST") continue;
    // Header row (row 3) — has DRMED PRICE / HMO PRICE / SENIOR PRICE labels
    if (
      r.drmed.toUpperCase() === "DRMED PRICE" ||
      r.name.toUpperCase().startsWith("DRMED PRICE")
    )
      continue;

    const block = blockFor(r.__row);
    if (!block) continue;

    const price = parsePeso(r.drmed);
    if (price == null) {
      console.warn(
        `row ${r.__row}: skipping "${r.name}" — no parseable DRMed price`,
      );
      continue;
    }

    const cleanedName = cleanName(r.name);
    const code = makeCode(cleanedName);
    if (!code) continue;
    if (seenCodes.has(code)) {
      console.warn(`duplicate code "${code}" for "${cleanedName}" — skipping`);
      continue;
    }
    seenCodes.add(code);

    let section: ServiceSection;
    if (block.defaultSection) {
      section = block.defaultSection;
    } else {
      section = inferLabSection(cleanedName);
    }

    services.push({
      code,
      name: cleanedName,
      description: CSV_PACKAGE_DESCRIPTIONS[code] ?? null,
      price_php: price,
      hmo_price_php: parsePeso(r.hmo),
      senior_discount_php: parsePeso(r.senior),
      kind: block.defaultKind,
      section,
      is_send_out: !!block.isSendOut,
      send_out_lab: block.sendOutLab ?? null,
    });
  }

  // Add website-only packages (skip if their code already came from CSV).
  for (const p of WEBSITE_ONLY_PACKAGES) {
    if (seenCodes.has(p.code)) continue;
    services.push(p);
    seenCodes.add(p.code);
  }

  console.log(`Parsed ${services.length} services from CSV + website.`);
  const counts = services.reduce<Record<string, number>>((acc, s) => {
    acc[s.section] = (acc[s.section] ?? 0) + 1;
    return acc;
  }, {});
  console.log("Counts by section:", counts);

  // Upsert in batches so we don't blow request limits on a 200+ row import.
  const BATCH = 50;
  for (let i = 0; i < services.length; i += BATCH) {
    const batch = services.slice(i, i + BATCH);
    const { error } = await admin
      .from("services")
      .upsert(batch, { onConflict: "code" });
    if (error) {
      console.error(`upsert batch ${i / BATCH + 1} failed:`, error);
      process.exit(1);
    }
  }
  console.log(`✓ Upserted ${services.length} services (idempotent).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
