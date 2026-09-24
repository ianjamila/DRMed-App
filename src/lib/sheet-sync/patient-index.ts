/**
 * In-memory lookup of patients, built once per sync run (plan Task 5).
 *
 * Every lookup map returns SURVIVOR ids: a live patient is keyed under its own
 * id, and a merged-away patient's name / loose key / phone / DOB are keyed
 * under the patient it was merged into. So a sheet row still spelled the way
 * staff typed the duplicate finds the record staff kept, instead of
 * re-creating the duplicate they already merged. Id arrays are deduped; a
 * merged patient whose chain does not reach a live patient is skipped.
 *
 * Patient phones are read as `phone10(p.phone)` — the same function the sheet
 * side uses — so both sides agree on what "the same phone" is (a stale or
 * missing `phone_normalized`, or a cell holding two numbers, never decides).
 *
 * Pure and not server-only: the CLI imports it.
 */
import { looseKeyOf, nameNormOf, phone10, tokensOf } from "./names";
import { normalizeName } from "../legacy-import/normalize-name";
import type { PatientRecord } from "./types";

/** One spelling of a survivor: its own name, or a merged-away patient's. */
export interface IndexedName {
  nameNorm: string;
  looseKey: string;
  /** first given token ("" when none) */
  firstToken: string;
  /** normalised LAST NAME tokens only (never the middle name) */
  lastTokens: string[];
  /** every normalised token of the name */
  tokens: string[];
}

export interface PatientIndex {
  byId: Map<string, PatientRecord>;
  /** survivor ids by full nameNorm (own name and merged aliases) */
  byFullName: Map<string, string[]>;
  byLoose: Map<string, string[]>;
  /** survivor ids by phone10 of `phone` (own and merged aliases) */
  byPhone: Map<string, string[]>;
  byDob: Map<string, string[]>;
  /** survivor id → one token list per indexed name (own + merged aliases) */
  tokens: Map<string, string[][]>;
  /** survivor id → every indexed spelling (own + merged aliases) */
  names: Map<string, IndexedName[]>;
  survivor(id: string): string | null;
  isLive(id: string): boolean;
  /** true for a phone that proves nothing: all one digit, or shared by ≥3 live survivors */
  junkOrShared(phone: string | null): boolean;
}

const push = (m: Map<string, string[]>, k: string | null, v: string) => {
  if (!k) return;
  const a = m.get(k);
  if (!a) m.set(k, [v]);
  else if (!a.includes(v)) a.push(v);
};

export function buildPatientIndex(patients: readonly PatientRecord[]): PatientIndex {
  const byId = new Map(patients.map((p) => [p.id, p]));
  const byFullName = new Map<string, string[]>();
  const byLoose = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  const byDob = new Map<string, string[]>();
  const tokens = new Map<string, string[][]>();
  const names = new Map<string, IndexedName[]>();

  const survivor = (id: string): string | null => {
    let cur = byId.get(id);
    for (let hop = 0; cur && cur.merged_into_id && hop < 10; hop++) cur = byId.get(cur.merged_into_id);
    return cur && !cur.merged_into_id ? cur.id : null;
  };

  // Live patients first so a survivor's own spelling is its first entry.
  const ordered = [...patients.filter((p) => !p.merged_into_id), ...patients.filter((p) => p.merged_into_id)];
  for (const p of ordered) {
    const s = survivor(p.id);
    if (!s) continue;
    const parts = { first: p.first_name, middle: p.middle_name, last: p.last_name };
    const nameNorm = nameNormOf(parts);
    const looseKey = looseKeyOf(parts);
    const toks = tokensOf(parts);
    push(byFullName, nameNorm, s);
    push(byLoose, looseKey, s);
    push(byPhone, phone10(p.phone), s);
    push(byDob, p.birthdate, s);
    const list = names.get(s) ?? [];
    if (!list.some((n) => n.nameNorm === nameNorm)) {
      list.push({ nameNorm, looseKey, firstToken: looseKey.split("|")[1] ?? "",
        lastTokens: normalizeName(p.last_name ?? "").split(" ").filter(Boolean), tokens: toks });
      names.set(s, list);
      tokens.set(s, list.map((n) => n.tokens));
    }
  }

  const junkOrShared = (phone: string | null): boolean => {
    if (!phone) return true;
    if (/^(\d)\1*$/.test(phone)) return true;
    return (byPhone.get(phone)?.length ?? 0) >= 3;
  };

  return { byId, byFullName, byLoose, byPhone, byDob, tokens, names, survivor, junkOrShared,
    isLive: (id) => !!byId.get(id) && !byId.get(id)!.merged_into_id };
}

/**
 * True when `have` contains every token of `want` AS MANY TIMES as `want`
 * does (a multiset superset): "Dela Cruz, Juan Dela" is not covered by
 * "Dela Cruz, Juan Santos", which has "dela" only once.
 */
export function isTokenMultisetSuperset(have: readonly string[], want: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const t of have) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const t of want) {
    const n = counts.get(t) ?? 0;
    if (n === 0) return false;
    counts.set(t, n - 1);
  }
  return true;
}
