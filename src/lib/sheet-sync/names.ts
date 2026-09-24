/**
 * Identity keys for Sheet Sync (spec §5.2–§5.3, plan D6).
 *
 * nameNorm  = normalised surname + "|" + normalised given names (first + middle).
 *             Full-name equality compares these strings.
 * looseKey  = surname + "|" + FIRST given token — consults are typed without
 *             middle names, so this collapses "Dela Cruz, Juan" and
 *             "Dela Cruz, Juan Santos". Used to find suggestions and for
 *             unlinked mirror identities, never to auto-link a Customers row.
 * linkKey   = nameNorm + "#" + dob — the key of a durable identity decision
 *             (sheet_patient_links). Phone and registration date are excluded
 *             so correcting a phone number does not orphan a decision.
 *
 * Pure and not server-only: the CLI imports it.
 */
import { createHash } from "node:crypto";
import { normalizeName } from "../legacy-import/normalize-name";

export interface NameParts {
  first: string | null;
  middle: string | null;
  last: string | null;
}

export function nameNormOf(p: NameParts): string {
  const last = normalizeName(p.last ?? "");
  const given = normalizeName(`${p.first ?? ""} ${p.middle ?? ""}`);
  return `${last}|${given}`;
}

export function looseKeyOf(p: NameParts): string {
  const last = normalizeName(p.last ?? "");
  const first = normalizeName(p.first ?? "").split(" ")[0] ?? "";
  return `${last}|${first}`;
}

export function linkKeyOf(nameNorm: string, dob: string | null): string {
  return `${nameNorm}#${dob ?? ""}`;
}

/** Every normalised token of the name (surname tokens included). */
export function tokensOf(p: NameParts): string[] {
  return normalizeName(`${p.last ?? ""} ${p.first ?? ""} ${p.middle ?? ""}`)
    .split(" ")
    .filter(Boolean);
}

/** True when every token of `line` appears in `patient` (multiset-insensitive). */
export function isTokenSuperset(patient: readonly string[], line: readonly string[]): boolean {
  const have = new Set(patient);
  return line.every((t) => have.has(t));
}

/**
 * Last 10 digits, matching `patients.phone_normalized` (0105). Null below 10
 * digits, and null above 12 — a PH mobile is at most 12 digits as
 * 639XXXXXXXXX, so a longer digit run means the cell holds two numbers or an
 * extension (e.g. "09095534228 / 09171234567", "0909-553-4228 loc 12") and a
 * "last 10" tail would silently pick the wrong number.
 */
export function phone10(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (digits.length < 10 || digits.length > 12) return null;
  return digits.slice(-10);
}

export function sha1Hex(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** Customers row identity (spec §5.3): exact duplicates share it. */
export function sourceKeyOf(
  nameNorm: string,
  phone: string | null,
  dob: string | null,
  registeredOn: string | null,
): string {
  return sha1Hex([nameNorm, phone ?? "", dob ?? "", registeredOn ?? ""].join("␟"));
}
