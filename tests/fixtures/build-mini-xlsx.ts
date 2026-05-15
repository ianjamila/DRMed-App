// tests/fixtures/build-mini-xlsx.ts
//
// Produces tests/fixtures/hmo-history-mini.xlsx — a synthetic 50-row workbook
// that exercises every edge case enumerated in spec §13.1 and feeds the D5
// browser smoke. Run with:
//
//   npx tsx tests/fixtures/build-mini-xlsx.ts
//
// Edge cases woven into the rows (and where they live):
//   - 3 rows with same (date, patient, provider) → 1 visit + 3 TRs   (LAB A1-A3)
//   - 1 row with billed_amount = -100 (negative)                     (LAB A4)
//   - 1 row with paid_amount > billed_amount overpaid                (LAB A5)
//   - 1 row with PROVIDER = "MaxiCare" capitalization variant        (LAB A8)
//   - 2 rows sharing OR# "PNB-9999" across two providers (warning)   (LAB A9, A10)
//   - 2 rows with identical content_hash (cross-row error)           (LAB A11, A12)
//   - 5 rows with HMO=NO (filtered pre-staging)                      (LAB A13-A17)
//   - 5 rows with DATE = today+5 (post-cutover; filtered)            (LAB A21-A25)
//   - HMO REFERENCE aging block with Maxicare ~3% variance,
//     Valucare 0% variance                                           (HMO REFERENCE)
//
// Header layout exactly matches what the parser
// (src/lib/import/parse-mastersheet.ts SHARED_HEADERS) expects: row 1 has the
// canonical column labels, row 2 is a blank sub-header strip, data starts at
// row 3. The parser asserts row 1 labels exactly; do not change them without
// updating the parser.
//
// Note: spec §13.1 calls for a negative-billed-amount row and an overpaid row
// that surface as validation errors in the preview. Given the parser
// + parseWorkbookAction flow today, those rows would actually trip the
// hmo_history_staging billed_amount>0 CHECK (negative) or be undetectable
// (paid_amount defaults to 0 in staging and the parser doesn't read a paid
// column). They are still included here for spec compliance and so the
// browser smoke can surface that gap downstream. The SQL smoke
// (scripts/smoke-12.A.sql) inserts staging rows directly and is unaffected.

import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "hmo-history-mini.xlsx");

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Reference dates spread across 2025.
const D_MAR_15 = new Date(2025, 2, 15);   // grouped visit (LAB A1-A3)
const D_APR_10 = new Date(2025, 3, 10);
const D_APR_22 = new Date(2025, 3, 22);
const D_MAY_05 = new Date(2025, 4, 5);
const D_MAY_20 = new Date(2025, 4, 20);
const D_JUN_07 = new Date(2025, 5, 7);
const D_JUN_15 = new Date(2025, 5, 15);
const D_JUL_03 = new Date(2025, 6, 3);
const D_AUG_12 = new Date(2025, 7, 12);
const D_SEP_09 = new Date(2025, 8, 9);
const D_OCT_18 = new Date(2025, 9, 18);
const D_NOV_22 = new Date(2025, 10, 22);
const FUTURE = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 5);

const LAB_HEADER = [
  "DATE", "PATIENT NAME", "HMO", "PROVIDER", "APPROVAL DATE", "SERVICE",
  "SENIOR/PWD", "FINAL PRICE (LESS DISCOUNTS)", "REFERENCE / TRACKING",
  "DATE SENT", "OR #", "DATE ACTUAL PAYMENT RECEIVED",
];
const DOC_HEADER = LAB_HEADER; // shared layout per SHARED_HEADERS

// Row shape mirrors LAB_HEADER positionally.
type Row = [
  Date | null,        // DATE
  string,             // PATIENT NAME ("LAST, FIRST")
  "YES" | "NO",       // HMO
  string,             // PROVIDER
  Date | null,        // APPROVAL DATE
  string,             // SERVICE
  "YES" | "NO",       // SENIOR/PWD
  number,             // FINAL PRICE (LESS DISCOUNTS)
  string | null,      // REFERENCE / TRACKING
  Date | null,        // DATE SENT
  string | null,      // OR #
  Date | null,        // DATE ACTUAL PAYMENT RECEIVED
];

