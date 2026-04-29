// Detailed diagnostic package list mirrored from drmed.ph/pages/packages.
// Edit prices and inclusions as the lab updates them.

export type PackageGroup =
  | "Basic and Routine Packages"
  | "Diabetic and Specialized"
  | "Executive Packages"
  | "More Lab Test Packages";

export interface PackageItem {
  group: PackageGroup;
  name: string;
  description: string;
  // The strikethrough "original" price; null when there's no discount displayed.
  oldPricePhp: number | null;
  pricePhp: number;
  inclusions: string[];
}

export const PACKAGES: PackageItem[] = [
  // Basic and Routine
  {
    group: "Basic and Routine Packages",
    name: "Basic Package",
    description: "Essential screening for routine checkups.",
    oldPricePhp: 1050,
    pricePhp: 950,
    inclusions: [
      "Complete Blood Count (CBC)",
      "Urinalysis",
      "Chest X-Ray (PA)",
    ],
  },
  {
    group: "Basic and Routine Packages",
    name: "Routine Package",
    description: "Comprehensive blood work for complete assessment.",
    oldPricePhp: 2498,
    pricePhp: 1999,
    inclusions: [
      "Complete Blood Count (CBC)",
      "Fasting Blood Sugar (FBS)",
      "BUN, Creatinine, Blood Uric Acid",
      "Lipid Profile",
      "SGPT / SGOT",
      "Urinalysis",
    ],
  },
  {
    group: "Basic and Routine Packages",
    name: "Annual Physical Exam",
    description: "Complete yearly health assessment package.",
    oldPricePhp: 1500,
    pricePhp: 1199,
    inclusions: [
      "Doctor's Consultation",
      "Complete Blood Count (CBC)",
      "Urinalysis and Stool Analysis",
      "Chest X-Ray (PA)",
    ],
  },

  // Diabetic and Specialized
  {
    group: "Diabetic and Specialized",
    name: "Diabetic Health Package",
    description: "Targeted monitoring for diabetic risk and management.",
    oldPricePhp: 4134,
    pricePhp: 3599,
    inclusions: [
      "Fasting Blood Sugar / HbA1c",
      "Lipid Profile",
      "Kidney Function Tests",
      "Urine Microalbumin",
      "Doctor's Consultation",
    ],
  },
  {
    group: "Diabetic and Specialized",
    name: "Dengue Package",
    description: "Rapid dengue detection and confirmation panel.",
    oldPricePhp: 2740,
    pricePhp: 2215,
    inclusions: [
      "CBC with Platelet Count",
      "NS1 Antigen",
      "Dengue IgG and IgM",
    ],
  },

  // Executive
  {
    group: "Executive Packages",
    name: "Standard Executive Package",
    description: "Essential executive screening for professionals.",
    oldPricePhp: null,
    pricePhp: 5888,
    inclusions: [
      "Consultation and Physical Exam",
      "Urinalysis, Fecalysis, FOBT",
      "CBC, FBS, BUN, Creatinine, BUA",
      "Lipid Profile, SGOT/SGPT, HbA1c",
      "Protein, Bilirubin, ALP, Electrolytes, TCa",
      "Chest X-Ray and 12-Lead ECG",
    ],
  },
  {
    group: "Executive Packages",
    name: "Comprehensive Executive Package",
    description: "Full-spectrum executive health screening.",
    oldPricePhp: null,
    pricePhp: 9588,
    inclusions: [
      "All Standard Executive inclusions",
      "Micral Test",
      "Thyroid Panel (FT3, FT4, TSH)",
      "Ultrasound — Whole Abdomen",
    ],
  },
  {
    group: "Executive Packages",
    name: "Deluxe Executive Package",
    description: "Premium screening with gender-specific inclusions.",
    oldPricePhp: null,
    pricePhp: 16288,
    inclusions: [
      "All Comprehensive Executive inclusions",
      "Amylase, LDH, CPK/CK, Bicarbonate, Phosphorus, CEA",
      "For males: PSA and prostate ultrasound",
      "For females: Pap Smear and breast exam",
    ],
  },

  // More Lab Test Packages
  {
    group: "More Lab Test Packages",
    name: "Thyroid Function Test Package",
    description: "Thyroid hormone screening package.",
    oldPricePhp: 1604,
    pricePhp: 1099,
    inclusions: ["TSH", "FT3", "FT4"],
  },
  {
    group: "More Lab Test Packages",
    name: "Lipid Profile Test Package",
    description: "Cardiovascular risk profile package.",
    oldPricePhp: 970,
    pricePhp: 699,
    inclusions: [
      "Total Cholesterol",
      "Triglycerides",
      "HDL / LDL / VLDL",
    ],
  },
  {
    group: "More Lab Test Packages",
    name: "Liver Function Test Package",
    description: "Liver enzyme and bilirubin panel.",
    oldPricePhp: 1450,
    pricePhp: 999,
    inclusions: ["SGOT / AST", "SGPT / ALT", "Bilirubin and ALP"],
  },
  {
    group: "More Lab Test Packages",
    name: "Kidney Function Test Package",
    description: "Renal markers for kidney health.",
    oldPricePhp: 970,
    pricePhp: 699,
    inclusions: [
      "Blood Urea Nitrogen (BUN)",
      "Creatinine",
      "Blood Uric Acid (BUA)",
    ],
  },
  {
    group: "More Lab Test Packages",
    name: "Iron Deficiency Package",
    description: "Iron studies for deficiency assessment.",
    oldPricePhp: 1604,
    pricePhp: 1099,
    inclusions: [
      "Serum Iron",
      "Total Iron Binding Capacity (TIBC)",
      "Ferritin",
    ],
  },
];

export const PACKAGE_GROUPS_ORDERED: PackageGroup[] = [
  "Basic and Routine Packages",
  "Diabetic and Specialized",
  "Executive Packages",
  "More Lab Test Packages",
];
