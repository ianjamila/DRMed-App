/**
 * In-memory lookup of live patients, built once per sync run (plan Task 5).
 * Pure and not server-only: the CLI imports it.
 */
import { looseKeyOf, nameNormOf, phone10, tokensOf } from "./names";
import type { PatientRecord } from "./types";

export interface PatientIndex {
  byId: Map<string, PatientRecord>;
  /** live patient ids by full nameNorm */
  byFullName: Map<string, string[]>;
  byLoose: Map<string, string[]>;
  byPhone: Map<string, string[]>;
  byDob: Map<string, string[]>;
  tokens: Map<string, string[]>;
  survivor(id: string): string | null;
  isLive(id: string): boolean;
}

const push = (m: Map<string, string[]>, k: string | null, v: string) => {
  if (!k) return;
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
};

export function buildPatientIndex(patients: readonly PatientRecord[]): PatientIndex {
  const byId = new Map(patients.map((p) => [p.id, p]));
  const byFullName = new Map<string, string[]>();
  const byLoose = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  const byDob = new Map<string, string[]>();
  const tokens = new Map<string, string[]>();
  for (const p of patients) {
    if (p.merged_into_id) continue;
    const parts = { first: p.first_name, middle: p.middle_name, last: p.last_name };
    push(byFullName, nameNormOf(parts), p.id);
    push(byLoose, looseKeyOf(parts), p.id);
    push(byPhone, p.phone_normalized ?? phone10(p.phone), p.id);
    push(byDob, p.birthdate, p.id);
    tokens.set(p.id, tokensOf(parts));
  }
  const survivor = (id: string): string | null => {
    let cur = byId.get(id);
    for (let hop = 0; cur && cur.merged_into_id && hop < 10; hop++) cur = byId.get(cur.merged_into_id);
    return cur && !cur.merged_into_id ? cur.id : null;
  };
  return { byId, byFullName, byLoose, byPhone, byDob, tokens, survivor,
    isLive: (id) => !!byId.get(id) && !byId.get(id)!.merged_into_id };
}