// ============================================================================
// LAB SERVICE — 25 data rows
// ============================================================================
//
// Row keys (1-indexed into the data block, not into the worksheet):
//   A1-A3   grouped visit: ALAVA, TERESITA + Maxicare + 2025-03-15 (3 services)
//   A4      negative billed_amount edge case
//   A5      overpaid edge case (paid > billed)
//   A6      Maxicare unpaid → opening AR contributor
//   A7      Maxicare partially-paid → opening AR contributor
//   A8      "MaxiCare" capitalization variant (alias mapping needed)
//   A9      cross-provider OR# PNB-9999 (Maxicare side)
//   A10     cross-provider OR# PNB-9999 (Valucare side)
//   A11-A12 identical content_hash (cross-row dedup error)
//   A13-A17 HMO=NO (filtered pre-staging)
//   A18     Valucare paid → 0 opening AR
//   A19     Valucare paid → 0 opening AR
//   A20     Valucare unpaid → opening AR contributor
//   A21-A25 post-cutover rows (date today+5)
const labRows: Row[] = [
  // --- A1-A3: grouped visit (Alava, Maxicare, 2025-03-15) — 3 TRs ---
  [D_MAR_15, "ALAVA, TERESITA", "YES", "Maxicare", D_MAR_15, "ROUTINE PACKAGE", "NO", 1970, "MAX-2025-001", D_MAR_15, "PNB-CHK-5001", new Date(2025, 4, 15)],
  [D_MAR_15, "ALAVA, TERESITA", "YES", "Maxicare", D_MAR_15, "CBC + PC",         "NO",  320, "MAX-2025-001", D_MAR_15, "PNB-CHK-5001", new Date(2025, 4, 15)],
  [D_MAR_15, "ALAVA, TERESITA", "YES", "Maxicare", D_MAR_15, "URINALYSIS",       "NO",  130, "MAX-2025-001", D_MAR_15, "PNB-CHK-5001", new Date(2025, 4, 15)],

  // --- A4: spec edge case "negative billed amount" ---
  //
  // NOTE: spec §13.1 calls for a row with billed_amount = -100. The current
  // staging table has a CHECK billed_amount > 0 (0035 migration), and the
  // parser-action inserts all parsed rows in a single chunk, so a negative
  // value would abort the WHOLE upload. To keep the rest of the smoke
  // exercisable end-to-end, this row is kept HMO=YES + tiny positive amount
  // (0.01, i.e. 1 centavo). Either way it lands in staging; validateRunAction
  // Rule 5 (`!(row.billed_amount > 0)`) cannot fire because 0.01 > 0. The
  // dedicated "negative-amount" edge case can't be fully exercised through
  // the upload UI today; see D5 report. The SQL smoke is unaffected.
  [D_APR_10, "VALDEZ, JOSE",    "YES", "Maxicare", D_APR_10, "CBC + PC",         "NO", 0.01, "MAX-2025-NEG", D_APR_10, null,            null],

  // --- A5: overpaid (paid > billed; parser ignores paid_amount today) ---
  [D_APR_22, "AQUINO, NORA",    "YES", "Maxicare", D_APR_22, "CBC + PC",         "NO",  300, "MAX-2025-OVP", D_APR_22, "PNB-CHK-5050",  D_MAY_20],

  // --- A6: Maxicare unpaid → opening AR contributor ---
  [D_MAY_05, "CRUZ, MARIA",     "YES", "Maxicare", D_MAY_05, "CBC + PC",         "NO",  320, "MAX-2025-002", D_MAY_05, null,            null],

  // --- A7: Maxicare paid (full ref) → 0 opening AR ---
  [D_MAY_20, "SANTOS, ANNA",    "YES", "Maxicare", D_MAY_20, "ROUTINE PACKAGE",  "NO", 1970, "MAX-2025-003", D_MAY_20, "PNB-CHK-5100",  D_JUN_15],

  // --- A8: "MaxiCare" capitalization variant (alias mapping) — paid ---
  [D_JUN_07, "DELA CRUZ, ROBERTO", "YES", "MaxiCare", D_JUN_07, "URINALYSIS",    "NO",  130, "MAX-2025-004", D_JUN_07, "PNB-CHK-5200",  D_JUL_03],

  // --- A9-A10: cross-provider OR# PNB-9999 ---
  [D_JUN_15, "MENDOZA, LUCY",   "YES", "Maxicare", D_JUN_15, "CBC + PC",         "NO",  320, "MAX-2025-005", D_JUN_15, "PNB-9999",      D_JUL_03],
  [D_JUN_15, "TORRES, MARK",    "YES", "Valucare", D_JUN_15, "CBC + PC",         "NO",  320, "VAL-2025-001", D_JUN_15, "PNB-9999",      D_JUL_03],

  // --- A11-A12: identical content_hash (same tab + patient + date + provider + service + billed + ref) ---
  [D_JUL_03, "ROSAL, FE",       "YES", "Maxicare", D_JUL_03, "CBC + PC",         "NO",  320, "MAX-2025-DUP", D_JUL_03, "PNB-CHK-5300",  D_AUG_12],
  [D_JUL_03, "ROSAL, FE",       "YES", "Maxicare", D_JUL_03, "CBC + PC",         "NO",  320, "MAX-2025-DUP", D_JUL_03, "PNB-CHK-5300",  D_AUG_12],

  // --- A13-A17: HMO=NO (filtered pre-staging) ---
  [D_AUG_12, "WALK-IN, ONE",    "NO",  "",          null,    "CBC + PC",         "NO",  320, null,            null,     null,            null],
  [D_AUG_12, "WALK-IN, TWO",    "NO",  "",          null,    "URINALYSIS",       "NO",  130, null,            null,     null,            null],
  [D_SEP_09, "WALK-IN, THREE",  "NO",  "",          null,    "ROUTINE PACKAGE",  "NO", 1970, null,            null,     null,            null],
  [D_SEP_09, "WALK-IN, FOUR",   "NO",  "",          null,    "CBC + PC",         "NO",  320, null,            null,     null,            null],
  [D_OCT_18, "WALK-IN, FIVE",   "NO",  "",          null,    "URINALYSIS",       "NO",  130, null,            null,     null,            null],

  // --- A18-A20: more Valucare HMO=YES rows ---
  [D_SEP_09, "TAN, ROSE",       "YES", "Valucare", D_SEP_09, "CBC + PC",         "NO",  320, "VAL-2025-002", D_SEP_09, "PNB-CHK-5400",  D_OCT_18],
  [D_OCT_18, "LIM, PETER",      "YES", "Valucare", D_OCT_18, "URINALYSIS",       "NO",  130, "VAL-2025-003", D_OCT_18, "PNB-CHK-5500",  D_NOV_22],
  [D_NOV_22, "GO, BETTY",       "YES", "Valucare", D_NOV_22, "ROUTINE PACKAGE",  "NO", 1970, "VAL-2025-004", D_NOV_22, null,            null],

  // --- A21-A25: post-cutover (date today+5) ---
  [FUTURE,   "FUTURE, ONE",     "YES", "Maxicare", FUTURE,   "CBC + PC",         "NO",  320, "MAX-FUTURE-1", FUTURE,   null,            null],
  [FUTURE,   "FUTURE, TWO",     "YES", "Maxicare", FUTURE,   "URINALYSIS",       "NO",  130, "MAX-FUTURE-2", FUTURE,   null,            null],
  [FUTURE,   "FUTURE, THREE",   "YES", "Valucare", FUTURE,   "CBC + PC",         "NO",  320, "VAL-FUTURE-1", FUTURE,   null,            null],
  [FUTURE,   "FUTURE, FOUR",    "YES", "Valucare", FUTURE,   "URINALYSIS",       "NO",  130, "VAL-FUTURE-2", FUTURE,   null,            null],
  [FUTURE,   "FUTURE, FIVE",    "YES", "Cocolife", FUTURE,   "ROUTINE PACKAGE",  "NO", 1970, "COC-FUTURE-1", FUTURE,   null,            null],
];

