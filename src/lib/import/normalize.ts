// String → numeric. Strips currency symbol, commas, surrounding whitespace.
// Throws on unparseable input (caller decides the validation severity).
export function parseDecimal(raw: string | number | null | undefined): number {
  if (raw == null) throw new Error("parseDecimal: null/undefined");
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) throw new Error(`parseDecimal: not finite: ${raw}`);
    return raw;
  }
  const cleaned = String(raw).replace(/[₱$,\s]/g, "").trim();
  if (cleaned === "") throw new Error("parseDecimal: empty after strip");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`parseDecimal: unparseable: "${raw}"`);
  return n;
}

// Workbook patient names are "Last, First" or "LAST, FIRST". Split on the
// FIRST comma so "Dela Cruz, Maria Clara" → { last: "Dela Cruz", first: "Maria Clara" }.
// Throws if there is no comma — caller surfaces as validation error.
export function splitLastFirstName(raw: string): { last: string; first: string } {
  const idx = raw.indexOf(",");
  if (idx < 0) throw new Error(`splitLastFirstName: no comma in "${raw}"`);
  const last = raw.slice(0, idx).trim();
  const first = raw.slice(idx + 1).trim();
  if (!last || !first) throw new Error(`splitLastFirstName: empty piece in "${raw}"`);
  return { last, first };
}

// Canonical normalization for patient dedup: uppercase, collapse internal whitespace,
// normalize comma-space patterns.
export function normalizeName(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
}
