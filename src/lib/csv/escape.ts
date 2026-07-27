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
