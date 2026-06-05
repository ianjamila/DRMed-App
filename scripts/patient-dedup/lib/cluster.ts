// scripts/patient-dedup/lib/cluster.ts
import { matchKey } from "./normalize";
import type { PatientRow } from "./types";

export type Cluster = PatientRow[];

/** Group live patients strictly by matchKey. A cluster is any name key shared by
 *  >= 2 rows. Corroborating signals (DOB/phone/email) are NOT used here — that is
 *  plan.ts's job. Different surnames -> different keys -> never joined, so a shared
 *  family phone can never pull two different people into one cluster. */
export function clusterByName(rows: PatientRow[]): Cluster[] {
  const groups = new Map<string, PatientRow[]>();
  for (const r of rows) {
    const k = matchKey(r.last_name ?? "", r.first_name ?? "");
    if (!k) continue;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}
