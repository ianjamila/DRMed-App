import { parseTransactionName, matchKey } from "./names";

export interface PatientRow {
  id: string; last_name: string | null; first_name: string | null; sex?: string | null;
}

export type PatientIndex = Map<string, string[]>; // matchKey -> patient ids

export function buildPatientIndex(rows: PatientRow[]): PatientIndex {
  const idx: PatientIndex = new Map();
  for (const p of rows) {
    const k = matchKey(p.last_name ?? "", p.first_name ?? "");
    if (!k) continue;
    const arr = idx.get(k);
    if (arr) { if (!arr.includes(p.id)) arr.push(p.id); }
    else idx.set(k, [p.id]);
  }
  return idx;
}

export type MatchResult =
  | { kind: "match"; patient_id: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "none" };

/** Pure match of a transaction name against the index. Gender unused for now
 *  (kept in the signature so a future tiebreak doesn't churn callers). */
export function matchPatient(patientName: string, _sex: string, idx: PatientIndex): MatchResult {
  const { last, first } = parseTransactionName(patientName);
  const k = matchKey(last, first);
  if (!k) return { kind: "none" };
  const cands = idx.get(k);
  if (!cands || cands.length === 0) return { kind: "none" };
  if (cands.length === 1) return { kind: "match", patient_id: cands[0] };
  return { kind: "ambiguous", candidates: [...cands] };
}
