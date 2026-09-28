// src/lib/auth/view-as-followups-migration.test.ts
// Reads migration 0187 as text (no database), like view-as-migration.test.ts.
// Pins what could drift silently between SQL and TS:
//   (a) the 4-hour duration in SQL equals VIEW_AS_DURATION_MS;
//   (b) the role list in view_as_transition equals VIEW_AS_ROLES;
//   (c) the trigger uses 0182's effective-override condition;
//   (d) the three functions are security definer + pinned search_path and are
//       closed to public/anon/authenticated, open to service_role;
//   (e) P0074 is the not-admin code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VIEW_AS_DURATION_MS, VIEW_AS_ROLES } from "./view-as";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/0187_view_as_followups.sql"),
  "utf8",
);

function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} not defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
  return sql.slice(start, end);
}

describe("0187_view_as_followups.sql", () => {
  it("(a) duration matches VIEW_AS_DURATION_MS", () => {
    const m = fnBody("view_as_transition").match(/now\(\) \+ interval '(\d+) hours'/);
    expect(m, "interval 'N hours' missing").not.toBeNull();
    expect(Number(m![1]) * 60 * 60 * 1000).toBe(VIEW_AS_DURATION_MS);
  });

  it("(b) the accepted roles are exactly VIEW_AS_ROLES", () => {
    const m = fnBody("view_as_transition").match(/p_role not in \(([^)]+)\)/);
    expect(m, "p_role not in (...) missing").not.toBeNull();
    const roles = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).sort();
    expect(roles).toEqual([...VIEW_AS_ROLES].sort());
  });

  it("(c) the stamp trigger uses the effective-override condition", () => {
    const body = fnBody("audit_log_stamp_view_as");
    expect(body).toContain("role = 'admin'");
    expect(body).toContain("view_as_until > now()");
    expect(body).toContain("starts_with(new.action, 'staff.view_as.')");
    expect(sql).toMatch(/create trigger audit_log_stamp_view_as\s+before insert on public\.audit_log/);
  });

  it("(d) all three are security definer with a pinned search_path and closed ACLs", () => {
    for (const name of ["view_as_transition", "view_as_expire", "audit_log_stamp_view_as"]) {
      const body = fnBody(name);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = public");
    }
    for (const sig of [
      "public.view_as_transition(uuid, text, inet, text)",
      "public.view_as_expire(uuid, inet, text)",
    ]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${sig} to service_role;`);
    }
    expect(sql).toContain(
      "revoke all on function public.audit_log_stamp_view_as() from public, anon, authenticated;",
    );
  });

  it("(e) not-admin raises P0074", () => {
    expect(fnBody("view_as_transition")).toContain("errcode = 'P0074'");
  });
});
