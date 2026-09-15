/**
 * Guard: every anon/authenticated REVOKE in a migration is re-stated in
 * `supabase/seed.sql`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `supabase/seed.sql` ends with two blanket lines that exist so a locally
 * applied migration doesn't have to remember grants:
 *
 *     alter default privileges for role postgres in schema public
 *       grant all on tables to anon, authenticated, service_role;
 *
 * That blanket covers VIEWS too. So every object a migration deliberately
 * revoked from anon/authenticated is handed straight back the moment someone
 * runs `npm run db:reset` — unless seed.sql also re-revokes it by name. `db
 * push` ignores seed.sql, so prod is unaffected and the two silently disagree
 * on exactly the ACL the migration exists to set. A local replay then "proves"
 * a permission state that prod does not have.
 *
 * 0134, 0135, 0136 and 0148 each carry a hand-written carve-out at the tail of
 * seed.sql for this reason, with a comment explaining it — but nothing checked
 * that the next one gets written. This is that check, on the same reasoning as
 * `hardened-views.test.ts`: a convention nobody verifies is a convention that
 * decays.
 *
 * FIXING A FAILURE
 * ----------------
 * Append the same revoke to the tail of `supabase/seed.sql`, with a line
 * saying which migration it mirrors and why the object is restricted.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");
const SEED = readFileSync(join(process.cwd(), "supabase/seed.sql"), "utf8");

const RESTRICTED_ROLES = ["anon", "authenticated"] as const;

/**
 * `revoke ... on [table] public.<name> from <roles>;` — deliberately loose on
 * the privilege list so `revoke all` and `revoke select` both match.
 */
const REVOKE_RE =
  /revoke\s+[\w\s,]+?\s+on\s+(?:table\s+)?public\.(\w+)\s+from\s+([^;]+);/gi;

interface Revocation {
  object: string;
  roles: string[];
}

function revocationsIn(sql: string): Revocation[] {
  return [...sql.matchAll(REVOKE_RE)]
    .map((m) => ({
      object: m[1]!,
      roles: m[2]!.split(",").map((r) => r.trim().toLowerCase()),
    }))
    .filter((r) => r.roles.some((role) => RESTRICTED_ROLES.includes(role as never)));
}

/** Objects seed.sql re-revokes, and from which roles. */
const seededByObject = new Map<string, Set<string>>();
for (const rev of revocationsIn(SEED)) {
  const roles = seededByObject.get(rev.object) ?? new Set<string>();
  for (const role of rev.roles) roles.add(role);
  seededByObject.set(rev.object, roles);
}

/**
 * Migration revokes, deduped per object+role. `revoke ... on function` is out
 * of scope: the seed's blanket is `on tables` / `on sequences` only (0118
 * deliberately left function grants alone), so a function revoke survives a
 * reset on its own.
 */
const migrationRevocations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .flatMap((file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
      // Drop `revoke ... on function ...` before matching.
      .replace(/revoke[^;]*?\son\s+function[^;]*;/gi, "")
      // …and anything inside a line comment, so the prose above a revoke
      // (which often quotes one) can't register as a real statement.
      .replace(/^\s*--.*$/gm, "");
    return revocationsIn(sql).map((r) => ({ file, ...r }));
  });

describe("seed.sql mirrors every anon/authenticated revoke", () => {
  it("finds the revokes that really are in the tree", () => {
    // If this stops matching, every assertion below passes vacuously.
    const objects = [...new Set(migrationRevocations.map((r) => r.object))].sort();
    expect(objects).toContain("v_hmo_unbilled");
    expect(objects).toContain("v_daily_revenue_by_service");
    expect(objects).toContain("v_ops_daily_totals");
    expect(objects.length).toBeGreaterThanOrEqual(8);
  });

  for (const { file, object, roles } of migrationRevocations) {
    for (const role of roles.filter((r) =>
      RESTRICTED_ROLES.includes(r as never),
    )) {
      it(`${object} is re-revoked from ${role} in seed.sql (${file})`, () => {
        expect(seededByObject.get(object) ?? new Set()).toContain(role);
      });
    }
  }
});

describe("the guard itself", () => {
  it("reads a multi-role revoke as covering both roles", () => {
    expect(
      revocationsIn("revoke all on public.v_x from anon, authenticated;"),
    ).toEqual([{ object: "v_x", roles: ["anon", "authenticated"] }]);
  });

  it("ignores a revoke that does not touch anon or authenticated", () => {
    expect(revocationsIn("revoke all on public.v_x from service_role;")).toEqual([]);
  });

  it("matches a narrowed privilege, not just `revoke all`", () => {
    expect(revocationsIn("revoke select on public.v_x from anon;")).toEqual([
      { object: "v_x", roles: ["anon"] },
    ]);
  });

  it("would fail an object seed.sql never re-revokes", () => {
    expect(seededByObject.has("v_never_revoked_anywhere")).toBe(false);
  });
});
