/**
 * Seeds a baseline service catalog so /services has real content before
 * Phase 4 ships the admin UI. Idempotent — upserts by `code`.
 *
 *   npm run seed:services
 *
 * Replace prices to match the actual lab list whenever ready.
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

type ServiceKind = "lab_test" | "lab_package" | "doctor_consultation";

interface ServiceSeed {
  code: string;
  name: string;
  description: string;
  price_php: number;
  turnaround_hours: number | null;
  kind: ServiceKind;
}

const services: ServiceSeed[] = [
  {
    code: "CBC",
    name: "Complete Blood Count (CBC)",
    description:
      "Measures red and white blood cells, hemoglobin, hematocrit, and platelets. Routine screening for anemia, infection, and other conditions.",
    price_php: 200,
    turnaround_hours: 4,
    kind: "lab_test",
  },
  {
    code: "URINALYSIS",
    name: "Urinalysis",
    description:
      "Routine urine examination — physical, chemical, and microscopic — for screening of urinary-tract conditions and metabolic issues.",
    price_php: 150,
    turnaround_hours: 2,
    kind: "lab_test",
  },
  {
    code: "FBS",
    name: "Fasting Blood Sugar (FBS)",
    description:
      "Blood glucose measurement after at least 8 hours of fasting. Used to screen and monitor diabetes.",
    price_php: 120,
    turnaround_hours: 4,
    kind: "lab_test",
  },
  {
    code: "LIPID",
    name: "Lipid Profile",
    description:
      "Total cholesterol, HDL, LDL, and triglycerides — heart-disease risk panel.",
    price_php: 500,
    turnaround_hours: 8,
    kind: "lab_package",
  },
  {
    code: "THYROID",
    name: "Thyroid Function (TSH, FT4)",
    description:
      "Screens for thyroid disorders by measuring thyroid-stimulating hormone and free T4.",
    price_php: 650,
    turnaround_hours: 24,
    kind: "lab_package",
  },
  {
    code: "CREA",
    name: "Creatinine",
    description: "Kidney-function screening; commonly paired with BUN.",
    price_php: 180,
    turnaround_hours: 4,
    kind: "lab_test",
  },
  {
    code: "SGPT",
    name: "SGPT (ALT)",
    description: "Liver-enzyme test for hepatitis and liver-injury screening.",
    price_php: 200,
    turnaround_hours: 4,
    kind: "lab_test",
  },
  {
    code: "SGOT",
    name: "SGOT (AST)",
    description: "Liver-enzyme test, often run alongside SGPT.",
    price_php: 200,
    turnaround_hours: 4,
    kind: "lab_test",
  },
  {
    code: "HBSAG",
    name: "Hepatitis B Surface Antigen (HBsAg)",
    description: "Screens for active Hepatitis B infection.",
    price_php: 350,
    turnaround_hours: 4,
    kind: "lab_test",
  },
  {
    code: "ECG",
    name: "12-Lead ECG",
    description:
      "Electrocardiogram with same-day results and physician interpretation.",
    price_php: 400,
    turnaround_hours: 1,
    kind: "lab_test",
  },
  {
    code: "XRAYCHEST",
    name: "Chest X-Ray (Digital)",
    description:
      "Digital chest X-ray with rapid radiologist interpretation. PA view standard.",
    price_php: 550,
    turnaround_hours: 2,
    kind: "lab_test",
  },
  {
    code: "USABDOMEN",
    name: "Whole Abdomen Ultrasound",
    description:
      "Ultrasound imaging of the liver, gallbladder, pancreas, spleen, kidneys, and bladder.",
    price_php: 1500,
    turnaround_hours: 2,
    kind: "lab_test",
  },

  // Doctor consultations — one row per specialty appearing in
  // src/lib/marketing/physicians.ts. Reception assigns the specific doctor
  // on day-of based on availability (Phase 6.5 behavior; Phase 9 will let
  // patients pick a physician directly).
  {
    code: "CONSULT_OBGYN",
    name: "OB-GYN consultation",
    description:
      "Consultation with an OB-GYN. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_FAMMED",
    name: "Family Medicine consultation",
    description:
      "Consultation with a Family Medicine physician. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_PEDIA",
    name: "Pediatric consultation",
    description:
      "Consultation with a Pediatrician. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_IM_CARDIO",
    name: "Cardiology consultation",
    description:
      "Internal Medicine — Cardiology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_IM_PULMO",
    name: "Pulmonology consultation",
    description:
      "Internal Medicine — Pulmonology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_IM_GASTRO",
    name: "Gastroenterology consultation",
    description:
      "Internal Medicine — Gastroenterology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_IM_ONCO",
    name: "Oncology consultation",
    description:
      "Internal Medicine — Oncology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_IM_DIABE",
    name: "Diabetology consultation",
    description:
      "Internal Medicine — Diabetology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_IM_NEPHRO",
    name: "Nephrology consultation",
    description:
      "Internal Medicine — Nephrology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_ENT",
    name: "ENT consultation",
    description:
      "Ear, Nose, and Throat consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_OPHTHA",
    name: "Ophthalmology consultation",
    description:
      "Eye consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_RADIO",
    name: "Radiology consultation",
    description:
      "Radiology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_SURGERY",
    name: "Surgery consultation",
    description:
      "Surgery consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
  {
    code: "CONSULT_PSYCH",
    name: "Psychiatry consultation",
    description:
      "Psychiatry consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
  },
];

async function main() {
  console.log(`Seeding ${services.length} services...`);
  const { error } = await admin
    .from("services")
    .upsert(services, { onConflict: "code" });
  if (error) {
    console.error("upsert services failed", error);
    process.exit(1);
  }
  console.log("✓ Done. Services upserted (idempotent).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
