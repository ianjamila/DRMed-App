// scripts/clinical-backfill/followups/service-aliases.ts
//
// Legacy lab-service-name → catalog code map for the clinical-backfill
// "unmapped services" follow-up. 1,319 historical test_requests are pinned to the
// generic LEGACY-LAB shell with their real name preserved in
// `receptionist_remarks` ("legacy service: <NAME>"). Re-pointing them to the right
// catalog service fixes categorization in the ops analytics — it's an FK UPDATE on
// already-released rows, GL-silent (0091 guard) and money-neutral (amounts untouched).
//
// THREE TIERS (the partner-confirm + non-test names are listed, not mapped, so the
// runner only ever touches the safe-auto set — and so the spec/worksheet can show
// exactly what was deferred and why).

/** Tier 1 — SAFE-AUTO: the legacy string is an unambiguous spelling/suffix/abbrev
 *  variant of exactly ONE existing catalog service. Key = exact sheet string
 *  (as it appears after "legacy service: "); value = target catalog code. */
export const SAFE_AUTO: Readonly<Record<string, string>> = {
  "ROUTINE PACKAGE - ORIG": "ROUTINE_PACKAGE",
  "STANDARD CHEMISTRY - ORIG": "STANDARD_CHEMISTRY",
  "BASIC PACKAGE - ORIG": "BASIC_PACKAGE",
  "THYROID HEALTH PACKAGE - ORIG": "THYROID_HEALTH_PACKAGE",
  "DIABETIC HEALTH - ORIG": "DIABETIC_HEALTH_PACKAGE",
  "DIABETIC HEALTH": "DIABETIC_HEALTH_PACKAGE",
  "PRE-EMPLOYMENT": "PRE_EMPLOYMENT_PACKAGE",
  "PROTHROMBIN TIME PT": "PROTHROMBIN_TIME_PT_PROTIME",
  "PARTIAL THROMBOPLASTIN TIME PTT": "PARTIAL_THROMBOPLASTIN_TIME_PTT_APTT",
  "BLOOD TYPING": "BLOOD_TYPING_W_RH_FACTOR",
  "PREGNANCY TEST (SERUM)": "PREGNANCY_TEST",
  "PREGNANCY TEST (URINE)": "PREGNANCY_TEST",
  "HIV SCREENING": "HIV_1_2_SCREENING_QUALITATIVE",
  "ALB/CREA RATIO URINE": "ALB_CREA_RATIO_URINE_UACR",
  "OCCULT BLOOD": "OCCULT_BLOOD_FOBT",
  "ANTI-THYROXINE PEROXIDASE": "ANTI_THYROXINE_PEROXIDASE_ANTI_TPO_AMA",
  "RPR WITH TITER": "RPR_WITH_TITER_DILUTION",
  "RPR WITH DILUTION": "RPR_WITH_TITER_DILUTION",
  "MICRAL TEST": "MICRAL_MICROALBUMIN",
  "THYROGLOBULIN ANTIBODIES": "THYROGLOBULIN_ANTIBODIES_ANTI_TG",
  "PERIPHERAL BLOOD SMEAR": "PERIPHERAL_SMEAR",
  "FLU VACCINE (INFLUVAC)": "FLU_VACCINE_INFLUVAC_2026",
  "RA/RF": "RA_RF_RHEUMATOID_FACTOR",
  "TYPHIDOT": "TYPHIDOT_TYPHOID_SCREENING",
  "THYROID FUNCTION TEST - ORIG": "THYROID_FUNCTION_TSH_FT4",
  "THYROID FUNCTION TEST": "THYROID_FUNCTION_TSH_FT4",
  "CPK TOTAL": "CK_TOTAL_CREATINE_KINASE",
  "PARATHYROID HORMONE PTH": "PARATHYROID_HORMONE_PTH_ECLIA",
  "LITHIUM ASSAY": "LITHIUM",
  "ESTRADIOL (ECLIA)": "ESTRADIOL",
  "TROPONIN T (QUALI)": "TROPONIN_T_QUALITATIVE",
  "VITAMIN B12 ASSAY": "VITAMIN_B12",
};

/** Tier 2 — PARTNER-CONFIRM: needs the clinic partner because it is either a NEW
 *  service (no catalog row) or a clinically ambiguous match (wrong alias = a record
 *  error). NOT re-pointed by the runner. Value = note for the spec/worksheet. */
export const PARTNER_CONFIRM: Readonly<Record<string, string>> = {
  "LIKHAAN CORPORATE PACKAGE": "new corporate package — define contents/price",
  "[GICA BASIC 5]": "new corporate package",
  "[METAL HARDWARE CORP] SPUTUM AFB, FECALYSIS": "combined order = SPUTUM AFB + FECALYSIS (two existing tests) — split or new bundle",
  "TOTAL HEALTH": "new package — not in catalog",
  "TOTAL HEALTH - ORIG": "new package — not in catalog",
  "MEN'S HEALTH": "new package (≠ EXECUTIVE DELUXE MEN'S)",
  "MEN'S HEALTH - ORIG": "new package",
  "LIVER HEALTH": "new package, or = Liver Function Test Package? confirm",
  "LIVER HEALTH PACKAGE": "= Liver Function Test Package? confirm",
  "TROP-I QUALI": "Troponin I — catalog only has Troponin T (different analyte) → new",
  "2HR PPBS": "2-hr post-prandial blood sugar — new (≠ FBS/RBS)",
  "H. PYLORI (AG/AB)": "two H.pylori tests exist (AB, stool antigen) — confirm which",
  "PAP SMEAR HP": "Pap smear + HPV? confirm vs plain PAP SMEAR",
  "ESTRADIOL/ESTROGEN": "estradiol, or a broader estrogen panel? confirm",
  "25-OH VITAMIN D 3": "= VITAMIN D (CMIA)? confirm method/analyte",
  "HIV ELISA": "= HIV screening (qualitative)? confirm method",
  "CULTURE/SENSITIVITY": "specimen unknown (urine/stool/vaginal) → confirm",
  "A/G RATIO": "albumin/globulin ratio (computed) — new",
  "URINE KETONE": "new (or part of urinalysis) — confirm",
  "HISTOPATH - SMALL": "new histopathology service",
  "CLOSTRIDIUM DIFFICILE TOXIN": "new",
  "SCOTCH TAPE TEST": "new (pinworm)",
  "PIVKA-II (ECLIA)": "new",
  "ANTI-DS DNA": "new",
  "ANTI-SMITH (ENA PANEL)": "new",
  "ANTI-MITOCHONDRIAL AB (AMA)": "new",
  "TETANUS TOXOID VACCINE": "new vaccine",
  "XRAY - FOOT APOL": "XRAY FOOT AP/OBLIQUE? confirm view",
  "XRAY - THORACIC CAGE AP/LAT": "XRAY THORACIC/RIB CAGE? confirm view",
};

/** Tier 3 — NOT-A-TEST: a fee or payment artifact, not a lab service. Must NOT be
 *  aliased to any lab service; handled (if at all) as a fee/GC, partner-led. */
export const NOT_A_TEST: readonly string[] = [
  "HOME SERVICE FEE", "HOME SERVICE FEE 500", "HOME SERVICE FEE 700", "HOME SERVICE FEE 800",
  "HOME SERVICE FEE 900", "HOME SERVICE FEE 1000", "HOME SERVICE FEE 1100", "HOME SERVICE FEE 1200",
  "GIFT CERTIFICATE (PHP 500) PROMO",
];
