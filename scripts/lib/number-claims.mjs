// scripts/lib/number-claims.mjs
//
// Pure helpers for scripts/claim-number.mjs: pull migration numbers and
// P-codes out of file names / text, and pick the next free one. No I/O, so
// number-claims.test.ts can cover them.

/** "0162_consent_list.sql" → 162; anything else → null. */
export function migrationNumberOf(fileName) {
  const m = /^(\d{4})_.+\.sql$/.exec(fileName.split("/").pop() ?? "");
  return m ? Number(m[1]) : null;
}

/** Every P00NN code mentioned in a text (SQL raise sites, pg-errors.ts cases). */
export function pCodesIn(text) {
  return [...text.matchAll(/\bP(\d{4})\b/g)].map((m) => Number(m[1]));
}

/**
 * The next number above everything seen. Never fills a gap: a gap may be a
 * number some session is holding in its head or its uncommitted work, and
 * gaps are harmless (0056–0058 never existed).
 */
export function nextFree(used) {
  let max = 0;
  for (const n of used) if (n > max) max = n;
  return max + 1;
}

export const formatMigration = (n) => String(n).padStart(4, "0");
export const formatPCode = (n) => `P${String(n).padStart(4, "0")}`;

/** Claim-file names: .claims/migration-0162, .claims/pcode-P0057. */
export function claimFileName(kind, n) {
  return kind === "migration" ? `migration-${formatMigration(n)}` : `pcode-${formatPCode(n)}`;
}

/** The number a claim-file name holds, for the given kind, or null. */
export function claimedNumberOf(kind, fileName) {
  const m =
    kind === "migration"
      ? /^migration-(\d{4})$/.exec(fileName)
      : /^pcode-P(\d{4})$/.exec(fileName);
  return m ? Number(m[1]) : null;
}
