import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";

import { excelSerialToISODate } from "./excel-date";
import { parseDecimal, splitLastFirstName, normalizeName } from "./normalize";

// Expected column-header-text → canonical-field-name mapping.
// The parser asserts these texts appear in their expected positions at row 1 and
// row 2 (some tabs have a 2-row header). On mismatch, fail loudly.
//
// NOTE: LAB SERVICE and DOCTOR CONSULTATION tabs currently share an identical
// header layout, so we use a single shared constant. If/when the two tabs ever
// drift, fork this back into two per-tab constants and update the call sites
// in `parseXlsxBuffer`.
const SHARED_HEADERS = {
  DATE: "source_date",
  "PATIENT NAME": "patient_name_raw",
  HMO: "hmo_flag",
  PROVIDER: "provider_name_raw",
  "APPROVAL DATE": "hmo_approval_date",
  SERVICE: "service_name_raw",
  "SENIOR/PWD": "senior_pwd_flag",
  "FINAL PRICE (LESS DISCOUNTS)": "billed_amount",
  "REFERENCE / TRACKING": "reference_no",
  "DATE SENT": "submission_date",
  "OR #": "or_number",
  "DATE ACTUAL PAYMENT RECEIVED": "payment_received_date",
} as const;

export type SourceTab = "LAB SERVICE" | "DOCTOR CONSULTATION";

export interface ParsedRow {
  source_tab: SourceTab;
  source_row_no: number;
  source_date: string;                 // YYYY-MM-DD
  patient_name_raw: string;
  normalized_patient_name: string;
  last_name_raw: string;
  first_name_raw: string;
  hmo_flag: "YES" | "NO" | "";
  provider_name_raw: string;
  service_name_raw: string;
  senior_pwd_flag: boolean;
  hmo_approval_date: string | null;
  billed_amount: number;
  reference_no: string | null;
  submission_date: string | null;
  or_number: string | null;
  payment_received_date: string | null;
}

export interface ParseSummary {
  rowsByTab: Record<SourceTab, ParsedRow[]>;
  skipPostCutoverCount: Record<SourceTab, number>;
  parseErrors: { tab: string; row: number; message: string }[];
}

export interface ParseOptions {
  cutoverISO: string;     // YYYY-MM-DD; rows with source_date > cutover are skipped
}

// ============================================================================
// Top-level entry point: parse an XLSX or per-tab CSVs.
// ============================================================================

