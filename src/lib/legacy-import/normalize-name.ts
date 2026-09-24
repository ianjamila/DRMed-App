// Name normalization for patient matching.

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
