// src/lib/auth/claim-holder-guard-migration.test.ts
// Reads migration 0190 as text (no database), like
// view-as-followups-migration.test.ts / result-edit-migration.test.ts. Pins
// what could silently drift between the SQL trigger and the TypeScript rule
// it mirrors (src/lib/auth/role-sections.ts):
//   (a) the SQL single-owner CASE equals CLAIM_OWNER_BY_SECTION;
//   (b) the trigger calls lab_sections_for_role() to get the role's scope;
//   (c) the trigger uses the 0182 effective-role CASE, not the raw role
//       column, to look up the holder;
//   (d) test_requests_claim_holder_guard() and view_as_end_for() are both
//       security definer with a pinned search_path, closed to
//       public/anon/authenticated and open to service_role;
//   (e) the guard raises P0075, view_as_end_for raises P0076.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIM_OWNER_BY_SECTION, ALL_SECTIONS, type ServiceSection } from "./role-sections";

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/0190_claim_holder_guard_and_view_as_end_for.sql"),
  "utf8",
);

function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} not defined`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", sql.indexOf("as $$", start));
  return sql.slice(start, end);
}

describe("0190_claim_holder_guard_and_view_as_end_for.sql", () => {
  it("(a) the SQL single-owner CASE equals CLAIM_OWNER_BY_SECTION", () => {
    const body = fnBody("test_requests_claim_holder_guard");
    const caseStart = body.indexOf("v_owner := case v_section");
    expect(caseStart, "v_owner := case v_section ... missing").toBeGreaterThan(-1);
    const caseEnd = body.indexOf("end;", caseStart);
    const caseBody = body.slice(caseStart, caseEnd);

    const parsed: Record<string, string> = {};
    for (const m of caseBody.matchAll(/when\s+'(\w+)'\s+then\s+'(\w+)'/g)) {
      parsed[m[1]] = m[2];
    }
    expect(/else\s+null/.test(caseBody), "the CASE must default to null (no owner)").toBe(true);

    expect(parsed).toEqual(CLAIM_OWNER_BY_SECTION);
    // Every section NOT in the owner map must be absent from the parsed
    // CASE (falls through to the null else), so the two can never drift by
    // one of them adding a section the other doesn't know about.
    for (const section of ALL_SECTIONS as readonly ServiceSection[]) {
      if (!(section in CLAIM_OWNER_BY_SECTION)) {
        expect(parsed[section], `unexpected owner case for ${section}`).toBeUndefined();
      }
    }
  });

  it("(b) the trigger scopes the holder's role through lab_sections_for_role", () => {
    expect(fnBody("test_requests_claim_holder_guard")).toContain(
      "public.lab_sections_for_role(v_role)",
    );
  });

  it("(c) the holder's role is looked up via the 0182 effective-role CASE", () => {
    const body = fnBody("test_requests_claim_holder_guard");
    expect(body).toContain("sp.role = 'admin' and sp.view_as_until > now()");
    expect(body).toContain("then sp.view_as_role else sp.role end");
    // Looked up against the ASSIGNED holder, not the caller.
    expect(body).toContain("sp.id = new.assigned_to");
    expect(body).toContain("sp.deleted_at is null");
  });

  it("(d) both functions are security definer with a pinned search_path and closed ACLs", () => {
    for (const name of ["test_requests_claim_holder_guard", "view_as_end_for"]) {
      const body = fnBody(name);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = public");
    }
    for (const sig of [
      "public.test_requests_claim_holder_guard()",
      "public.view_as_end_for(uuid, uuid, inet, text)",
    ]) {
      expect(sql).toContain(`revoke execute on function ${sig} from public, anon, authenticated;`);
      expect(sql).toContain(`grant  execute on function ${sig} to service_role;`);
    }
  });

  it("(e) the guard raises P0075, view_as_end_for raises P0076", () => {
    expect(fnBody("test_requests_claim_holder_guard")).toContain("errcode = 'P0075'");
    expect(fnBody("view_as_end_for")).toContain("errcode = 'P0076'");
  });

  it("the trigger fires on INSERT and UPDATE OF assigned_to, and skips a null or unchanged holder", () => {
    expect(sql).toMatch(
      /create trigger test_requests_claim_holder_guard\s+before insert or update of assigned_to on public\.test_requests/,
    );
    const body = fnBody("test_requests_claim_holder_guard");
    expect(body).toContain("if new.assigned_to is null then");
    expect(body).toContain("new.assigned_to is not distinct from old.assigned_to");
  });
});
