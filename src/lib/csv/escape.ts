/**
 * CSV cell escaping, shared by every `*.csv` route handler.
 *
 * This was four byte-identical private copies (operations cash/daily/expenses,
 * gift-code sales) before the Visits export would have made a fifth.
 */

/** RFC 4180 quoting: wrap only when needed, double any embedded quote. */
export function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
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
