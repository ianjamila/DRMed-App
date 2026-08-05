/**
 * SQL ↔ TS denomination parity.
 *
 * The denomination table exists twice: once in TypeScript
 * (`CASH_DENOMINATIONS`) and once in SQL, inside migration 0132 — and the SQL
 * copy is itself written out twice, as the `cash_denomination_total_php` values
 * table and as the P0048 guard's slug whitelist. Three lists that must agree.
 *
 * If they drift, the failure is nasty and silent-ish: the app derives
 * `counted_cash_php` from the TS table and the guard re-checks it with the SQL
 * table, so a mismatched VALUE makes every close fail P0048 in production while
 * every unit test still passes, and a missing SLUG makes one pile unrecordable.
 *
 * This test parses the migration text rather than querying a database, for two
 * reasons: `npm test` is pure-logic-only and has no stack to talk to, and the
 * migration file is the actual source of truth — a live local database can be
 * stale or hand-patched, the committed SQL cannot.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CASH_DENOMINATIONS, DENOMINATION_KEYS } from "./cash-denominations";

const MIGRATION = fileURLToPath(
  new URL("../../../supabase/migrations/0132_eod_denomination_count.sql", import.meta.url),
);

const sql = readFileSync(MIGRATION, "utf8");

/** The `(values ('bill_1000', 1000::numeric), …)` table inside the helper. */
function parseValuesTable(text: string): { slug: string; value: number }[] {
  const body = text.match(
    /create or replace function public\.cash_denomination_total_php[\s\S]*?from \(values([\s\S]*?)\) as d\(slug, value_php\)/,
  );
  if (!body) throw new Error("could not locate the values table in cash_denomination_total_php");
  return [...body[1].matchAll(/\(\s*'([^']+)'\s*,\s*([0-9.]+)::numeric\s*\)/g)].map((m) => ({
    slug: m[1],
    value: Number(m[2]),
  }));
}

/** The `v_slugs text[] := array[…]` whitelist inside the P0048 guard. */
function parseGuardWhitelist(text: string): string[] {
  const body = text.match(/v_slugs\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/);
  if (!body) throw new Error("could not locate v_slugs in the P0048 guard");
  return [...body[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("SQL ↔ TS denomination parity", () => {
  const valuesTable = parseValuesTable(sql);
  const whitelist = parseGuardWhitelist(sql);

  it("finds all three copies of the table (the parser itself still works)", () => {
    // Guards against the migration being reformatted into a shape the regexes
    // miss, which would otherwise turn this whole file into a silent no-op.
    expect(valuesTable.length).toBeGreaterThan(0);
    expect(whitelist.length).toBeGreaterThan(0);
  });

  it("cash_denomination_total_php lists exactly the TS slugs, in the same order", () => {
    expect(valuesTable.map((r) => r.slug)).toEqual([...DENOMINATION_KEYS]);
  });

  it("cash_denomination_total_php carries the same peso value for every slug", () => {
    const sqlValues = Object.fromEntries(valuesTable.map((r) => [r.slug, r.value]));
    for (const d of CASH_DENOMINATIONS) {
      expect(sqlValues[d.key], `peso value for ${d.key}`).toBe(d.value_php);
    }
  });

  it("the P0048 guard whitelist matches the TS slugs", () => {
    expect(whitelist).toEqual([...DENOMINATION_KEYS]);
  });

  it("keeps the ₱20 bill and ₱20 coin as two SQL rows of the same value", () => {
    // The one place a careless "de-duplicate the table" edit would break the
    // feature: collapsing these two loses a physical pile.
    const twenties = valuesTable.filter((r) => r.value === 20);
    expect(twenties.map((r) => r.slug)).toEqual(["bill_20", "coin_20"]);
  });

  it("cross-references the TS module from the SQL, so the next editor is told", () => {
    expect(sql).toContain("src/lib/accounting/cash-denominations.ts");
  });
});
