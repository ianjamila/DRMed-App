import ExcelJS from "exceljs";
import { cellText, fnum } from "../../clinical-backfill/lib/xlsx";

/** One source-sheet row's recoverable enrichment fields, keyed by legacy_source_ref. */
export interface EnrichmentRow {
  doctorSurname: string;          // consult only; "" for lab
  discountSenior: number;
  discountOther: number;          // consult col 11
  discount10: number;             // lab col 11
  discount5: number;              // lab col 12
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
      discountSenior: fnum(row.getCell(10).value),
      discountOther: fnum(row.getCell(11).value),
      discount10: 0,
      discount5: 0,
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
      discountSenior: fnum(row.getCell(10).value),
      discountOther: 0,
      discount10: fnum(row.getCell(11).value),
      discount5: fnum(row.getCell(12).value),
      newRepeat: cellText(row.getCell(17).value).trim(),
    });
  });

  return out;
}
