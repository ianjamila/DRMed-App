// Reads migration SQL without a database. From 0150 onward, policy helpers must
// be scalar subqueries so Postgres can evaluate them once instead of per row.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "../../../supabase/migrations");
const HELPERS = ["has_role", "current_patient_id", "is_staff", "staff_role"];

function barePolicyCalls(sql: string): string[] {
  const offenders: string[] = [];
  const statements = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .split(";")
    .filter((s) => /create\s+policy/i.test(s));

  for (const stmt of statements) {
    // Migration sources use public-qualified helpers too, unlike pg_policies.
    const calls = new RegExp(
      `(^|[^.\\w])((?:public\\.)?(?:${HELPERS.join("|")})|auth\\.(?:uid|jwt|role))\\s*\\(`,
      "gi",
    );
    let m: RegExpExecArray | null;
    while ((m = calls.exec(stmt)) !== null) {
      const before = stmt.slice(0, m.index + m[1].length);
      if (!/\(\s*select\s+$/i.test(before)) {
        const name = /create\s+policy\s+"([^"]+)"/i.exec(stmt)?.[1] ?? "?";
        offenders.push(`policy "${name}" calls ${m[2]}() unwrapped`);
      }
    }
  }
  return offenders;
}

describe("RLS policies evaluate helpers once per query", () => {
  it("has no bare helper call in any create policy statement from 0150 onward", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      // Historical migrations remain unchanged; 0150 supersedes their policies.
      const n = Number(file.slice(0, 4));
      if (!Number.isFinite(n) || n < 150) continue;
      const sql = readFileSync(join(MIGRATIONS, file), "utf8");
      offenders.push(...barePolicyCalls(sql).map((o) => `${file}: ${o}`));
    }
    expect(offenders, "Wrap helper calls as (select fn(...)). See 0150.").toEqual([]);
  });

  // The plan's negative control, without writing a scratch policy to a migration.
  it.each([...HELPERS, ...HELPERS.map((h) => `public.${h}`), "auth.uid", "auth.jwt", "auth.role"])(
    "detects a bare %s call and accepts its wrapped form",
    (helper) => {
      const args = helper.endsWith("has_role") ? "array['admin']" : "";
      const call = `${helper}(${args})`;
      const policy = (expr: string) =>
        `create policy "scratch: bad" on public.services for select to authenticated using (${expr});`;
      expect(barePolicyCalls(policy(call))).toEqual([
        `policy "scratch: bad" calls ${helper}() unwrapped`,
      ]);
      expect(barePolicyCalls(policy(`( SeLeCt\n            ${call})`))).toEqual([]);
    },
  );
});
