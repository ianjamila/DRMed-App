/**
 * Guard: a hardened view must not lose `security_invoker` to a later redefinition.
 *
 * WHY THIS EXISTS
 * ---------------
 * `create or replace view`'s WITH clause REPLACES the view's options — it does
 * not merge with what is already set. Omit the clause and `security_invoker`
 * silently reverts to off, so the view goes back to running with its OWNER's
 * rights and base-table RLS stops applying. Nothing errors, no test fails, and
 * the view keeps returning rows: the only visible change is that it now returns
 * them to callers RLS was meant to stop. (Verified locally on PG 17, and it is
 * how a real Supabase disclosure happened — supabase/supabase#35823, where the
 * definition was copied out of the Dashboard, which drops the WITH clause.)
 *
 * This is not hypothetical for the views listed below. The four v_hmo_* views
 * were recreated three separate times during ordinary feature work (0078, 0079,
 * 0080, 0081, 0082) — any one of those, written after 0135, would have quietly
 * reopened the anon-readable disclosure 0135 exists to close.
 *
 * So: once a view is hardened, EVERY later `create or replace view` of it must
 * restate `with (security_invoker = on)`. That is a convention, and a
 * convention nobody checks is a convention that decays — the same reasoning as
 * scripts/lib/guard-coverage.test.ts.
 *
 * FIXING A FAILURE
 * ----------------
 *     create or replace view public.v_hmo_unbilled
 *     with (security_invoker = on) as
 *     select ...
 *
 * Adding a view here is how you opt it into the guard; do that in the same
 * migration that hardens it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");

/** Views hardened by a migration, and the migration that hardened each. */
const HARDENED: Record<string, string> = {
  v_daily_revenue_by_service: "0134",
  v_staff_advances_outstanding: "0134",
  v_hmo_unbilled: "0135",
  v_hmo_stuck: "0135",
  v_hmo_ar_aging: "0135",
  v_hmo_provider_summary: "0135",
  v_inventory_balances: "0135",
  // Not hardened BY 0136 — it was already security_invoker — but 0136 recreates
  // it, which is exactly when the option is easiest to drop. Registered here so
  // the next recreation cannot lose it silently.
  v_ops_daily_doctor: "0136",
};

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({
    file,
    /** The leading 00NN, so "later than the hardening migration" is comparable. */
    number: file.slice(0, 4),
    sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
  }));

/**
 * Match `create [or replace] view public.<name>` and capture whatever follows
 * up to the `as` that opens the body — that span is where a WITH clause lives.
 */
function redefinitionsOf(sql: string, view: string): string[] {
  const re = new RegExp(
    String.raw`create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?${view}\b([\s\S]*?)\bas\b`,
    "gi",
  );
  return [...sql.matchAll(re)].map((m) => m[1]);
}

describe("hardened views keep security_invoker", () => {
  it("pins the set of views under guard", () => {
    // A reminder to extend HARDENED in the same migration that hardens a view —
    // a view that is hardened but not listed here is guarded by nothing.
    expect(Object.keys(HARDENED).sort()).toEqual([
      "v_daily_revenue_by_service",
      "v_hmo_ar_aging",
      "v_hmo_provider_summary",
      "v_hmo_stuck",
      "v_hmo_unbilled",
      "v_inventory_balances",
      "v_ops_daily_doctor",
      "v_staff_advances_outstanding",
    ]);
  });

  for (const [view, hardenedIn] of Object.entries(HARDENED)) {
    it(`${view} is not redefined after ${hardenedIn} without restating the option`, () => {
      const offenders = migrations
        .filter((m) => m.number > hardenedIn)
        .flatMap((m) =>
          redefinitionsOf(m.sql, view)
            .filter((head) => !/security_invoker\s*=\s*(on|true)/i.test(head))
            .map(() => m.file),
        );
      expect(offenders).toEqual([]);
    });
  }
});

describe("the guard itself", () => {
  it("finds the redefinitions that really are in the tree", () => {
    // v_hmo_unbilled was recreated in 0034, 0080, 0081 and 0082 — if this stops
    // matching, the regex has drifted and every test above passes vacuously.
    const hits = migrations.filter((m) => redefinitionsOf(m.sql, "v_hmo_unbilled").length > 0);
    expect(hits.map((m) => m.number)).toEqual(["0034", "0080", "0081", "0082"]);
  });

  it("treats a redefinition that omits the option as an offender", () => {
    expect(redefinitionsOf("create or replace view public.v_x as select 1;", "v_x")).toEqual([" "]);
  });

  it("accepts a redefinition that restates the option", () => {
    const head = redefinitionsOf(
      "create or replace view public.v_x\nwith (security_invoker = on) as\nselect 1;",
      "v_x",
    );
    expect(head).toHaveLength(1);
    expect(/security_invoker\s*=\s*(on|true)/i.test(head[0])).toBe(true);
  });
});
