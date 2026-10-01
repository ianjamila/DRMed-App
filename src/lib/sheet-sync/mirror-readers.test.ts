import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const MIRROR = /sheet_(encounter_lines|customer_rows)/;
const ALLOWED = [
  "src/lib/sheet-sync/",
  "src/app/(staff)/staff/(dashboard)/admin/sheet-sync/",
  "src/types/database.ts",
  "scripts/sheet-sync", // the CLI runner and the local db proof
  "scripts/patient-sources-db-proof.ts", // Patient Sources local proof (seeds mirror rows)
  "src/lib/patients/patient-fk-inventory.test.ts", // names the mirror tables only in a NOT_MOVED comment (their patient_id FK is deliberately not moved by a merge); never reads them
];
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules") return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(n) ? [p] : [];
  });
}
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

describe("sheet mirror tables stay out of money surfaces (spec §11)", () => {
  it("only the sync and its admin page read sheet_encounter_lines / sheet_customer_rows", () => {
    const offenders = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts"))]
      .map(rel)
      .filter((f) => !ALLOWED.some((a) => f.startsWith(a)))
      .filter((f) => MIRROR.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });
  it("guards itself: the scan finds the sync's own readers", () => {
    const hits = walk(join(ROOT, "src/lib/sheet-sync")).filter((f) => /sheet_customer_rows/.test(readFileSync(f, "utf8")));
    expect(hits.length).toBeGreaterThan(0);
  });
  it("no migration other than the sheet sync foundation, Patient Sources, their review-fix follow-up, the service-read re-grant, the held-patient tidy-up, the one-call report and the people helper mention the mirror tables", () => {
    // Matched by name, not number: the foundation migration has been renumbered
    // before. Patient Sources (PR 2, 0189) reads the mirror through admin-gated
    // report functions only; money surfaces stay forbidden. 0193 (sync review
    // fixes) re-creates functions from both — the sheet-sync apply RPC and the
    // Patient Sources readers — and nothing else. 0199 re-creates only
    // patient_sources_summary/series (verbatim bodies, service-key gate) so the
    // CLI first-night check and the weekly email can read them. 0204 re-creates
    // sheet_sync_revert_run (its undo cleanup nulls mirror patient ids) and
    // sheet_review_resolve, verbatim from 0170 plus a held_patient_id clear.
    // 0206 moves the Patient Sources section rules (summary reads the mirror's
    // latest dates) verbatim into closed helpers behind the same admin gates.
    // 0209 moves patient_sources_people's rules (the unlinked-name lookups read both mirror tables)
    // verbatim into a closed helper behind the same admin-only gate.
    const migrationsDir = join(ROOT, "supabase/migrations");
    const sql = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    const foundation = sql.filter((f) => /_sheet_sync_foundation\.sql$/.test(f));
    const patientSources = sql.filter((f) => /_patient_sources\.sql$/.test(f));
    expect(foundation).toHaveLength(1);
    expect(patientSources).toHaveLength(1);
    const reviewFixes = sql.filter((f) => /_sync_review_gaps\.sql$/.test(f));
    expect(reviewFixes).toHaveLength(1);
    const serviceRead = sql.filter((f) => /_patient_sources_service_read\.sql$/.test(f));
    expect(serviceRead).toHaveLength(1);
    const heldClear = sql.filter((f) => /_sheet_links_clear_held_patient\.sql$/.test(f));
    expect(heldClear).toHaveLength(1);
    const oneCall = sql.filter((f) => /_patient_sources_report\.sql$/.test(f));
    expect(oneCall).toHaveLength(1);
    const people = sql.filter((f) => /_patient_sources_people\.sql$/.test(f));
    expect(people).toHaveLength(1);
    const offenders = sql
      .filter((f) => !foundation.includes(f) && !patientSources.includes(f) && !reviewFixes.includes(f) && !serviceRead.includes(f) && !heldClear.includes(f) && !oneCall.includes(f) && !people.includes(f))
      .filter((f) => MIRROR.test(readFileSync(join(migrationsDir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