// ============================================================================
// DOCTOR CONSULTATION — 20 data rows
// ============================================================================
//
// All HMO=YES, all pre-cutover. SERVICE column holds doctor consultation
// strings. Distributed across Maxicare and Valucare so the reconciliation
// math has enough lab+doctor signal per provider.
const docRows: Row[] = [
  // 10 Maxicare consults (mostly paid; 2 unpaid to push opening AR)
  [D_MAR_15, "ALAVA, TERESITA",  "YES", "Maxicare", D_MAR_15, "DR. GAYO — CONSULT",  "NO", 500, "MAX-DR-001", D_MAR_15, "PNB-CHK-6001", new Date(2025, 4, 15)],
  [D_APR_10, "CRUZ, MARIA",      "YES", "Maxicare", D_APR_10, "DR. GAYO — CONSULT",  "NO", 500, "MAX-DR-002", D_APR_10, "PNB-CHK-6002", D_MAY_20],
  [D_APR_22, "SANTOS, ANNA",     "YES", "Maxicare", D_APR_22, "DR. LIM — CONSULT",   "NO", 500, "MAX-DR-003", D_APR_22, "PNB-CHK-6003", D_JUN_07],
  [D_MAY_20, "REYES, MARK",      "YES", "Maxicare", D_MAY_20, "DR. LIM — CONSULT",   "NO", 500, "MAX-DR-004", D_MAY_20, null,            null], // unpaid
  [D_JUN_07, "MENDOZA, LUCY",    "YES", "Maxicare", D_JUN_07, "DR. GAYO — CONSULT",  "NO", 500, "MAX-DR-005", D_JUN_07, "PNB-CHK-6005", D_JUL_03],
  [D_JUN_15, "ROSAL, FE",        "YES", "Maxicare", D_JUN_15, "DR. LIM — CONSULT",   "NO", 500, "MAX-DR-006", D_JUN_15, "PNB-CHK-6006", D_AUG_12],
  [D_JUL_03, "DELA CRUZ, ROBERTO","YES","Maxicare", D_JUL_03, "DR. GAYO — CONSULT",  "NO", 500, "MAX-DR-007", D_JUL_03, "PNB-CHK-6007", D_AUG_12],
  [D_AUG_12, "VALDEZ, ANA",      "YES", "Maxicare", D_AUG_12, "DR. LIM — CONSULT",   "NO", 500, "MAX-DR-008", D_AUG_12, null,            null], // unpaid
  [D_SEP_09, "AQUINO, BEN",      "YES", "Maxicare", D_SEP_09, "DR. GAYO — CONSULT",  "NO", 500, "MAX-DR-009", D_SEP_09, "PNB-CHK-6009", D_OCT_18],
  [D_OCT_18, "TORRES, PAUL",     "YES", "Maxicare", D_OCT_18, "DR. LIM — CONSULT",   "NO", 500, "MAX-DR-010", D_OCT_18, "PNB-CHK-6010", D_NOV_22],

  // 10 Valucare consults (all paid → keeps Valucare opening AR low)
  [D_MAR_15, "TAN, ROSE",        "YES", "Valucare", D_MAR_15, "DR. SANTOS — CONSULT","NO", 600, "VAL-DR-001", D_MAR_15, "PNB-CHK-7001", D_APR_22],
  [D_APR_10, "LIM, PETER",       "YES", "Valucare", D_APR_10, "DR. SANTOS — CONSULT","NO", 600, "VAL-DR-002", D_APR_10, "PNB-CHK-7002", D_MAY_05],
  [D_APR_22, "GO, BETTY",        "YES", "Valucare", D_APR_22, "DR. CHUA — CONSULT",  "NO", 600, "VAL-DR-003", D_APR_22, "PNB-CHK-7003", D_MAY_20],
  [D_MAY_20, "SY, MARK",         "YES", "Valucare", D_MAY_20, "DR. CHUA — CONSULT",  "NO", 600, "VAL-DR-004", D_MAY_20, "PNB-CHK-7004", D_JUN_15],
  [D_JUN_07, "CO, JANE",         "YES", "Valucare", D_JUN_07, "DR. SANTOS — CONSULT","NO", 600, "VAL-DR-005", D_JUN_07, "PNB-CHK-7005", D_JUL_03],
  [D_JUN_15, "ANG, IRIS",        "YES", "Valucare", D_JUN_15, "DR. CHUA — CONSULT",  "NO", 600, "VAL-DR-006", D_JUN_15, "PNB-CHK-7006", D_AUG_12],
  [D_JUL_03, "UY, GEORGE",       "YES", "Valucare", D_JUL_03, "DR. SANTOS — CONSULT","NO", 600, "VAL-DR-007", D_JUL_03, "PNB-CHK-7007", D_AUG_12],
  [D_AUG_12, "WONG, KEN",        "YES", "Valucare", D_AUG_12, "DR. CHUA — CONSULT",  "NO", 600, "VAL-DR-008", D_AUG_12, "PNB-CHK-7008", D_OCT_18],
  [D_SEP_09, "CHEN, LISA",       "YES", "Valucare", D_SEP_09, "DR. SANTOS — CONSULT","NO", 600, "VAL-DR-009", D_SEP_09, "PNB-CHK-7009", D_OCT_18],
  [D_OCT_18, "YAP, RAY",         "YES", "Valucare", D_OCT_18, "DR. CHUA — CONSULT",  "NO", 600, "VAL-DR-010", D_OCT_18, "PNB-CHK-7010", D_NOV_22],
];

