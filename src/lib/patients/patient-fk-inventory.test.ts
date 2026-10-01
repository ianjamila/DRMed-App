// src/lib/patients/patient-fk-inventory.test.ts
// Every foreign key to public.patients anywhere in supabase/migrations/ must be
// either MOVED by a merge (merge_patients_guarded, 0196 — the same list as
// MERGE_MOVED_TABLES) or listed below as deliberately NOT moved, with why. A
// new FK fails this test until someone decides — the gap the old three-list
// actions.tables.test.ts guarded, now against the schema itself.
// The parser's output was checked against the live catalog on 2026-09-30:
//   select conrelid::regclass, a.attname from pg_constraint c join pg_attribute a
//     on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
//    where c.confrelid = 'public.patients'::regclass and c.contype = 'f';
// (13 rows, identical to FOUND below).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MERGE_MOVED_TABLES } from "./merge-fields";

const NOT_MOVED: Record<string, string> = {
  "patients.merged_into_id": "The merge marker itself — written by the merge, never re-pointed as history.",
  "patient_merges.keep_id": "The undo ledger names both records; moving it would erase what was merged.",
  "patient_merges.source_id": "Same as keep_id.",
  "sheet_patient_links.patient_id":
    "Sheet Sync identity link. The sync treats a merged target as stale and re-plans (0193); moving it would bypass the sync's own identity matching.",
  "patient_acquisition_facts.patient_id":
    "Patient Sources fact row. The report follows merged_into_id chains itself (_ps_survivors, 0189).",
  "sheet_customer_rows.patient_id": "Raw Sheet Sync mirror row — what the sheet row resolved to at the time; history.",
  "sheet_encounter_lines.patient_id": "Raw Sheet Sync mirror row — history; Patient Sources follows the chain.",
};

function scanPatientFks(): Set<string> {
  const dir = join(process.cwd(), "supabase/migrations");
  const found = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "");
    const re = /references\s+(?:public\.)?patients\s*(?:\(\s*id\s*\))?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) {
      const before = sql.slice(0, m.index);
      const line = sql.slice(before.lastIndexOf("\n") + 1, m.index);
      const tables = [
        ...before.matchAll(
          /(?:create\s+table\s+(?:if\s+not\s+exists\s+)?|alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?)(?:public\.)?"?(\w+)"?/gi,
        ),
      ];
      const table = tables.at(-1)?.[1] ?? "?";
      const fk = line.match(/foreign\s+key\s*\(\s*(\w+)\s*\)/i);
      const col = fk?.[1] ?? line.match(/^\s*(?:add\s+column\s+(?:if\s+not\s+exists\s+)?)?(\w+)\s+uuid/i)?.[1] ?? "?";
      found.add(`${table}.${col}`);
    }
  }
  return found;
}

const FOUND = scanPatientFks();
const MOVED = new Set(MERGE_MOVED_TABLES.map((t) => `${t}.patient_id`));

describe("foreign keys to public.patients", () => {
  it("the parser resolves every FK to a table.column", () => {
    for (const k of FOUND) expect(k, k).not.toMatch(/\?/);
  });
  it("every FK is either moved by a merge or deliberately not moved", () => {
    const unclassified = [...FOUND].filter((k) => !MOVED.has(k) && !(k in NOT_MOVED));
    expect(unclassified, "new FK to patients — add it to 0196's moves or to NOT_MOVED with a reason").toEqual([]);
  });
  it("every classified FK still exists (no stale entries)", () => {
    for (const k of [...MOVED, ...Object.keys(NOT_MOVED)]) expect(FOUND.has(k), k).toBe(true);
  });
  it("matches the 13 FKs in the live catalog (2026-09-30)", () => {
    expect(FOUND.size).toBe(13);
  });
});
