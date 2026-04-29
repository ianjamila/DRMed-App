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

interface ServiceSeed {
  code: string;
  name: string;
  description: string;
  price_php: number;
  turnaround_hours: number;
}

const services: ServiceSeed[] = [
  {
    code: "CBC",
    name: "Complete Blood Count (CBC)",
    description:
      "Measures red and white blood cells, hemoglobin, hematocrit, and platelets. Routine screening for anemia, infection, and other conditions.",
    price_php: 200,
    turnaround_hours: 4,
  },
  {
    code: "URINALYSIS",
    name: "Urinalysis",
    description:
      "Routine urine examination — physical, chemical, and microscopic — for screening of urinary-tract conditions and metabolic issues.",
    price_php: 150,
    turnaround_hours: 2,
  },
  {
    code: "FBS",
    name: "Fasting Blood Sugar (FBS)",
    description:
      "Blood glucose measurement after at least 8 hours of fasting. Used to screen and monitor diabetes.",
    price_php: 120,
    turnaround_hours: 4,
  },
  {
    code: "LIPID",
    name: "Lipid Profile",
    description:
      "Total cholesterol, HDL, LDL, and triglycerides — heart-disease risk panel.",
    price_php: 500,
    turnaround_hours: 8,
  },
  {
    code: "THYROID",
    name: "Thyroid Function (TSH, FT4)",
    description:
      "Screens for thyroid disorders by measuring thyroid-stimulating hormone and free T4.",
    price_php: 650,
    turnaround_hours: 24,
  },
  {
    code: "CREA",
    name: "Creatinine",
    description: "Kidney-function screening; commonly paired with BUN.",
    price_php: 180,
    turnaround_hours: 4,
  },
  {
    code: "SGPT",
    name: "SGPT (ALT)",
    description: "Liver-enzyme test for hepatitis and liver-injury screening.",
    price_php: 200,
    turnaround_hours: 4,
  },
  {
    code: "SGOT",
    name: "SGOT (AST)",
    description: "Liver-enzyme test, often run alongside SGPT.",
    price_php: 200,
    turnaround_hours: 4,
  },
  {
    code: "HBSAG",
    name: "Hepatitis B Surface Antigen (HBsAg)",
    description: "Screens for active Hepatitis B infection.",
    price_php: 350,
    turnaround_hours: 4,
  },
  {
    code: "ECG",
    name: "12-Lead ECG",
    description:
      "Electrocardiogram with same-day results and physician interpretation.",
    price_php: 400,
    turnaround_hours: 1,
  },
  {
    code: "XRAYCHEST",
    name: "Chest X-Ray (Digital)",
    description:
      "Digital chest X-ray with rapid radiologist interpretation. PA view standard.",
    price_php: 550,
    turnaround_hours: 2,
  },
  {
    code: "USABDOMEN",
    name: "Whole Abdomen Ultrasound",
    description:
      "Ultrasound imaging of the liver, gallbladder, pancreas, spleen, kidneys, and bladder.",
    price_php: 1500,
    turnaround_hours: 2,
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