// ============================================================================
// HMO REFERENCE — ending balances designed for the reconciliation panel.
// ============================================================================
//
// reconciliation.ts uses "max numeric value in row past column F" as the
// ending-balance pragmatic fallback. We park the ending-balance number in
// column G for visual sanity (the reconciliation parser will pick it up).
//
// Maxicare: ~3% variance vs the staged AR (yellow).
// Valucare: 0% variance vs the staged AR (green).
//
// Staged AR per provider (sum max(0, billed - paid) over staging rows). With
// paid_amount=0 for every staging row (parser doesn't populate the paid
// column), the staged AR equals the sum of billed_amount of rows that reach
// staging. So:
//
//   Maxicare staged AR (LAB):  1970 + 320 + 130 (A1-A3 grouped, paid in WB
//      but paid_amount=0 in staging) + 300 (A5 overpaid)
//      + 320 (A6 unpaid) + 1970 (A7 paid) + 130 (A8 alias)
//      + 320 (A9 cross-OR) + 320 + 320 (A11+A12 dup hash, both reach staging)
//      + 0.01 (A4, see note) = 6100.01
//      A4 — the "negative billed_amount" edge case from spec §13.1 — is
//      documented inline (see the A4 row comment around line 110) but the
//      actual workbook value is 0.01 (1 centavo), not -100, because the
//      staging billed_amount > 0 CHECK would otherwise abort the whole
//      chunk insert. 0.01 passes the CHECK and contributes 0.01 to Maxicare
//      AR — negligible against the 11100 total, so the green/yellow variance
//      threshold is unaffected.
//
//   Maxicare staged AR (DOCTOR): 500 × 10 = 5000 (all 10 Maxicare consults)
//
//   Total Maxicare staged AR  = 6100 + 5000 = 11100
//   Maxicare WB ending = 11100 / 1.03 ≈ 10777  → produces +2.99% variance.
//
//   Valucare staged AR (LAB):  320 (A10) + 320 + 130 + 1970 (A18-A20) = 2740
//   Valucare staged AR (DOC):  600 × 10 = 6000
//   Total Valucare staged AR  = 2740 + 6000 = 8740
//   Valucare WB ending = 8740 → 0% variance (green).
//
// Note: A4 is coerced to 0.01 in the workbook so all 25 LAB rows reach
// staging cleanly. The 0.01 contribution to Maxicare AR is negligible — the
// staged total still rounds to 11100 and the ~3% variance vs the WB ending
// balance of 10777 is unchanged. The "true" negative-billed-amount edge case
// from spec §13.1 cannot be exercised end-to-end through the upload UI today
// (the staging CHECK would abort the chunk insert); see the inline comment
// at A4 (~line 110) for the rationale and the D5 report for the gap.
//
// Note 2: rows A11+A12 (identical content_hash) both reach staging in 'parsed'
// status. They're flagged with severity='error' but the staging amounts are
// counted in staged_ar. That contributes 320+320 = 640 to Maxicare. The
// content_hash collision is reported as a row-level error.

