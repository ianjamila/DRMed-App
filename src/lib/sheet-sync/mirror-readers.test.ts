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
  it("no migration other than the sheet sync foundation mentions the mirror tables", () => {
    // Matched by name, not number: the foundation migration has been renumbered
    // before. A later migration that legitimately reads the mirror (e.g. PR 2's
    // Patient Sources view) must be added here explicitly.
    const migrationsDir = join(ROOT, "supabase/migrations");
    const sql = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    const foundation = sql.filter((f) => /_sheet_sync_foundation\.sql$/.test(f));
    expect(foundation).toHaveLength(1);
    const offenders = sql
      .filter((f) => !foundation.includes(f))
      .filter((f) => MIRROR.test(readFileSync(join(migrationsDir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
