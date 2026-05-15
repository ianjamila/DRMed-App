/**
 * Populates clinical descriptions for the most common services. Idempotent:
 * only fills `description` where it is currently NULL. Run after the CSV
 * importer:
 *
 *   npm run import:descriptions
 *
 * Coverage: ~70 common Philippine lab tests + standard imaging, vaccines,
 * and consultations. Anything not covered here keeps NULL — admin can fill
 * via /staff/services/[id]/edit when needed.
 *
 * Sources: standard lab references (NIH MedlinePlus, RITM, Lab Tests Online)
 * paraphrased to a one-paragraph summary for patient-facing context.
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

requireLocalOrExplicitProd("populate-test-descriptions");

const admin = createClient<Database>(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// keys = exact `services.code` values (uppercased, underscore-joined).
const DESCRIPTIONS: Record<string, string> = {
  // ---- Hematology ----
  CBC_PC:
    "Complete Blood Count with Platelet Count. Measures red and white blood cells, hemoglobin, hematocrit, differentials, and platelets. A baseline screen for infection, anemia, bleeding disorders, and many systemic conditions.",
  ESR:
    "Erythrocyte Sedimentation Rate. Non-specific marker of inflammation; commonly ordered to monitor inflammatory or autoimmune conditions.",
  BLOOD_TYPING_W_RH_FACTOR:
    "Determines ABO blood group (A, B, AB, O) and Rh factor (positive or negative). Required for transfusions, pregnancy planning, and pre-operative work-ups.",
  PROTHROMBIN_TIME_PT_PROTIME:
    "Prothrombin Time. Measures how long blood takes to clot via the extrinsic clotting pathway. Used to monitor warfarin therapy and assess liver function.",
  PARTIAL_THROMBOPLASTIN_TIME_PTT_APTT:
    "Activated Partial Thromboplastin Time. Evaluates the intrinsic clotting pathway. Used to monitor heparin therapy and screen for bleeding disorders.",
  BLEEDING_TIME:
    "Bleeding Time. Bedside test of platelet function and primary haemostasis; commonly part of a pre-surgical clearance.",
  CLOTTING_TIME:
    "Clotting Time. Time required for whole blood to form a clot in vitro; a basic screen for severe coagulation defects.",
  CT_BT:
    "Clotting Time + Bleeding Time, run together as a basic pre-operative bleeding screen.",

  // ---- Chemistry ----
  FBS_RBS:
    "Fasting Blood Sugar / Random Blood Sugar. Measures blood glucose to screen for and monitor diabetes mellitus and hypoglycemia.",
  OGTT_75G:
    "Oral Glucose Tolerance Test (75 g). Two-hour glucose challenge used to diagnose gestational diabetes and prediabetes.",
  OGTT_100G:
    "Oral Glucose Tolerance Test (100 g). Three-hour glucose challenge used in pregnancy when 75 g screening is abnormal.",
  HBA1C:
    "Glycated Hemoglobin (HbA1c). Reflects average blood-sugar control over the past 2-3 months; a key monitoring test for diabetes.",
  BUN: "Blood Urea Nitrogen. Marker of kidney function and protein metabolism; usually ordered alongside Creatinine.",
  CREATININE:
    "Serum Creatinine. Primary marker of kidney function; abnormal values may indicate acute or chronic kidney disease.",
  BUA_URIC_ACID:
    "Blood Uric Acid. Used to screen for and monitor gout, kidney stones, and certain metabolic disorders.",
  CHOLESTEROL:
    "Total Cholesterol. Cardiovascular-risk screening; usually ordered as part of a Lipid Profile.",
  TRIGLYCERIDES:
    "Triglycerides. Blood-fat measurement used in cardiovascular risk assessment and metabolic syndrome screening.",
  HDL_LDL_VLDL:
    "HDL / LDL / VLDL Cholesterol. Lipoprotein fractions used to estimate atherosclerotic cardiovascular risk.",
  LIPID_PROFILE:
    "Lipid Profile. Combined Total Cholesterol, Triglycerides, HDL, LDL, and VLDL. Standard cardiovascular-risk screen.",
  BILIRUBIN:
    "Total / Direct / Indirect Bilirubin. Indicator of liver function and red blood cell breakdown.",
  ALBUMIN:
    "Serum Albumin. Major blood protein; reflects nutritional status and liver/kidney function.",
  GLOBULIN:
    "Serum Globulin. Protein fraction including immunoglobulins; abnormalities can suggest infection, inflammation, or liver disease.",
  TOTAL_PROTEIN:
    "Total Protein. Sum of albumin and globulins; a general marker of nutrition, liver, and kidney status.",
  TPAG:
    "Total Protein, Albumin, and Globulin (with A/G ratio). Combined panel for nutritional and liver assessment.",
  NA: "Sodium (Na). Electrolyte essential for fluid balance and nerve function.",
  K: "Potassium (K). Electrolyte critical for muscle and cardiac function.",
  CL: "Chloride (Cl). Electrolyte that helps regulate fluid balance and acid-base status.",
  CA: "Total Calcium. Mineral important for bone, muscle, and nerve function.",
  ICA: "Ionized Calcium (iCa). Active form of calcium in the blood; preferred test in critical care or parathyroid evaluation.",
  MG: "Magnesium. Mineral essential for muscle, nerve, and cardiac function.",
  PHOSPHORUS:
    "Phosphorus. Mineral important for bone health and energy metabolism.",
  TIBC:
    "Total Iron Binding Capacity. Reflects the blood's ability to bind iron; used together with serum iron to evaluate iron-deficiency anemia.",
  FERRITIN:
    "Ferritin. Iron storage protein; the most sensitive single marker of iron stores.",
  SGOT_AST:
    "SGOT / AST (Aspartate Aminotransferase). Liver enzyme released with hepatocellular injury; also elevated in cardiac and muscle damage.",
  SGPT_ALT:
    "SGPT / ALT (Alanine Aminotransferase). Liver enzyme more specific for hepatocellular injury (e.g. hepatitis, fatty liver).",
  ALP: "Alkaline Phosphatase. Enzyme elevated in liver and bone disorders.",
  AMYLASE:
    "Serum Amylase. Pancreatic enzyme; elevated in acute pancreatitis and salivary gland disease.",
  CK_TOTAL_CREATINE_KINASE:
    "Total Creatine Kinase. Enzyme released by muscle injury, including cardiac, skeletal, and brain tissue.",
  CK_MB:
    "Creatine Kinase MB fraction. Cardiac muscle isoform; historically used to detect myocardial injury (now largely supplanted by Troponin).",
  CK_MM:
    "Creatine Kinase MM fraction. Skeletal muscle isoform; useful in suspected muscle disorders.",
  GGTP:
    "Gamma-Glutamyl Transpeptidase. Liver enzyme that helps differentiate hepatic vs. bone causes of elevated ALP; sensitive to alcohol-related liver injury.",
  LDH:
    "Lactate Dehydrogenase. Non-specific marker of tissue damage (liver, heart, muscle, blood cells).",
  LIPASE:
    "Serum Lipase. Pancreatic enzyme; preferred over amylase for diagnosing acute pancreatitis.",
  FSH: "Follicle-Stimulating Hormone. Pituitary hormone used in fertility, menopause, and gonadal-function evaluation.",
  LH: "Luteinizing Hormone. Pituitary hormone for fertility and ovulation assessment.",
  PROLACTIN:
    "Prolactin. Pituitary hormone evaluated in infertility, irregular menses, galactorrhea, or suspected pituitary tumors.",

  // ---- Thyroid ----
  TSH: "Thyroid-Stimulating Hormone. Primary screen for thyroid function (hypo- and hyperthyroidism).",
  FT3: "Free Triiodothyronine. Active thyroid hormone fraction; ordered with TSH and FT4 to evaluate thyroid function.",
  FT4: "Free Thyroxine. Free fraction of T4; used with TSH to confirm hypo- or hyperthyroidism.",
  T3: "Total Triiodothyronine. Total T3 measurement; less specific than Free T3 in many clinical settings.",
  T4: "Total Thyroxine. Total T4 measurement; usually paired with TSH and FT4.",

  // ---- Urinalysis & related ----
  URINALYSIS:
    "Routine Urinalysis. Physical, chemical, and microscopic examination of urine; screens for urinary tract infection, kidney disease, and metabolic conditions such as diabetes.",
  MICRAL_MICROALBUMIN:
    "Micral / Urine Microalbumin. Detects very small amounts of albumin in urine; an early marker of diabetic kidney disease.",
  ALB_CREA_RATIO_URINE_UACR:
    "Urine Albumin-to-Creatinine Ratio (UACR). Spot urine test used to screen for diabetic nephropathy and chronic kidney disease.",
  URINE_PROTEIN:
    "Urine Protein. Quantifies protein loss in urine; a marker of kidney damage.",
  URINE_CREATININE:
    "Urine Creatinine. Used as a denominator for spot-urine ratios such as UACR and protein/creatinine ratio.",
  URINE_CREA_CLEARANCE:
    "Creatinine Clearance. 24-hour urine collection used to estimate glomerular filtration rate (kidney function).",
  PROTEIN_CREA_RATIO_URINE:
    "Urine Protein-to-Creatinine Ratio. Spot urine alternative to a 24-hour collection for proteinuria.",
  PREGNANCY_TEST:
    "Urine Pregnancy Test. Detects beta-hCG to confirm or rule out pregnancy.",
  URINE_RBC_MORPHOLOGY:
    "Urine Red Blood Cell Morphology. Microscopic exam to differentiate between glomerular (kidney) and lower urinary tract sources of hematuria.",

  // ---- Microbiology / Stool ----
  URINE_CULTURE_SENSITIVITY:
    "Urine Culture and Sensitivity. Identifies bacteria causing urinary tract infections and the antibiotics they respond to.",
  STOOL_CULTURE_SENSITIVITY:
    "Stool Culture and Sensitivity. Identifies bacterial pathogens responsible for diarrhea or gastroenteritis.",
  OCCULT_BLOOD_FOBT:
    "Fecal Occult Blood Test (FOBT). Detects hidden blood in stool; used in colorectal cancer screening and GI bleed evaluation.",
  FECALYSIS:
    "Fecalysis. Routine stool examination including consistency, parasites, and ova screening.",
  GRAM_STAIN:
    "Gram Stain. Microscopic technique that classifies bacteria as Gram-positive or Gram-negative; guides empiric antibiotic choice.",
  SPUTUM_AFB:
    "Sputum Acid-Fast Bacilli (AFB) smear. Microscopic exam to detect Mycobacterium tuberculosis in patients suspected of having TB.",

  // ---- Immunology / Serology ----
  ANA: "Antinuclear Antibody (ANA). Screens for autoimmune conditions such as systemic lupus erythematosus.",
  ASO: "Antistreptolysin O (ASO) titer. Confirms recent group A streptococcal infection (e.g. rheumatic fever, glomerulonephritis).",
  CRP: "C-Reactive Protein. Acute-phase reactant elevated in infection and inflammation.",
  HS_CRP:
    "High-Sensitivity C-Reactive Protein. Lower-range CRP used as a cardiovascular-risk marker.",
  RA_RF_RHEUMATOID_FACTOR:
    "Rheumatoid Factor. Antibody screen used in evaluation of suspected rheumatoid arthritis and other autoimmune conditions.",
  TYPHIDOT_TYPHOID_SCREENING:
    "Typhidot. Rapid serologic screening for typhoid fever (Salmonella typhi).",
  SYPHILIS_TPHA_SCREENING_TREPONEMA_PALLIDUM:
    "Treponema Pallidum Hemagglutination Assay. Specific syphilis screening test.",
  SYPHILIS_TPHA_WITH_TITER:
    "TPHA with Titer. Quantitative syphilis test useful for staging and treatment monitoring.",
  VDRL_RPR:
    "VDRL / RPR. Non-treponemal screening tests for syphilis; titers help track treatment response.",
  H_PYLORI_AB:
    "Helicobacter pylori Antibody. Detects past or current H. pylori infection, a major cause of peptic ulcer disease.",
  HIV_1_2_SCREENING_QUALITATIVE:
    "HIV 1 & 2 Screening. Antibody-based screening test for HIV infection. Confirmatory testing required if reactive.",
  DENGUE_NS1:
    "Dengue NS1 Antigen. Detects dengue virus protein during the early febrile phase (days 1-7) of illness.",
  DENGUE_DUO:
    "Dengue Duo. Combined NS1 antigen and IgM/IgG antibody test for early and convalescent dengue diagnosis.",
  DENGUE_BLOT_IGG_IGM:
    "Dengue IgG / IgM. Serologic test that distinguishes recent (IgM) from past (IgG) dengue infection.",

  // ---- Hepatitis profile ----
  HBSAG_SCREENING:
    "Hepatitis B Surface Antigen Screening. Primary screen for active Hepatitis B infection.",
  HBSAG_TITER:
    "HBsAg Titer. Quantitative measurement of Hepatitis B Surface Antigen; useful in monitoring chronic Hepatitis B.",
  ANTI_HBS:
    "Anti-HBs. Antibody to Hepatitis B Surface Antigen; reflects immunity from prior infection or successful vaccination.",
  HBEAG:
    "Hepatitis B e Antigen. Marker of active viral replication in chronic Hepatitis B.",
  ANTI_HBE:
    "Anti-HBe. Antibody to Hepatitis B e Antigen; usually indicates lower infectivity.",
  ANTI_HBC_IGM:
    "Anti-HBc IgM. Indicates recent or acute Hepatitis B infection.",
  ANTI_HBC_IGG:
    "Anti-HBc IgG. Indicates past Hepatitis B exposure (resolved or chronic).",
  HEPATITIS_B_PROFILE:
    "Hepatitis B Profile. Combined panel (HBsAg, Anti-HBs, Anti-HBc) for full infection / immunity status.",
  ANTI_HCV:
    "Anti-HCV. Antibody screening test for Hepatitis C virus exposure.",
  ANTI_HAV_IGM:
    "Anti-HAV IgM. Indicates acute Hepatitis A infection.",
  ANTI_HAV_IGG:
    "Anti-HAV IgG. Indicates past Hepatitis A infection or vaccine-induced immunity.",
  HEPA_A_SCREENING:
    "Hepatitis A Screening. Initial test for Hepatitis A virus exposure.",
  HEPATITIS_A_PROFILE:
    "Hepatitis A Profile. Combined IgM and IgG to characterize acute vs. past Hepatitis A infection.",

  // ---- Tumor markers ----
  AFP:
    "Alpha-Fetoprotein. Tumor marker for liver cancer; also used in pregnancy screening for neural tube defects.",
  B_HCG:
    "Beta-hCG (Quantitative). Pregnancy hormone; also a tumor marker for germ-cell and trophoblastic tumors.",
  CA_125:
    "CA 125. Tumor marker primarily monitored in ovarian cancer.",
  CA_15_3:
    "CA 15-3. Tumor marker monitored in breast cancer recurrence.",
  CA_19_9:
    "CA 19-9. Tumor marker monitored in pancreatic and biliary cancers.",
  CEA:
    "Carcinoembryonic Antigen. Tumor marker monitored in colorectal cancer (and others); not used as a stand-alone screening test.",
  PSA:
    "Prostate-Specific Antigen. Screening and monitoring marker for prostate disease, including benign hyperplasia and prostate cancer.",

  // ---- Cardiology ----
  ECG:
    "12-Lead Electrocardiogram. Records electrical activity of the heart to detect arrhythmia, ischemia, and other cardiac conditions.",

  // ---- Vaccines ----
  HEPATITIS_B_VACCINE:
    "Hepatitis B Vaccine. Active immunization against Hepatitis B virus. Standard adult schedule is 0, 1, and 6 months.",
  FLU_VACCINE_INFLUVAC_2026:
    "Influenza Vaccine (Influvac, 2026 strain). Annual seasonal flu shot; recommended for adults, pregnant women, and high-risk groups.",

  // ---- Imaging — X-Ray ----
  XRAY_CHEST_PA:
    "Chest X-Ray, Posterior-Anterior view. Standard chest film used to evaluate the lungs, heart, and mediastinum.",
  XRAY_CHEST_PA_LAT_ADULT:
    "Chest X-Ray, PA and Lateral views (adult). Two-view chest film providing additional depth for cardiopulmonary evaluation.",
  XRAY_CHEST_AP_LAT_PEDIA:
    "Chest X-Ray, AP and Lateral views (pediatric). Standard pediatric chest film.",
  XRAY_KUB_AP:
    "Kidney-Ureter-Bladder X-Ray (KUB). Plain abdominal film used to look for renal calculi and bowel patterns.",
  XRAY_PARANASAL_SERIES:
    "Paranasal Sinus Series. Multi-view X-ray to assess sinusitis or facial trauma.",

  // ---- Imaging — Ultrasound ----
  ULTRASOUND_WHOLE_ABDOMEN:
    "Whole Abdomen Ultrasound. Imaging of liver, gallbladder, pancreas, spleen, kidneys, and bladder.",
  ULTRASOUND_KUB:
    "Kidney-Ureter-Bladder Ultrasound. Focused exam of the urinary tract for stones, hydronephrosis, and bladder pathology.",
  ULTRASOUND_KIDNEYS:
    "Kidneys Ultrasound. Detailed imaging of both kidneys.",
  ULTRASOUND_LIVER:
    "Liver Ultrasound. Focused imaging of the liver for cysts, masses, and parenchymal changes.",
  ULTRASOUND_HEPATOBILIARY_TRACT_HBT:
    "Hepatobiliary Tract Ultrasound (HBT). Liver, gallbladder, and biliary tree imaging — commonly ordered for right-upper-quadrant pain.",
  ULTRASOUND_PROSTATE_TRANSABDOMINAL:
    "Prostate Ultrasound (Transabdominal). Non-invasive prostate exam through the lower abdomen.",
  ULTRASOUND_PROSTATE_TRANSRECTAL:
    "Prostate Ultrasound (Transrectal). Detailed prostate exam through the rectum, often for biopsy guidance.",
  ULTRASOUND_PELVIC:
    "Pelvic Ultrasound. Transabdominal imaging of pelvic organs.",
  ULTRASOUND_PELVIC_OB:
    "Obstetric Pelvic Ultrasound. Pregnancy ultrasound to assess fetal growth and well-being.",
  ULTRASOUND_TRANSVAGINAL:
    "Transvaginal Ultrasound. High-resolution imaging of the uterus, ovaries, and early pregnancy via the vagina.",
  ULTRASOUND_TRANSRECTAL:
    "Transrectal Ultrasound. High-resolution imaging of the prostate or pelvic organs via the rectum.",

  // ---- Doctor consultations ----
  CONSULT_OBGYN:
    "Consultation with an Obstetrician-Gynecologist. Reception assigns the specific doctor based on availability.",
  CONSULT_FAMMED:
    "Consultation with a Family Medicine physician for general adult and pediatric primary care.",
  CONSULT_PEDIA:
    "Consultation with a Pediatrician for infants, children, and adolescents.",
  CONSULT_IM_CARDIO:
    "Internal Medicine — Cardiology consultation. For chest pain, hypertension, arrhythmia, or known cardiac conditions.",
  CONSULT_IM_PULMO:
    "Internal Medicine — Pulmonology consultation. For chronic cough, asthma, COPD, sleep apnea, or other respiratory issues.",
  CONSULT_IM_GASTRO:
    "Internal Medicine — Gastroenterology consultation. For digestive, liver, and biliary conditions.",
  CONSULT_IM_ONCO:
    "Internal Medicine — Medical Oncology consultation. For cancer screening, diagnosis, and treatment.",
  CONSULT_IM_DIABE:
    "Internal Medicine — Diabetology consultation. For diabetes management and metabolic conditions.",
  CONSULT_IM_NEPHRO:
    "Internal Medicine — Nephrology consultation. For kidney disease and electrolyte disorders.",
  CONSULT_ENT:
    "Ear, Nose, and Throat (Otolaryngology) consultation. For sinus, hearing, throat, and head-and-neck concerns.",
  CONSULT_OPHTHA:
    "Ophthalmology consultation. For eye exams, vision changes, and ocular disease.",
  CONSULT_RADIO:
    "Radiology consultation. For interpretation of imaging studies and procedural planning.",
  CONSULT_SURGERY:
    "Surgery consultation. For pre- and post-operative evaluation of general-surgical conditions.",
  CONSULT_PSYCH:
    "Psychiatry consultation. For mental health evaluation and treatment.",
};

async function main() {
  const codes = Object.keys(DESCRIPTIONS);
  console.log(`Populating descriptions for up to ${codes.length} services...`);

  // Only fill where description IS NULL — never overwrite existing copy.
  const { data: existing, error } = await admin
    .from("services")
    .select("id, code, description")
    .in("code", codes);

  if (error) {
    console.error("read failed:", error);
    process.exit(1);
  }

  const updates = (existing ?? []).filter((s) => !s.description);
  console.log(
    `Found ${existing?.length ?? 0} matching codes; ${updates.length} need descriptions.`,
  );

  let written = 0;
  for (const s of updates) {
    const desc = DESCRIPTIONS[s.code];
    if (!desc) continue;
    const { error: updErr } = await admin
      .from("services")
      .update({ description: desc })
      .eq("id", s.id);
    if (updErr) {
      console.error(`update ${s.code} failed:`, updErr.message);
      continue;
    }
    written++;
  }
  console.log(`✓ Wrote ${written} descriptions.`);

  const missing = codes.filter(
    (c) => !(existing ?? []).some((s) => s.code === c),
  );
  if (missing.length > 0) {
    console.log(
      `Note: ${missing.length} codes in the script aren't in the DB yet (skipped):`,
      missing.slice(0, 10).join(", "),
      missing.length > 10 ? `…and ${missing.length - 10} more` : "",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
