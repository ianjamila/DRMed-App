// Reads migration 0172 as text, without a database — same reasoning as
// deletion.test.ts / rls-initplan.test.ts. Pins three things that could
// silently drift between the SQL and the TypeScript that mirrors it:
//
//   (a) lab_sections_for_role() must agree with SECTIONS_BY_ROLE
//       (src/lib/auth/role-sections.ts) for every staff role.
//   (b) the "finished" status list used to gate reads and edits must equal
//       EDITABLE_STATUSES (src/lib/results/result-edit.ts).
//   (c) the new RPCs and read helpers carry the ACLs the migration's own
//       comments claim: service_role-only writes, authenticated+service_role
//       reads, anon locked out of both.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EDITABLE_STATUSES } from "./result-edit";
import { SECTIONS_BY_ROLE } from "../auth/role-sections";
import type { StaffSession } from "../auth/require-staff";

const MIGRATION_PATH = join(
  process.cwd(),
  "supabase/migrations/0172_result_edit_commit.sql",
);
const sql = readFileSync(MIGRATION_PATH, "utf8");

// Every role StaffSession can carry — SECTIONS_BY_ROLE's key set.
const ALL_ROLES: StaffSession["role"][] = [
  "reception",
  "medtech",
  "pathologist",
  "admin",
  "xray_technician",
];

/**
 * Parse the `lab_sections_for_role` CASE body into role -> value, where
 * value is `null` (SQL NULL, unrestricted) or a sorted string array (SQL
 * `array[...]::text[]`, including the empty array from the `else` branch).
 */
