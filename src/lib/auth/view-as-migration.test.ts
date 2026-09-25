// src/lib/auth/view-as-migration.test.ts
// Reads migration 0182 as text, without a database (same reasoning as
// result-edit-migration.test.ts). Pins what could drift silently:
//   (a) the allowed override roles = VIEW_AS_ROLES;
//   (b) exactly staff_role() and has_role() are redefined, is_staff() is not;
//   (c) both keep STABLE / SECURITY DEFINER / search_path and carry the
//       effective-role CASE that view-as.ts mirrors;
//   (d) the migration asserts anon + authenticated EXECUTE on all three helpers.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VIEW_AS_ROLES } from "./view-as";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/0182_staff_view_as_role.sql"),
  "utf8",
);

const CASE = "when role = 'admin' and view_as_until > now() then view_as_role";

function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  expect(start, `${name} not redefined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
  return sql.slice(start, end);
}

describe("0182_staff_view_as_role.sql", () => {
  it("(a) the role check constraint lists exactly VIEW_AS_ROLES", () => {
    const m = sql.match(/view_as_role in \(([^)]+)\)/);
    expect(m, "view_as_role IN (...) check missing").not.toBeNull();
    const roles = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
    expect(roles).toEqual([...VIEW_AS_ROLES].sort());
  });

  it("(a) both-or-neither pair constraint exists", () => {
    expect(sql).toContain("(view_as_role is null) = (view_as_until is null)");
  });

  it("(b) redefines staff_role() and has_role() and nothing else", () => {
    const defs = sql.match(/create or replace function public\.([a-z_]+)/g) ?? [];
    expect(defs.sort()).toEqual([
      "create or replace function public.has_role",
      "create or replace function public.staff_role",
    ]);
  });

  it("(c) both keep their properties and use the effective-role CASE", () => {
    for (const name of ["staff_role()", "has_role(roles text[])"]) {
      const body = fnBody(name);
      expect(body).toContain("stable");
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = public");
      expect(body).toContain("is_active = true");
      expect(body).toContain(CASE);
    }
    expect(fnBody("staff_role()")).toContain("returns text");
    expect(fnBody("has_role(roles text[])")).toContain("= any(roles)");
  });

  it("(d) asserts anon and authenticated EXECUTE on all three helpers", () => {
    for (const grantee of ["anon", "authenticated"]) {
      for (const fn of ["public.has_role(text[])", "public.staff_role()", "public.is_staff()"]) {
        expect(sql).toContain(`has_function_privilege('${grantee}', '${fn}', 'EXECUTE')`);
      }
    }
  });
});
