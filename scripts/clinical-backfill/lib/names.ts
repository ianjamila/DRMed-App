// Name normalization + parsing for patient matching.

/** Lowercase, strip diacritics, drop punctuation, collapse whitespace. */
export function normalizeName(raw: string): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // combining marks
    .toLowerCase()
    .replace(/'/g, "")                  // apostrophes -> drop (e.g. O'Brian -> obrian)
    .replace(/[^a-z0-9\s]/g, " ")      // other punctuation -> space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a free-text transaction name into {last, first}.
 * Primary format is "Last, First Middle" (the clinic's convention). Without a
 * comma, treat the final whitespace token as the surname.
 */
export function parseTransactionName(raw: string): { last: string; first: string } {
  const s = (raw ?? "").trim();
  if (!s) return { last: "", first: "" };
  if (s.includes(",")) {
    const [last, ...rest] = s.split(",");
    return { last: last.trim(), first: rest.join(",").trim() };
  }
  const tokens = s.split(/\s+/);
  if (tokens.length === 1) return { last: tokens[0], first: "" };
  const last = tokens[tokens.length - 1];
  const first = tokens.slice(0, -1).join(" ");
  return { last, first };
}

/** Stable match key: normalized surname + first given token. */
export function matchKey(last: string, first: string): string {
  const nl = normalizeName(last);
  if (!nl) return "";
  const nf = normalizeName(first).split(" ")[0] ?? "";
  return `${nl}|${nf}`;
}
