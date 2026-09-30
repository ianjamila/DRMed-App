import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// 0184: a visit, a result, their links and PINs are created only inside the
// transactional RPCs (create_visit_encounter, result_create_linked,
// record_hmo_settlement). A new direct insert would bring back the half-created
// states (a visit with no lines or PIN, an orphan results row) those RPCs
// removed. Money inserts that are single statements stay allowed where listed.

const SRC = join(process.cwd(), "src");
const FORBIDDEN = ["visits", "test_requests", "visit_pins", "results", "result_test_requests"];
const ALLOWED: Record<string, string[]> = {
  payments: ["src/app/(staff)/staff/(dashboard)/payments/new/actions.ts"],
  hmo_payment_allocations: ["src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts"],
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}
const files = walk(SRC).map((p) => ({ rel: relative(process.cwd(), p).split(sep).join("/"), text: readFileSync(p, "utf8") }));
// Double, single or backtick quotes around the table name — the same call in
// any quote style is the same insert.
const insertRe = (table: string) =>
  new RegExp(`\\.from\\(\\s*(["'\\x60])${table}\\1\\s*\\)\\s*\\.\\s*(insert|upsert)\\(`);
const insertsInto = (table: string) =>
  files
    .filter((f) => insertRe(table).test(f.text))
    .map((f) => f.rel);

describe("creation paths (0184)", () => {
  it.each(FORBIDDEN)("nothing in src/ inserts into %s directly", (table) => {
    expect(insertsInto(table)).toEqual([]);
  });
  it.each(Object.keys(ALLOWED))("only the listed files insert into %s", (table) => {
    expect(insertsInto(table).sort()).toEqual([...ALLOWED[table]!].sort());
  });
  it("mutation proof: the matcher sees a multi-line insert", () => {
    expect(insertRe("visits").test(`admin\n  .from("visits")\n  .insert({})`)).toBe(true);
  });
  it("mutation proof: the matcher sees single-quoted and backtick table names", () => {
    expect(insertRe("visits").test(`admin.from('visits').insert({})`)).toBe(true);
    expect(insertRe("visits").test("admin.from(`visits`).upsert({})")).toBe(true);
    expect(insertRe("results").test(`admin\n  .from( 'results' )\n  .insert({})`)).toBe(true);
  });
  it("mutation proof: mismatched quotes and other tables do not match", () => {
    expect(insertRe("visits").test(`admin.from("visits').insert({})`)).toBe(false);
    expect(insertRe("visits").test(`admin.from("visit_notes").insert({})`)).toBe(false);
  });
});