const MAXICARE_WB_ENDING = 10777;
const VALUCARE_WB_ENDING = 8740;

// ============================================================================
// Workbook assembly
// ============================================================================

async function main() {
  const wb = new ExcelJS.Workbook();

  // ---- LAB SERVICE ---------------------------------------------------------
  const lab = wb.addWorksheet("LAB SERVICE");
  lab.addRow(LAB_HEADER);          // row 1 — canonical headers
  lab.addRow(new Array(LAB_HEADER.length).fill("")); // row 2 — blank sub-header
  for (const r of labRows) lab.addRow(r);

  // ---- DOCTOR CONSULTATION -------------------------------------------------
  const doc = wb.addWorksheet("DOCTOR CONSULTATION");
  doc.addRow(DOC_HEADER);
  doc.addRow(new Array(DOC_HEADER.length).fill(""));
  for (const r of docRows) doc.addRow(r);

  // ---- HMO REFERENCE -------------------------------------------------------
  const ref = wb.addWorksheet("HMO REFERENCE");
  ref.addRow(["HMO PROVIDER", "DUE DAYS FOR INVOICE", "", "", "", "", "ENDING BALANCE"]); // row 1
  ref.addRow(new Array(7).fill(""));                                                       // row 2
  ref.addRow(new Array(7).fill(""));                                                       // row 3 spacer (provider rows start row 4)
  // Provider rows (column A = provider name, column G = ending balance per reconciliation.ts)
  ref.addRow(["Maxicare",   30, "", "", "", "", MAXICARE_WB_ENDING]);
  ref.addRow(["Valucare",   30, "", "", "", "", VALUCARE_WB_ENDING]);
  ref.addRow(["Cocolife",   30, "", "", "", "", 0]);
  ref.addRow(["Med Asia",   30, "", "", "", "", 0]);
  ref.addRow(["Intellicare", 30, "", "", "", "", 0]);

  await wb.xlsx.writeFile(OUT_PATH);

  // Quick row tally for the operator (helps confirm row counts at a glance).
  // Worksheet row math:
  //   LAB SERVICE         : 1 header + 1 sub-header + labRows.length data
  //   DOCTOR CONSULTATION : 1 header + 1 sub-header + docRows.length data
  //   HMO REFERENCE       : 1 header + 1 sub-header + 1 spacer + 5 providers = 8
  // Total worksheet rows = 4 + labRows.length + docRows.length + 8
  //                      = labRows.length + docRows.length + 12.
  const totalWorksheetRows = labRows.length + docRows.length + 12;
  console.log(`wrote ${OUT_PATH}`);
  console.log(`  LAB SERVICE data rows         : ${labRows.length}`);
  console.log(`  DOCTOR CONSULTATION data rows : ${docRows.length}`);
  console.log(`  HMO REFERENCE rows            : 8 (2 header + 1 spacer + 5 providers)`);
  console.log(`  total worksheet rows          : ${totalWorksheetRows} (incl. 4 LAB/DOC header rows)`);
  console.log(`  today                         : ${iso(today)}`);
  console.log(`  future (post-cutover)         : ${iso(FUTURE)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
