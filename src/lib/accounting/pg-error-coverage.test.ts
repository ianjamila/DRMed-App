/**
 * Every P-code a migration can raise has a user-facing translation.
 *
 * WHY THIS EXISTS
 * ---------------
 * CLAUDE.md and the drmed-payments skill both say it: "New P-code →
 * `pg-errors.ts` translation in the same PR." A convention nobody checks is a
 * convention that decays, and the failure is quiet in the worst way — the
 * `default:` branch hands the raw Postgres message to the UI, so a guard that
 * was written to explain itself to reception instead shows them SQL prose, or
 * (for a raise with an internal message) nothing they can act on.
 *
 * It decayed already: writing this test is what found P0035 sitting
 * untranslated since migration 0059, on a path
 * (admin/result-templates/[service_id]/edit) that calls `translatePgError`.
 *
 * WHAT IT READS
 * -------------
 * The migration text, not a database — same reasoning as
 * `cash-denominations.parity.test.ts`. A raise is any `using errcode = 'P00NN'`
 * in `supabase/migrations/`.
 *
 * THE ALLOWLIST CAN ONLY SHRINK
 * -----------------------------
 * `DEAD_CODES` is not "codes we decided not to translate" — it is codes whose
 * raise site no longer exists in the live schema, which the migration history
 * still contains because migrations are append-only. Adding an entry needs the
 * reason to be the same one: the function was dropped. A new guard that raises
 * a new code belongs in `pg-errors.ts`, not here.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../supabase/migrations", import.meta.url),
);
const PG_ERRORS = fileURLToPath(new URL("./pg-errors.ts", import.meta.url));

/**
 * Raised only inside `reverse_petty_cash_entry`, which migration 0145 dropped
 * when the till got its single write path. Nothing in the live schema can
 * raise them, and nothing can produce a row the function would have accepted.
 */
const DEAD_CODES = new Set(["P0037", "P0038", "P0039"]);

function raisedCodes(): Map<string, string[]> {
  const byCode = new Map<string, string[]>();
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const m of text.matchAll(/errcode\s*=\s*'(P\d{4})'/g)) {
      const list = byCode.get(m[1]) ?? [];
      if (!list.includes(file)) list.push(file);
      byCode.set(m[1], list);
    }
  }
  return byCode;
}

function translatedCodes(): Set<string> {
  const text = readFileSync(PG_ERRORS, "utf8");
  return new Set([...text.matchAll(/case "(P\d{4})":/g)].map((m) => m[1]));
}

describe("P-code translation coverage", () => {
  const raised = raisedCodes();
  const translated = translatedCodes();

  it("every live P-code raised by a migration has a translatePgError case", () => {
    const missing = [...raised.entries()]
      .filter(([code]) => !translated.has(code) && !DEAD_CODES.has(code))
      .map(([code, files]) => `${code} (raised in ${files.join(", ")})`);

    expect(
      missing,
      "add a `case` to src/lib/accounting/pg-errors.ts for each of these",
    ).toEqual([]);
  });

  it("does not translate a code nothing raises", () => {
    // A stale case is harmless at runtime but means the guard it describes is
    // gone — which is worth knowing, because the behaviour it documented is
    // gone with it.
    const orphans = [...translated].filter((c) => !raised.has(c)).sort();
    expect(orphans).toEqual([]);
  });

  it("keeps the dead-code allowlist honest", () => {
    // Every allowlisted code must still appear in the history (otherwise the
    // entry is dead weight) and must still be absent from the translator
    // (otherwise it should just leave the list).
    for (const code of DEAD_CODES) {
      expect(raised.has(code), `${code} is allowlisted but no migration raises it`).toBe(true);
      expect(
        translated.has(code),
        `${code} is translated now — drop it from DEAD_CODES`,
      ).toBe(false);
    }
  });

  it("registers the two codes 0147 introduces", () => {
    expect(raised.get("P0050")).toContain("0147_ap_cash_bill_payment_drawer_link.sql");
    expect(raised.get("P0051")).toContain("0147_ap_cash_bill_payment_drawer_link.sql");
    expect(translated.has("P0050")).toBe(true);
    expect(translated.has("P0051")).toBe(true);
  });
});
