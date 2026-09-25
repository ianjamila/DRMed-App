import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// v_patients_directory lists every patient. 0171 limits it to authenticated
// SELECT; this keeps any later migration from handing anon a privilege on it
// again, and keeps seed.sql's local mirror in step (the default privileges in
// seed.sql would otherwise re-grant ALL on `db reset`).
const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");
const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

const REVOKE = "revoke all on public.v_patients_directory from public, anon, authenticated;";
const GRANT = "grant select on public.v_patients_directory to authenticated;";

describe("v_patients_directory privileges", () => {
  it("0171 revokes everything, then grants authenticated SELECT only", () => {
    const sql = migrations.find((m) => m.f.startsWith("0171_"))?.sql ?? "";
    expect(sql).toContain(REVOKE);
    expect(sql.slice(sql.indexOf(REVOKE))).toContain(GRANT);
  });

  it("no migration grants anon anything on it", () => {
    const offenders = migrations
      .filter((m) => /grant\s+[^;]*\bon\s+(?:table\s+)?(?:public\.)?v_patients_directory\b[^;]*\bto\s+[^;]*\banon\b/i.test(m.sql))
      .map((m) => m.f);
    expect(offenders).toEqual([]);
  });

  it("seed.sql re-applies the restriction after its blanket grants", () => {
    const seed = readFileSync(join(process.cwd(), "supabase/seed.sql"), "utf8");
    expect(seed).toContain(REVOKE);
    expect(seed.slice(seed.lastIndexOf(REVOKE))).toContain(GRANT);
    expect(seed.lastIndexOf(REVOKE)).toBeGreaterThan(seed.indexOf("grant all on tables to anon"));
  });
});
