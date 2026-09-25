/**
 * CSV cell escaping, shared by every `*.csv` route handler.
 *
 * This was four byte-identical private copies (operations cash/daily/expenses,
 * gift-code sales) before the Visits export would have made a fifth.
 */

/**
 * Spreadsheet formula injection (CWE-1236): Excel / Sheets treat a cell that
 * starts with = + - @ (or a tab / CR) as a formula, so free text a staff
 * member typed — a payment reason, a reference, a patient note — could run
 * as one when an admin opens the export. Such a cell gets a leading `'`,
 * which spreadsheets read as "this is text".
 *
 * Numbers and phone-like values (-500.00, +63 917 123 4567) are left alone:
 * with no letters or = / @ in them there is nothing a formula could call, and
 * prefixing them would turn every negative amount into text.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NUMBER_LIKE = /^[\d\s().,+\-]*$/;

export function neutraliseFormula(s: string): string {
  return FORMULA_LEAD.test(s) && !NUMBER_LIKE.test(s) ? `'${s}` : s;
}

/** RFC 4180 quoting: wrap only when needed, double any embedded quote. */
export function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? neutraliseFormula(v) : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Join one row of already-raw values into an escaped CSV line. */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map(escapeCell).join(",");
}

/** Build a whole CSV document (trailing newline included, as Excel expects). */
export function csvDocument(rows: readonly (readonly unknown[])[]): string {
  return rows.map(csvRow).join("\n") + "\n";
}

/**
 * A CSV built from records rather than positional rows: the header comes from
 * the first record's keys, then one line per record.
 *
 * This is what the browser-built exports need — they hold rows, not the
 * header-plus-arrays shape a Route Handler loader produces. `truncatedNotice`
 * appends the same in-band warning `reportCsvResponse` writes, so a file that
 * stopped at the export ceiling says so whichever mechanism produced it.
 */
export function csvDocumentFromRecords(
  records: readonly Record<string, unknown>[],
  opts: { truncatedNotice?: string } = {},
): string {
  if (records.length === 0) return "";
  const header = Object.keys(records[0]);
  const body: unknown[][] = [header];
  for (const record of records) {
    body.push(header.map((key) => record[key] ?? ""));
  }
  if (opts.truncatedNotice) body.push([opts.truncatedNotice]);
  return csvDocument(body);
}
