import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Pins the active-patient rule in SQL. The TypeScript inventory
// (query-surfaces.test.ts) cannot see views or functions, so this reads the
// LATEST migration that defines each object and requires both predicates.
// A later migration that re-creates one of these without them — the exact
// way 0162 would drop them if re-applied after 0167 — fails here.

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

/** Body of the latest `create [or replace] (view|function) public.<name>` statement. */
function latestDefinition(kind: "view" | "function", name: string): { file: string; body: string } {
  const head = new RegExp(`create\\s+(or\\s+replace\\s+)?${kind}\\s+public\\.${name}\\b`, "i");
  for (const file of [...files].reverse()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const m = head.exec(sql);
    if (!m) continue;
    // Views end at the first ';' after the head; functions at the closing $$ ;.
    const rest = sql.slice(m.index);
    const end = kind === "view" ? rest.indexOf(";") : rest.search(/\$\$\s*;/);
    return { file, body: rest.slice(0, end === -1 ? undefined : end) };
  }
  throw new Error(`no migration defines ${kind} ${name}`);
}

// Each view also filters VISITS on deleted_at, so an unqualified
// "deleted_at is null" would match even with the patient predicate gone.
// Check the patients-side text specifically.
const PATIENT_SIDE: Record<string, (body: string) => string> = {
  v_patients_directory: (b) => b,
  v_patients_without_consent: (b) => b,
  // The predicates live in the `active` CTE (unqualified, from public.patients).
  v_patient_dedup_candidate_pairs: (b) => b.slice(b.indexOf("active as ("), b.indexOf("pairs as (")),
};
const PREDICATES: Record<string, [RegExp, RegExp]> = {
  v_patients_directory: [/p\.deleted_at\s+is\s+null/i, /p\.merged_into_id\s+is\s+null/i],
  v_patients_without_consent: [/p\.deleted_at\s+is\s+null/i, /p\.merged_into_id\s+is\s+null/i],
  v_patient_dedup_candidate_pairs: [/deleted_at\s+is\s+null/i, /merged_into_id\s+is\s+null/i],
};

describe("SQL directory surfaces apply the active-patient rule", () => {
  for (const view of Object.keys(PREDICATES)) {
    it(`${view} excludes deleted and merged patients`, () => {
      const { file, body } = latestDefinition("view", view);
      const side = PATIENT_SIDE[view]!(body);
      const [deleted, merged] = PREDICATES[view]!;
      expect(side, `${file} redefines ${view}`).toMatch(deleted);
      expect(side, `${file} redefines ${view}`).toMatch(merged);
    });
  }

  it("the admin inclusive view keeps deleted rows, drops merged rows, and is admin-gated", () => {
    const { body } = latestDefinition("view", "v_patients_directory_admin");
    expect(body).not.toMatch(/p\.deleted_at\s+is\s+null/i);
    expect(body).toMatch(/p\.merged_into_id\s+is\s+null/i);
    expect(body).toMatch(/has_role\(\s*array\['admin'\]\s*\)/i);
  });

  it("resolve_patient_guarded matches active patients only", () => {
    const { body } = latestDefinition("function", "resolve_patient_guarded");
    expect(body).toMatch(/p\.deleted_at\s+is\s+null/i);
    expect(body).toMatch(/p\.merged_into_id\s+is\s+null/i);
  });

  it("current_patient_id returns only an active patient", () => {
    const { body } = latestDefinition("function", "current_patient_id");
    expect(body).toMatch(/security\s+definer/i);
    expect(body).toMatch(/deleted_at\s+is\s+null/i);
    expect(body).toMatch(/merged_into_id\s+is\s+null/i);
  });
});
