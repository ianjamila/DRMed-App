// DTR (Daily Time Record) CSV parser for ZKTeco "Daily Attendance" exports.
//
// Pure-TS, no DB access. The ingest Server Action in
// src/app/(staff)/staff/(dashboard)/admin/payroll/runs/[id]/dtr/actions.ts
// is responsible for persisting the parsed rows and resolving the
// external_id_raw -> employees.id mapping.
//
// ZKTeco exports vary in column order and capitalization; this parser
// auto-detects the header row, applies a case-insensitive alias map for the
// canonical fields, and produces normalized ISO 8601 timestamps with the
// Asia/Manila (+08:00) offset.
//
// Spec: docs/superpowers/specs/2026-05-18-12.6-payroll-design.md §5 Q5.

import Papa from "papaparse";

// ---------- Public types ------------------------------------------------------

export type ParsedDtrRow = {
  external_id_raw: string;
  work_date: string; // YYYY-MM-DD
  time_in_iso: string | null; // ISO 8601 with +08:00 offset (Asia/Manila), or null
  time_out_iso: string | null;
  total_hours: number | null;
  source_row: Record<string, string>; // original CSV row, all string fields
  parse_warnings: string[];
};

export type DtrParseError = {
  row_index: number; // index into the raw CSV (0 = first non-empty row)
  reason: string;
  raw: string;
};

export type DtrParseResult = {
  rows: ParsedDtrRow[];
  errors: DtrParseError[];
};

// ---------- Header detection --------------------------------------------------

// Tokens we look for in the header row (lowercased, trimmed). Auto-detection
// requires at least 3 matches in the same row within the first 5 non-empty rows.
const HEADER_TOKENS = new Set<string>([
  "employee_id",
  "employeeid",
  "emp_id",
  "id",
  "user id",
  "userid",
  "user_id",
  "name",
  "date",
  "work_date",
  "work date",
  "time_in",
  "timein",
  "in_time",
  "time in",
  "in time",
  "time_out",
  "timeout",
  "out_time",
  "time out",
  "out time",
  "total_hours",
  "hours",
  "total",
  "total hours",
]);

// Canonical field aliases (lowercased + trimmed cell -> canonical key).
const COLUMN_ALIASES: Record<string, CanonicalColumn> = {
  // external_id_raw
  employee_id: "external_id_raw",
  employeeid: "external_id_raw",
  emp_id: "external_id_raw",
  id: "external_id_raw",
  "user id": "external_id_raw",
  userid: "external_id_raw",
  user_id: "external_id_raw",
  // work_date
  date: "work_date",
  work_date: "work_date",
  "work date": "work_date",
  // time_in
  time_in: "time_in",
  timein: "time_in",
  in_time: "time_in",
  "time in": "time_in",
  "in time": "time_in",
  // time_out
  time_out: "time_out",
  timeout: "time_out",
  out_time: "time_out",
  "time out": "time_out",
  "out time": "time_out",
  // total_hours
  total_hours: "total_hours",
  hours: "total_hours",
  total: "total_hours",
  "total hours": "total_hours",
};

type CanonicalColumn =
  | "external_id_raw"
  | "work_date"
  | "time_in"
  | "time_out"
  | "total_hours";

type HeaderMap = Partial<Record<CanonicalColumn, number>>;
type DetectedHeader = {
  rowIndex: number; // index into the raw rows array
  columnNames: string[]; // original header cells (preserved for source_row)
  map: HeaderMap;
};

function normalizeCell(s: string): string {
  return s.trim().toLowerCase();
}

function detectHeader(rows: string[][]): DetectedHeader | null {
  const scanLimit = Math.min(rows.length, 5);
  for (let i = 0; i < scanLimit; i++) {
    const row = rows[i];
    if (!row) continue;
    const normalized = row.map(normalizeCell);
    const matches = normalized.filter((c) => HEADER_TOKENS.has(c)).length;
    if (matches >= 3) {
      const map: HeaderMap = {};
      for (let j = 0; j < normalized.length; j++) {
        const canon = COLUMN_ALIASES[normalized[j]!];
        if (canon && map[canon] === undefined) {
          map[canon] = j;
        }
      }
      return { rowIndex: i, columnNames: row, map };
    }
  }
  return null;
}

// ---------- Cell parsers (exported for unit tests) ----------------------------

/**
 * Parse a date cell into `YYYY-MM-DD`. Accepts:
 *   - `YYYY-MM-DD`
 *   - `MM/DD/YYYY` (ZKTeco default, US-style)
 *   - `DD/MM/YYYY` (rare; only chosen if MM/DD parse yields an invalid month)
 *
 * Returns `null` on failure.
 */