export async function parseXlsxBuffer(
  buf: Buffer,
  opts: ParseOptions,
): Promise<{ summary: ParseSummary; workbook: ExcelJS.Workbook }> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's load() type predates Node's Buffer<ArrayBufferLike> generic;
  // the runtime accepts any Buffer-shaped value, so cast through unknown.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buf as any);

  const summary: ParseSummary = {
    rowsByTab: { "LAB SERVICE": [], "DOCTOR CONSULTATION": [] },
    skipPostCutoverCount: { "LAB SERVICE": 0, "DOCTOR CONSULTATION": 0 },
    parseErrors: [],
  };

  for (const tabName of ["LAB SERVICE", "DOCTOR CONSULTATION"] as const) {
    const sheet = workbook.getWorksheet(tabName);
    if (!sheet) {
      summary.parseErrors.push({
        tab: tabName, row: 0,
        message: `tab "${tabName}" not found in workbook`,
      });
      continue;
    }

    const colMap = assertHeaders(sheet, SHARED_HEADERS, tabName, summary);
    if (!colMap) continue;  // header mismatch already recorded

    // Data starts at row 3 (row 1 = headers, row 2 = sub-headers).
    sheet.eachRow({ includeEmpty: false }, (row, rowNo) => {
      if (rowNo < 3) return;
      try {
        const parsed = parseRow(tabName, row, colMap, rowNo);
        if (!parsed) return;
        if (parsed.hmo_flag !== "YES") return;
        if (parsed.source_date > opts.cutoverISO) {
          summary.skipPostCutoverCount[tabName]++;
          return;
        }
        summary.rowsByTab[tabName].push(parsed);
      } catch (e) {
        summary.parseErrors.push({
          tab: tabName, row: rowNo,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }

  return { summary, workbook };
}

// ============================================================================
// Header assertion — fail fast if the workbook layout drifts.
// ============================================================================

function assertHeaders(
  sheet: ExcelJS.Worksheet,
  expected: Record<string, string>,
  tabName: SourceTab,
  summary: ParseSummary,
): Map<string, number> | null {
  // Read row 1 + row 2; concatenate for compound headers.
  const colMap = new Map<string, number>();
  const r1 = sheet.getRow(1);
  const r2 = sheet.getRow(2);

  for (let c = 1; c <= sheet.columnCount; c++) {
    const top = String(r1.getCell(c).value ?? "").trim();
    const sub = String(r2.getCell(c).value ?? "").trim();
    const compound = sub ? `${top} ${sub}`.trim() : top;
    for (const key of Object.keys(expected)) {
      if (compound === key || top === key) colMap.set(key, c);
    }
  }

  const missing = Object.keys(expected).filter((k) => !colMap.has(k));
  if (missing.length > 0) {
    summary.parseErrors.push({
      tab: tabName, row: 1,
      message: `header_mismatch: missing expected columns: ${missing.join(", ")}`,
    });
    return null;
  }
  return colMap;
}

// ============================================================================
// Per-row parsing.
// ============================================================================

function parseRow(
  tabName: SourceTab,
  row: ExcelJS.Row,
  colMap: Map<string, number>,
  rowNo: number,
): ParsedRow | null {
  const get = (key: string): ExcelJS.CellValue => row.getCell(colMap.get(key)!).value;

  const dateRaw = get("DATE");
  if (dateRaw == null) return null;
  let source_date: string;
  if (typeof dateRaw === "number") {
    source_date = excelSerialToISODate(dateRaw);
  } else if (dateRaw instanceof Date) {
    source_date = dateRaw.toISOString().slice(0, 10);
  } else {
    source_date = excelSerialToISODate(Number(dateRaw));
  }

  const patient_name_raw = String(get("PATIENT NAME") ?? "").trim();
  if (!patient_name_raw) return null;
  const { last, first } = splitLastFirstName(patient_name_raw);

  const hmo_flag = (String(get("HMO") ?? "").trim().toUpperCase() as ParsedRow["hmo_flag"]) || "";
  const provider_name_raw = String(get("PROVIDER") ?? "").trim();
  const service_name_raw = String(get("SERVICE") ?? "").trim();
  const senior_pwd_flag = String(get("SENIOR/PWD") ?? "").trim().toUpperCase() === "YES";

  const approvalRaw = get("APPROVAL DATE");
  const hmo_approval_date =
    approvalRaw == null ? null :
    typeof approvalRaw === "number" ? excelSerialToISODate(approvalRaw) :
    approvalRaw instanceof Date ? approvalRaw.toISOString().slice(0, 10) :
    null;

  const billed_amount = parseDecimal(get("FINAL PRICE (LESS DISCOUNTS)") as number | string);

  const reference_no = (() => {
    const v = String(get("REFERENCE / TRACKING") ?? "").trim();
    return v || null;
  })();

  const submission_date = (() => {
    const v = get("DATE SENT");
    if (v == null || v === "") return null;
    if (typeof v === "number") return excelSerialToISODate(v);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return null;
  })();

  const or_number = (() => {
    const v = String(get("OR #") ?? "").trim();
    return v || null;
  })();

  const payment_received_date = (() => {
    const v = get("DATE ACTUAL PAYMENT RECEIVED");
    if (v == null || v === "") return null;
    if (typeof v === "number") return excelSerialToISODate(v);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return null;
  })();

  return {
    source_tab: tabName,
    source_row_no: rowNo,
    source_date,
    patient_name_raw,
    normalized_patient_name: normalizeName(patient_name_raw),
    last_name_raw: last,
    first_name_raw: first,
    hmo_flag,
    provider_name_raw,
    service_name_raw,
    senior_pwd_flag,
    hmo_approval_date,
    billed_amount,
    reference_no,
    submission_date,
    or_number,
    payment_received_date,
  };
}

// ============================================================================
// CSV fallback (per-tab) — same row shape, less reliable than XLSX header check.
// ============================================================================

export function parseCsvBuffer(
  tab: SourceTab,
  buf: Buffer,
  opts: ParseOptions,
): ParseSummary {
  const records = parseCsv(buf, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  const summary: ParseSummary = {
    rowsByTab: { "LAB SERVICE": [], "DOCTOR CONSULTATION": [] },
    skipPostCutoverCount: { "LAB SERVICE": 0, "DOCTOR CONSULTATION": 0 },
    parseErrors: [],
  };

  records.forEach((rec, i) => {
    try {
      const dateRaw = rec.DATE;
      const source_date = /^\d+$/.test(dateRaw)
        ? excelSerialToISODate(Number(dateRaw))
        : (new Date(dateRaw)).toISOString().slice(0, 10);
      const patient_name_raw = (rec["PATIENT NAME"] ?? "").trim();
      if (!patient_name_raw) return;
      const { last, first } = splitLastFirstName(patient_name_raw);
      const hmo_flag = ((rec.HMO ?? "").trim().toUpperCase() as ParsedRow["hmo_flag"]) || "";
      if (hmo_flag !== "YES") return;
      if (source_date > opts.cutoverISO) {
        summary.skipPostCutoverCount[tab]++;
        return;
      }
      summary.rowsByTab[tab].push({
        source_tab: tab,
        source_row_no: i + 2,
        source_date,
        patient_name_raw,
        normalized_patient_name: normalizeName(patient_name_raw),
        last_name_raw: last,
        first_name_raw: first,
        hmo_flag,
        provider_name_raw: (rec.PROVIDER ?? "").trim(),
        service_name_raw: (rec.SERVICE ?? "").trim(),
        senior_pwd_flag: (rec["SENIOR/PWD"] ?? "").trim().toUpperCase() === "YES",
        hmo_approval_date: rec["APPROVAL DATE"]
          ? excelSerialToISODate(Number(rec["APPROVAL DATE"]))
          : null,
        billed_amount: parseDecimal(rec["FINAL PRICE (LESS DISCOUNTS)"] ?? rec["FINAL PRICE"]),
        reference_no: (rec["REFERENCE / TRACKING"] ?? "").trim() || null,
        submission_date: rec["DATE SENT"]
          ? excelSerialToISODate(Number(rec["DATE SENT"]))
          : null,
        or_number: (rec["OR #"] ?? "").trim() || null,
        payment_received_date: rec["DATE ACTUAL PAYMENT RECEIVED"]
          ? excelSerialToISODate(Number(rec["DATE ACTUAL PAYMENT RECEIVED"]))
          : null,
      });
    } catch (e) {
      summary.parseErrors.push({
        tab, row: i + 2,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return summary;
}
