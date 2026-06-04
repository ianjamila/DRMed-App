import ExcelJS from "exceljs";
import type { RawRow, TabConfig } from "./types";

function excelSerialToISO(serial: number): string {
  const base = Date.UTC(1899, 11, 30);
  return new Date(base + serial * 86400 * 1000).toISOString().slice(0, 10);
}
export function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  if (v instanceof Date) { const t = v.getTime(); return Number.isNaN(t) ? "" : v.toISOString().slice(0, 10); }
  if (typeof v === "object" && "richText" in v && Array.isArray(v.richText)) {
    return v.richText.map((r) => r.text ?? "").join("");
  }
  if (typeof v === "object" && "text" in v) return String((v as { text: unknown }).text);
  if (typeof v === "object" && "result" in v) return cellText((v as { result: ExcelJS.CellValue }).result);
  return String(v);
}
export function parseDate(raw: ExcelJS.CellValue): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") return excelSerialToISO(raw);
  if (raw instanceof Date) { const t = raw.getTime(); return Number.isNaN(t) ? null : raw.toISOString().slice(0, 10); }
  const s = cellText(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d+(\.\d+)?$/.test(s)) return excelSerialToISO(Number(s));
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  return null;
}
export function fnum(raw: ExcelJS.CellValue): number {
  if (raw == null) return 0;
  if (typeof raw === "number") return raw;
  const s = cellText(raw).trim();
  if (!s || s.toUpperCase() === "N/A" || s.toUpperCase() === "NA") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export async function loadTab(xlsxPath: string, cfg: TabConfig): Promise<RawRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const ws = wb.getWorksheet(cfg.sheetName);
  if (!ws) throw new Error(`${cfg.sheetName} sheet not found in ${xlsxPath}`);
  const c = cfg.cols;
  const out: RawRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn <= 2) return;                       // row 1/2 are headers
    const a = row.getCell(c.posting_date).value;
    if (a == null || a === "") return;
    out.push({
      row_number: rn,
      posting_date: parseDate(a),
      control_no: cellText(row.getCell(c.control_no).value).trim(),
      test_no: cellText(row.getCell(c.test_no).value).trim(),
      patient_name: cellText(row.getCell(c.patient_name).value).trim(),
      hmo_flag: cellText(row.getCell(c.hmo_flag).value).trim(),
      hmo_provider: cellText(row.getCell(c.hmo_provider).value).trim(),
      service: cellText(row.getCell(c.service).value).trim(),
      base: fnum(row.getCell(c.base).value),
      final: fnum(row.getCell(c.final).value),
      clinic_fee: c.clinic_fee ? fnum(row.getCell(c.clinic_fee).value) : 0,
      doctor_pf: c.doctor_pf ? fnum(row.getCell(c.doctor_pf).value) : 0,
      mop: cellText(row.getCell(c.mop).value).trim(),
      or_number: cellText(row.getCell(c.or_number).value).trim(),
      date_paid: parseDate(row.getCell(c.date_paid).value),
    });
  });
  return out;
}