export function parseDateCell(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // ISO YYYY-MM-DD
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    if (isValidYMD(+y!, +m!, +d!)) return `${y}-${m}-${d}`;
    return null;
  }

  // Slash form
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (slash) {
    const [, a, b, yRaw] = slash;
    const y = yRaw!.length === 2 ? 2000 + +yRaw! : +yRaw!;
    // Default MM/DD/YYYY since ZKTeco is US-style. If month would be > 12,
    // fall back to DD/MM/YYYY.
    const mmFirst = +a! <= 12 && +b! <= 31;
    if (mmFirst && isValidYMD(y, +a!, +b!)) {
      return `${pad4(y)}-${pad2(+a!)}-${pad2(+b!)}`;
    }
    if (isValidYMD(y, +b!, +a!)) {
      return `${pad4(y)}-${pad2(+b!)}-${pad2(+a!)}`;
    }
    return null;
  }

  return null;
}

function isValidYMD(y: number, m: number, d: number): boolean {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  // Construct a Date in UTC to avoid local-TZ shifts and round-trip check.
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
function pad4(n: number): string {
  return n.toString().padStart(4, "0");
}

/**
 * Parse a time-of-day cell into `HH:MM:SS` (24h, zero-padded). Accepts:
 *   - `HH:MM` or `HH:MM:SS` (24h)
 *   - `H:MM AM/PM` or `H:MM:SS AM/PM` (12h, case-insensitive, optional space)
 *
 * Returns `null` on failure or empty input.
 */
export function parseTimeCell(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // 12-hour with AM/PM suffix
  const ampm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?$/.exec(s);
  if (ampm) {
    const [, hStr, mStr, sStr, mer] = ampm;
    let h = +hStr!;
    const m = +mStr!;
    const sec = sStr ? +sStr : 0;
    const isPM = mer!.toLowerCase() === "p";
    if (h < 1 || h > 12 || m < 0 || m > 59 || sec < 0 || sec > 59) return null;
    if (h === 12) h = 0;
    if (isPM) h += 12;
    return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
  }

  // 24-hour
  const h24 = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (h24) {
    const [, hStr, mStr, sStr] = h24;
    const h = +hStr!;
    const m = +mStr!;
    const sec = sStr ? +sStr : 0;
    if (h < 0 || h > 23 || m < 0 || m > 59 || sec < 0 || sec > 59) return null;
    return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
  }

  return null;
}

/**
 * Combine a `YYYY-MM-DD` and `HH:MM:SS` into an ISO 8601 string with the
 * Asia/Manila offset (+08:00). No actual timezone conversion happens — the
 * input clock time is treated as wall-clock time in Manila.
 */
export function combineDateTime(workDate: string, time24: string): string {
  return `${workDate}T${time24}+08:00`;
}

/**
 * Parse total_hours numeric cell. Accepts blank (returns null).
 * Returns null on parse failure (callers decide whether to warn).
 */
function parseTotalHours(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
}

// ---------- Main entrypoint ---------------------------------------------------

export function parseDtrCsv(rawCsv: string): DtrParseResult {
  // Edge: empty input -> no rows, single header-detection error.
  if (!rawCsv || rawCsv.trim().length === 0) {
    return {
      rows: [],
      errors: [
        {
          row_index: -1,
          reason: "empty input",
          raw: "",
        },
      ],
    };
  }

  const result = Papa.parse<string[]>(rawCsv, {
    header: false,
    skipEmptyLines: true,
  });

  const rawRows: string[][] = (result.data ?? []).filter(
    (r): r is string[] => Array.isArray(r) && r.some((c) => (c ?? "").trim().length > 0),
  );

  const errors: DtrParseError[] = [];
  if (rawRows.length === 0) {
    errors.push({ row_index: -1, reason: "no non-empty rows", raw: "" });
    return { rows: [], errors };
  }

  const header = detectHeader(rawRows);
  if (!header) {
    // Per spec: if no header found in the first 5 non-empty rows, return all
    // rows as errors.
    for (let i = 0; i < rawRows.length; i++) {
      errors.push({
        row_index: i,
        reason: "no header row detected in first 5 rows",
        raw: rawRows[i]!.join(","),
      });
    }
    return { rows: [], errors };
  }

  // Required canonical columns
  const required: CanonicalColumn[] = [
    "external_id_raw",
    "work_date",
    "time_in",
    "time_out",
  ];
  const missing = required.filter((c) => header.map[c] === undefined);
  if (missing.length > 0) {
    errors.push({
      row_index: header.rowIndex,
      reason: `header missing required columns: ${missing.join(", ")}`,
      raw: rawRows[header.rowIndex]!.join(","),
    });
    return { rows: [], errors };
  }

  const headerNames = header.columnNames;
  const dataRows = rawRows.slice(header.rowIndex + 1);
  const parsed: ParsedDtrRow[] = [];

  // Track (external_id, work_date) for in-CSV duplicate detection. Maps key
  // -> array of indexes into `parsed` so we can later expel both the original
  // and any subsequent dupes to `errors`.
  const dedupe = new Map<string, number[]>();

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]!;
    const rawString = row.join(",");
    const rowIndex = header.rowIndex + 1 + i; // index into original rawRows

    // Build source_row dict from header names. Pad missing cells with "".
    const sourceRow: Record<string, string> = {};
    for (let j = 0; j < headerNames.length; j++) {
      sourceRow[headerNames[j]!] = (row[j] ?? "").toString();
    }

    const extIdCol = header.map.external_id_raw!;
    const workDateCol = header.map.work_date!;
    const timeInCol = header.map.time_in!;
    const timeOutCol = header.map.time_out!;
    const totalHoursCol = header.map.total_hours;

    const extIdRaw = (row[extIdCol] ?? "").trim();
    const workDateRaw = (row[workDateCol] ?? "").trim();
    const timeInRaw = (row[timeInCol] ?? "").trim();
    const timeOutRaw = (row[timeOutCol] ?? "").trim();
    const totalHoursRaw =
      totalHoursCol !== undefined ? (row[totalHoursCol] ?? "").trim() : "";

    if (!extIdRaw) {
      errors.push({ row_index: rowIndex, reason: "missing employee id", raw: rawString });
      continue;
    }

    const workDate = parseDateCell(workDateRaw);
    if (!workDate) {
      errors.push({
        row_index: rowIndex,
        reason: `invalid date: ${JSON.stringify(workDateRaw)}`,
        raw: rawString,
      });
      continue;
    }

    const warnings: string[] = [];

    // Time-in
    let timeInIso: string | null = null;
    if (!timeInRaw) {
      warnings.push("missing time_in");
    } else {
      const t = parseTimeCell(timeInRaw);
      if (!t) {
        errors.push({
          row_index: rowIndex,
          reason: `invalid time_in: ${JSON.stringify(timeInRaw)}`,
          raw: rawString,
        });
        continue;
      }
      timeInIso = combineDateTime(workDate, t);
    }

    // Time-out
    let timeOutIso: string | null = null;
    if (!timeOutRaw) {
      warnings.push("missing time_out");
    } else {
      const t = parseTimeCell(timeOutRaw);
      if (!t) {
        errors.push({
          row_index: rowIndex,
          reason: `invalid time_out: ${JSON.stringify(timeOutRaw)}`,
          raw: rawString,
        });
        continue;
      }
      timeOutIso = combineDateTime(workDate, t);
    }

    // total_hours
    let totalHours: number | null = null;
    if (totalHoursRaw) {
      const n = parseTotalHours(totalHoursRaw);
      if (n === null) {
        warnings.push(`invalid total_hours: ${JSON.stringify(totalHoursRaw)}`);
      } else {
        totalHours = n;
      }
    }

    // Cross-check total_hours vs (time_out - time_in)
    if (timeInIso && timeOutIso && totalHours !== null) {
      const inMs = Date.parse(timeInIso);
      const outMs = Date.parse(timeOutIso);
      if (Number.isFinite(inMs) && Number.isFinite(outMs)) {
        const computed = (outMs - inMs) / (1000 * 60 * 60);
        if (Math.abs(computed - totalHours) > 0.5) {
          warnings.push(
            `total_hours mismatch (computed: ${computed.toFixed(2)}, recorded: ${totalHours.toFixed(2)})`,
          );
        }
      }
    }

    const idx = parsed.length;
    parsed.push({
      external_id_raw: extIdRaw,
      work_date: workDate,
      time_in_iso: timeInIso,
      time_out_iso: timeOutIso,
      total_hours: totalHours,
      source_row: sourceRow,
      parse_warnings: warnings,
    });

    const key = `${extIdRaw} ${workDate}`;
    const bucket = dedupe.get(key);
    if (bucket) {
      bucket.push(idx);
    } else {
      dedupe.set(key, [idx]);
    }
  }

  // Expel duplicates: for any (external_id, work_date) with > 1 hit, move ALL
  // of them to errors and remove from parsed.
  const dupedIndexes = new Set<number>();
  for (const [, indexes] of dedupe) {
    if (indexes.length > 1) {
      for (const idx of indexes) {
        dupedIndexes.add(idx);
      }
    }
  }
  if (dupedIndexes.size > 0) {
    const kept: ParsedDtrRow[] = [];
    for (let i = 0; i < parsed.length; i++) {
      if (dupedIndexes.has(i)) {
        const r = parsed[i]!;
        errors.push({
          row_index: -1,
          reason: "duplicate (employee, date)",
          raw: `${r.external_id_raw},${r.work_date}`,
        });
      } else {
        kept.push(parsed[i]!);
      }
    }
    return { rows: kept, errors };
  }

  return { rows: parsed, errors };
}
