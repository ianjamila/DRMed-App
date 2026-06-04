import ExcelJS from "exceljs";
import { cellText } from "../../clinical-backfill/lib/xlsx";

function isYes(v: ExcelJS.CellValue): boolean {
  return cellText(v).trim().toUpperCase() === "YES";
}

/** One source-sheet row's recoverable enrichment fields, keyed by legacy_source_ref. */
export interface EnrichmentRow {
  doctorSurname: string;          // consult only; "" for lab
  discSenior: boolean;            // consult/lab col 10 == YES
  discOther: boolean;             // consult col 11 == YES (lab: false)
  disc10: boolean;                // lab col 11 == YES (consult: false)
  disc5: boolean;                 // lab col 12 == YES (consult: false)
  newRepeat: string;              // lab col 17; "" for consult
}

/**
 * Read both tabs and return a map: legacy_source_ref -> EnrichmentRow.
 * Keys mirror what the backfill wrote: "DOCTOR CONSULTATION r<n>" / "LAB SERVICE r<n>".
 */
export async function readEnrichment(xlsxPath: string): Promise<Map<string, EnrichmentRow>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const out = new Map<string, EnrichmentRow>();

  const consult = wb.getWorksheet("DOCTOR CONSULTATION");
  if (!consult) throw new Error("DOCTOR CONSULTATION sheet not found");
  consult.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= 2) return;
    if (row.getCell(1).value == null) return;
    out.set(`DOCTOR CONSULTATION r${rn}`, {
      doctorSurname: cellText(row.getCell(8).value).trim(),
      discSenior: isYes(row.getCell(10).value),
      discOther: isYes(row.getCell(11).value),
      disc10: false,
      disc5: false,
      newRepeat: "",
    });
  });

  const lab = wb.getWorksheet("LAB SERVICE");
  if (!lab) throw new Error("LAB SERVICE sheet not found");
  lab.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= 2) return;
    if (row.getCell(1).value == null) return;
    out.set(`LAB SERVICE r${rn}`, {
      doctorSurname: "",
      discSenior: isYes(row.getCell(10).value),
      discOther: false,
      disc10: isYes(row.getCell(11).value),
      disc5: isYes(row.getCell(12).value),
      newRepeat: cellText(row.getCell(17).value).trim(),
    });
  });

  return out;
}
