// The baseline service catalog `npm run seed:services` upserts (by code).
// Kept apart from the runner so a unit test can check it without a database.
//
// `section` mirrors production for every code (checked 2026-09-25). It was
// missing entirely, so a local stack seeded from here had NO section on any
// service — medtechs could not claim Urinalysis (no section is outside every
// role's list) and the section-scoped queues and PDF gates could not be
// exercised locally. The generic CONSULT anchor is NULL on prod too.

import type { ServiceSection } from "../../src/lib/auth/role-sections";

export type ServiceKind = "lab_test" | "lab_package" | "doctor_consultation";

export interface ServiceSeed {
  code: string;
  name: string;
  description: string;
  price_php: number;
  turnaround_hours: number | null;
  kind: ServiceKind;
  section: ServiceSection | null;
}

export const SEED_SERVICES: ServiceSeed[] = [
  {
    code: "CBC",
    name: "Complete Blood Count (CBC)",
    description:
      "Measures red and white blood cells, hemoglobin, hematocrit, and platelets. Routine screening for anemia, infection, and other conditions.",
    price_php: 200,
    turnaround_hours: 4,
    kind: "lab_test",
    section: "hematology",
  },
  {
    code: "URINALYSIS",
    name: "Urinalysis",
    description:
      "Routine urine examination — physical, chemical, and microscopic — for screening of urinary-tract conditions and metabolic issues.",
    price_php: 150,
    turnaround_hours: 2,
    kind: "lab_test",
    section: "urinalysis",
  },
  {
    code: "FBS",
    name: "Fasting Blood Sugar (FBS)",
    description:
      "Blood glucose measurement after at least 8 hours of fasting. Used to screen and monitor diabetes.",
    price_php: 120,
    turnaround_hours: 4,
    kind: "lab_test",
    section: "chemistry",
  },
  {
    code: "LIPID",
    name: "Lipid Profile",
    description:
      "Total cholesterol, HDL, LDL, and triglycerides — heart-disease risk panel.",
    price_php: 500,
    turnaround_hours: 8,
    kind: "lab_package",
    section: "package",
  },
  {
    code: "THYROID",
    name: "Thyroid Function (TSH, FT4)",
    description:
      "Screens for thyroid disorders by measuring thyroid-stimulating hormone and free T4.",
    price_php: 650,
    turnaround_hours: 24,
    kind: "lab_package",
    section: "package",
  },
  {
    // Long-code panel that matches what reception orders day-to-day. The CSV
    // catalog only has separate TSH and FT4 services; this row gives us a
    // combined "Thyroid Function (TSH, FT4)" line item under the standardised
    // long-code namespace. Conservative ₱685 price matches the historical
    // mastersheet TSH line items; admin can edit via CRUD.
    code: "THYROID_FUNCTION_TSH_FT4",
    name: "Thyroid Function (TSH, FT4)",
    description:
      "TSH and FT4 combined panel — evaluates thyroid function in one order.",
    price_php: 685,
    turnaround_hours: 24,
    kind: "lab_package",
    section: "package",
  },
  {
    code: "CREA",
    name: "Creatinine",
    description: "Kidney-function screening; commonly paired with BUN.",
    price_php: 180,
    turnaround_hours: 4,
    kind: "lab_test",
    section: "chemistry",
  },
  {
    code: "SGPT",
    name: "SGPT (ALT)",
    description: "Liver-enzyme test for hepatitis and liver-injury screening.",
    price_php: 200,
    turnaround_hours: 4,
    kind: "lab_test",
    section: "chemistry",
  },
  {
    code: "SGOT",
    name: "SGOT (AST)",
    description: "Liver-enzyme test, often run alongside SGPT.",
    price_php: 200,
    turnaround_hours: 4,
    kind: "lab_test",
    section: "chemistry",
  },
  {
    code: "HBSAG",
    name: "Hepatitis B Surface Antigen (HBsAg)",
    description: "Screens for active Hepatitis B infection.",
    price_php: 350,
    turnaround_hours: 4,
    kind: "lab_test",
    section: "immunology",
  },
  {
    code: "ECG",
    name: "12-Lead ECG",
    description:
      "Electrocardiogram with same-day results and physician interpretation.",
    price_php: 400,
    turnaround_hours: 1,
    kind: "lab_test",
    section: "imaging_ecg",
  },
  {
    code: "XRAYCHEST",
    name: "Chest X-Ray (Digital)",
    description:
      "Digital chest X-ray with rapid radiologist interpretation. PA view standard.",
    price_php: 550,
    turnaround_hours: 2,
    kind: "lab_test",
    section: "imaging_xray",
  },
  {
    code: "USABDOMEN",
    name: "Whole Abdomen Ultrasound",
    description:
      "Ultrasound imaging of the liver, gallbladder, pancreas, spleen, kidneys, and bladder.",
    price_php: 1500,
    turnaround_hours: 2,
    kind: "lab_test",
    section: "imaging_ultrasound",
  },

  // Doctor consultations — one row per specialty appearing in
  // src/lib/marketing/physicians.ts. Reception assigns the specific doctor
  // on day-of based on availability (Phase 6.5 behavior; Phase 9 will let
  // patients pick a physician directly).
  // Generic manual-price consultation anchor (price typed at the counter).
  {
    code: "CONSULT",
    name: "Consultation",
    description:
      "Generic consultation service. Reception enters the actual price at the counter.",
    price_php: 0,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: null,
  },
  {
    code: "CONSULT_OBGYN",
    name: "OB-GYN consultation",
    description:
      "Consultation with an OB-GYN. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_FAMMED",
    name: "Family Medicine consultation",
    description:
      "Consultation with a Family Medicine physician. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_PEDIA",
    name: "Pediatric consultation",
    description:
      "Consultation with a Pediatrician. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_IM_CARDIO",
    name: "Cardiology consultation",
    description:
      "Internal Medicine — Cardiology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_IM_PULMO",
    name: "Pulmonology consultation",
    description:
      "Internal Medicine — Pulmonology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_IM_GASTRO",
    name: "Gastroenterology consultation",
    description:
      "Internal Medicine — Gastroenterology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_IM_ONCO",
    name: "Oncology consultation",
    description:
      "Internal Medicine — Oncology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_IM_DIABE",
    name: "Diabetology consultation",
    description:
      "Internal Medicine — Diabetology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_IM_NEPHRO",
    name: "Nephrology consultation",
    description:
      "Internal Medicine — Nephrology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_ENT",
    name: "ENT consultation",
    description:
      "Ear, Nose, and Throat consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_OPHTHA",
    name: "Ophthalmology consultation",
    description:
      "Eye consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_RADIO",
    name: "Radiology consultation",
    description:
      "Radiology consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_SURGERY",
    name: "Surgery consultation",
    description:
      "Surgery consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
  {
    code: "CONSULT_PSYCH",
    name: "Psychiatry consultation",
    description:
      "Psychiatry consultation. Reception assigns the specific doctor based on availability.",
    price_php: 500,
    turnaround_hours: null,
    kind: "doctor_consultation",
    section: "consultation",
  },
];
