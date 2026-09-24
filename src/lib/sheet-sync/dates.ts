/**
 * Sheet date cells (spec §5.1). Read with dateTimeRenderOption=SERIAL_NUMBER,
 * so a real date cell arrives as a serial (days since 1899-12-30; 25569 =
 * 1970-01-01) and anything typed as text arrives as its text. Each cell is
 * parsed on its own — never by block — and range-checked.
 *
 * No Date objects: the serial is converted with Howard Hinnant's
 * civil-from-days integer algorithm, so there is no timezone in the path
 * (manila-usage.test.ts bans the Date shortcuts).
 */
import { daysInMonth } from "../dates/manila";

export const WINDOW_FLOOR = "2023-12-01";
const DOB_FLOOR = "1900-01-01";
const EPOCH_SERIAL = 25569;

export type DateIssue = "unparseable" | "out_of_range" | null;
export interface DateParse {
  iso: string | null;
  issue: DateIssue;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function civilFromDays(z0: number): string {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

export function serialToISODate(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const days = Math.floor(serial) - EPOCH_SERIAL;
  if (days < -80000 || days > 80000) return null; // outside 1750..2189 — junk
  return civilFromDays(days);
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** Known live typos for month names, seen in the sheet (spec §5.1). */
const MONTH_TYPOS: Record<string, number> = {
  septmeber: 9,
  febuary: 2,
};

/**
 * A month word is accepted iff, case-insensitively with a trailing "."
 * stripped, it is a prefix of length ≥ 3 of the full English month name
 * (so "SEPT", "SEP", "SEPTEMBER", "AUG", "JUNE" all pass), or one of the
 * known live typos above. This rejects a word whose first 3 letters merely
 * coincide with a month's — "MARTES" (Tagalog for Tuesday) and "MARCHING"
 * both start "MAR" but are not prefixes of "MARCH".
 */
function monthFromWord(raw: string): number | null {
  const w = raw.replace(/\.$/, "").toLowerCase();
  if (w.length < 3) return null;
  const typo = MONTH_TYPOS[w];
  if (typo) return typo;
  const idx = MONTH_NAMES.findIndex((name) => name.startsWith(w));
  return idx === -1 ? null : idx + 1;
}

function ymd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1000 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

function parseText(raw: string): string | null {
  const s = raw.trim().replace(/[^A-Za-z0-9]+$/, "");
  if (!s) return null;
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(\s+\d{1,2}:\d{2}(:\d{2})?)?$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    // With a time it is a form timestamp typed D/M; without, the sheet's M/D.
    return m[4] ? ymd(y, b, a) : ymd(y, a, b);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (m) return ymd(Number(m[3]), Number(m[1]), Number(m[2]));
  m = /^(\d{1,2})-([A-Za-z]{3,})-(\d{4})$/.exec(s);
  if (m) {
    const mo = monthFromWord(m[2]);
    return mo ? ymd(Number(m[3]), mo, Number(m[1])) : null;
  }
  m = /^([A-Za-z]{3,})\.?\s*(\d{1,2})\s*,?\s*(\d{4})$/.exec(s);
  if (m) {
    const mo = monthFromWord(m[1]);
    return mo ? ymd(Number(m[3]), mo, Number(m[2])) : null;
  }
  return null;
}

function parseCell(cell: unknown, floor: string, today: string): DateParse {
  if (cell === null || cell === undefined) return { iso: null, issue: null };
  if (typeof cell === "string" && cell.trim() === "") return { iso: null, issue: null };
  let iso: string | null = null;
  if (typeof cell === "number") iso = serialToISODate(cell);
  else if (typeof cell === "string") iso = parseText(cell);
  if (!iso) return { iso: null, issue: "unparseable" };
  if (iso < floor || iso > today) return { iso: null, issue: "out_of_range" };
  return { iso, issue: null };
}

/** Registration / service / release dates: 2023-12-01 ≤ d ≤ today (Manila). */
export function parseEventDateCell(cell: unknown, todayManila: string): DateParse {
  return parseCell(cell, WINDOW_FLOOR, todayManila);
}

/** Dates of birth: 1900-01-01 ≤ d ≤ today. */
export function parseDobCell(cell: unknown, todayManila: string): DateParse {
  return parseCell(cell, DOB_FLOOR, todayManila);
}
