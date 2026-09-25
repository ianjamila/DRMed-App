import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const ALLOWED = [
  "src/lib/sheet-sync/",
  "src/app/(staff)/staff/(dashboard)/admin/sheet-sync/",
  "src/types/database.ts",
];
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("sheet mirror tables stay out of money surfaces (spec §11)", () => {
  it("only the sync and its admin page read sheet_encounter_lines / sheet_customer_rows", () => {
    const offenders = walk(join(ROOT, "src"))
      .map((f) => relative(ROOT, f))
      .filter((f) => !ALLOWED.some((a) => f.startsWith(a)))
      .filter((f) => /sheet_(encounter_lines|customer_rows)/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });
  it("guards itself: the scan finds the sync's own readers", () => {
    const hits = walk(join(ROOT, "src/lib/sheet-sync")).filter((f) => /sheet_customer_rows/.test(readFileSync(f, "utf8")));
    expect(hits.length).toBeGreaterThan(0);
  });
  it("no migration other than 0170 mentions the mirror tables", () => {
    const migrationsDir = join(ROOT, "supabase/migrations");
    const offenders = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql") && f !== "0170_sheet_sync_foundation.sql")
      .filter((f) => /sheet_(encounter_lines|customer_rows)/.test(readFileSync(join(migrationsDir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
