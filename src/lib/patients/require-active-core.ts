import { firstInactivePatient, inactivePatientError, type PatientLifecycle } from "./active";

export type ActiveCheck = { ok: true } | { ok: false; error: string };

/**
 * `rows` = the lifecycle rows found for the distinct patient ids a write
 * touches; `expected` = how many distinct ids there were. A missing row is a
 * refusal (the id was wrong or the row is gone), never a pass.
 */
export function activeCheck(rows: readonly PatientLifecycle[], expected: number): ActiveCheck {
  const bad = firstInactivePatient(rows);
  if (bad) return { ok: false, error: inactivePatientError(bad) };
  if (rows.length < expected) return { ok: false, error: inactivePatientError(null) };
  return { ok: true };
}

/**
 * Split ids into groups of at most `size`, preserving order. Used to keep
 * every `.in("id", …)` in require-active.ts safe for a caller-supplied list
 * that can run into the hundreds (bulk release, an HMO claim batch) — a
 * single unbounded `.in()` is both a PostgREST/Postgres risk and, unlike the
 * chunking already done for the final patients lookup, was missing on the
 * intermediate visit/test_request/appointment/claim-item resolution queries.
 */
export function chunkIds(ids: readonly string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
