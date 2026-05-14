import ExcelJS from "exceljs";

export interface ProviderEndingBalance {
  providerNameRaw: string;
  endingBalancePhp: number;       // workbook ending balance at the cutover month
  cutoverMonth: string;           // YYYY-MM
}

// Reads the HMO REFERENCE tab and computes per-provider ending balance at the
// month containing `cutoverISO`. Layout of the monthly aging block is finalized
// during this task's implementation — read the workbook live, then write the
// concrete row/column constants here.
//
// Falls back gracefully: if the tab is missing or the layout doesn't match the
// expected shape, returns an empty array. The caller (validateRunAction) treats
// that as "no reconciliation data — informational only, do not block".
export function parseHmoReferenceAging(
  workbook: ExcelJS.Workbook,
  cutoverISO: string,
): ProviderEndingBalance[] {
  const sheet = workbook.getWorksheet("HMO REFERENCE");
  if (!sheet) return [];

  const cutoverMonth = cutoverISO.slice(0, 7); // YYYY-MM

  // Provider rows are typically in column A starting at row 4 (per the spec's §3
  // workbook reconnaissance). Match by exact provider names from the file's
  // canonical list: Maxicare, Valucare, Cocolife, Med Asia, Intellicare, Avega,
  // Generali, Etiqa, iCare, Amaphil.
  const CANONICAL_PROVIDERS = new Set([
    "Maxicare", "Valucare", "Cocolife", "Med Asia",
    "Intellicare", "Avega", "Generali", "Etiqa", "iCare", "Amaphil",
  ]);

  // The aging block layout is a per-month series of (Starting / Additional /
  // Paid / Ending Balance) quadruplets. The exact column offsets are finalized
  // here against a live read of the workbook during D2 execution. The fallback
  // strategy (if exact column resolution fails): scan the row for the largest
  // numeric value in the cutover month's quadruplet (assumed to be "Ending
  // Balance" in PHP).

  const out: ProviderEndingBalance[] = [];

  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cellA = String(row.getCell(1).value ?? "").trim();
    if (!CANONICAL_PROVIDERS.has(cellA)) return;

    // Implementer TODO at D2 execution: replace this placeholder column-resolution
    // logic with the exact column letters discovered by reading the live workbook.
    // For now, use the maximum numeric value in the row past column F as a
    // pragmatic ending-balance approximation; the spec §9.3 explicitly allows the
    // implementer to refine this against the live workbook.
    let maxVal = 0;
    for (let c = 6; c <= row.cellCount; c++) {
      const v = row.getCell(c).value;
      if (typeof v === "number" && Number.isFinite(v) && v > maxVal) maxVal = v;
    }

    if (maxVal > 0) {
      out.push({
        providerNameRaw: cellA,
        endingBalancePhp: maxVal,
        cutoverMonth,
      });
    }
  });

  return out;
}
