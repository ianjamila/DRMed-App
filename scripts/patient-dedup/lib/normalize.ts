// scripts/patient-dedup/lib/normalize.ts
// Keep the name key IDENTICAL to the backfill matcher so this pass dissolves
// exactly the rows the backfill held as ambiguous.
export { matchKey, normalizeName } from "../../clinical-backfill/lib/names";

/** Digits-only phone key; null if fewer than 7 digits. */
export function phoneKey(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length >= 7 ? d : null;
}

/** Lowercased, trimmed email key; null if empty. */
export function emailKey(raw: string | null | undefined): string | null {
  const e = (raw ?? "").trim().toLowerCase();
  return e === "" ? null : e;
}