function parseLabSectionsForRole(text: string): Record<string, string[] | null> {
  const start = text.indexOf("create or replace function public.lab_sections_for_role");
  const end = text.indexOf("create or replace function public.staff_can_read_finished_result");
  expect(start, "lab_sections_for_role function not found").toBeGreaterThan(-1);
  expect(end, "staff_can_read_finished_result function not found").toBeGreaterThan(-1);
  const body = text.slice(start, end);

  const caseStart = body.indexOf("select case p_role");
  const caseEnd = body.indexOf("end;", caseStart);
  const caseBody = body.slice(caseStart, caseEnd);

  const result: Record<string, string[] | null> = {};

  // when 'role' then null
  for (const m of caseBody.matchAll(/when\s+'(\w+)'\s+then\s+null\b/g)) {
    result[m[1]] = null;
  }
  // when 'role' then array[ 'a', 'b', ... ]::text[]
  for (const m of caseBody.matchAll(
    /when\s+'(\w+)'\s+then\s+array\[([\s\S]*?)\]::text\[\]/g,
  )) {
    const items = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    result[m[1]] = items;
  }
  // else array[]::text[]  (or else array[ ... ]::text[], not used here but
  // handled for completeness)
  const elseMatch = /else\s+array\[([\s\S]*?)\]::text\[\]/.exec(caseBody);
  if (elseMatch) {
    const items = [...elseMatch[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    result.__else__ = items;
  }

  return result;
}

describe("lab_sections_for_role parity with SECTIONS_BY_ROLE", () => {
  const parsed = parseLabSectionsForRole(sql);

  it("parsed at least one explicit role case and an else branch", () => {
    expect(Object.keys(parsed).length).toBeGreaterThan(1);
    expect(parsed.__else__).toBeDefined();
  });

  it.each(ALL_ROLES)("matches SECTIONS_BY_ROLE for role %s", (role) => {
    const expected = SECTIONS_BY_ROLE[role];
    const sqlValue = role in parsed ? parsed[role] : parsed.__else__;

    if (expected === null) {
      expect(sqlValue, `SQL should return NULL (unrestricted) for ${role}`).toBeNull();
    } else {
      expect(sqlValue, `SQL sections for ${role}`).toEqual([...expected].sort());
    }
  });

  it("admin and pathologist are unrestricted (NULL) in both", () => {
    expect(SECTIONS_BY_ROLE.admin).toBeNull();
    expect(SECTIONS_BY_ROLE.pathologist).toBeNull();
    expect(parsed.admin).toBeNull();
    expect(parsed.pathologist).toBeNull();
  });

  it("every OTHER role (reception included) is empty, never unrestricted", () => {
    for (const role of ALL_ROLES) {
      if (role === "admin" || role === "pathologist") continue;
      const expected = SECTIONS_BY_ROLE[role];
      expect(expected, `${role} must not be null (that would mean unrestricted)`).not.toBeNull();
    }
    // reception has no `when` case in the SQL, so it falls through to else.
    expect(parsed.__else__).toEqual([...(SECTIONS_BY_ROLE.reception ?? [])].sort());
  });
});

describe("finished-status list matches EDITABLE_STATUSES", () => {
  it("EDITABLE_STATUSES is the three post-bench statuses", () => {
    expect(EDITABLE_STATUSES).toEqual(["result_uploaded", "ready_for_release", "released"]);
  });

  it("every 'finished' status-list check in the migration equals EDITABLE_STATUSES", () => {
    // result_finalise_commit's own status check ('in_progress',
    // 'result_uploaded') is a DIFFERENT set — it gates the first finalise,
    // not editability of an already-finished result — so this only asserts
    // over occurrences that share EDITABLE_STATUSES' first status, which is
    // exactly the "finished" list (staff_can_read_finished_result and
    // result_edit_commit; see the next test for their locations).
    const quoted = EDITABLE_STATUSES.map((s) => `'${s}'`).join(", ");
    const literalList = `(${quoted})`;
    // Match only a status-in-parens list that OPENS with the finished list's
    // first status, not merely mentions it (result_finalise_commit's
    // ('in_progress', 'result_uploaded') mentions 'result_uploaded' too, but
    // it is a different, unrelated set — the pre-finalise gate).
    const occurrences = (
      sql.match(/tr\.status not in \([^)]*\)/g) ?? []
    ).filter((occ) => occ.startsWith(`tr.status not in ('${EDITABLE_STATUSES[0]}'`));
    expect(occurrences.length).toBeGreaterThan(0);
    for (const occ of occurrences) {
      expect(occ).toBe(`tr.status not in ${literalList}`);
    }
  });

  it("appears in both staff_can_read_finished_result and result_edit_commit", () => {
    const quoted = EDITABLE_STATUSES.map((s) => `'${s}'`).join(", ");
    const readFnStart = sql.indexOf("create or replace function public.staff_can_read_finished_result");
    const readFnEnd = sql.indexOf("create policy", readFnStart);
    const commitFnStart = sql.indexOf("create or replace function public.result_edit_commit");
    const commitFnEnd = sql.indexOf(
      "create or replace function public.result_finalise_commit",
      commitFnStart,
    );

    expect(sql.slice(readFnStart, readFnEnd)).toContain(`(${quoted})`);
    expect(sql.slice(commitFnStart, commitFnEnd)).toContain(`(${quoted})`);
  });
});

describe("function ACLs", () => {
  const writeRpcs = ["result_edit_commit", "result_finalise_commit", "result_save_draft"];
  const readFns = ["staff_can_read_finished_result", "lab_sections_for_role"];

  it.each(writeRpcs)("%s is revoked from public/anon/authenticated and granted to service_role only", (fn) => {
    const revokeRe = new RegExp(
      `revoke all on function public\\.${fn}\\([\\s\\S]*?\\) from public, anon, authenticated;`,
    );
    const grantRe = new RegExp(
      `grant execute on function public\\.${fn}\\([\\s\\S]*?\\) to service_role;`,
    );
    expect(sql, `${fn}: expected a revoke-all-from-public/anon/authenticated statement`).toMatch(revokeRe);
    expect(sql, `${fn}: expected a grant-to-service_role-only statement`).toMatch(grantRe);

    // Negative check: the grant statement must not also hand it to authenticated.
    const grantMatch = grantRe.exec(sql);
    expect(grantMatch, `${fn}: grant statement not found`).not.toBeNull();
    expect(grantMatch![0]).not.toMatch(/authenticated/);
  });

  it.each(readFns)("%s is granted to authenticated + service_role and revoked from anon", (fn) => {
    const revokeRe = new RegExp(
      `revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated;`,
    );
    const grantRe = new RegExp(
      `grant execute on function public\\.${fn}\\([^)]*\\) to authenticated, service_role;`,
    );
    expect(sql, `${fn}: expected a revoke-all statement covering anon`).toMatch(revokeRe);
    expect(sql, `${fn}: expected a grant to authenticated + service_role`).toMatch(grantRe);
  });
});
