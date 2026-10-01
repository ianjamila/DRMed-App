// src/lib/patients/merge-migration.test.ts
// Reads migration 0196 as text, without a database (same approach as
// src/lib/auth/view-as-migration.test.ts). Pins what could drift silently:
// ownership/ACL of the two merge functions, the private role's attributes,
// the lock order, the moved-table order, the fill-field list, and that every
// raise carries a registered errcode. The behaviour itself is proven by
// supabase/tests/0196_patient_merge_atomic_smoke.sql and
// scripts/merge-concurrency-proof.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MERGE_FILL_FIELDS, MERGE_MOVED_TABLES } from "./merge-fields";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0196_patient_merge_atomic.sql"), "utf8");

function fnBody(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `${name} not defined`).toBeGreaterThan(-1);
  const bodyStart = sql.indexOf("as $$", start);
  const end = sql.indexOf("$$;", bodyStart + 5);
  return sql.slice(start, end);
}

const MERGE = fnBody("merge_patients_guarded");
const UNDO = fnBody("undo_patient_merge_guarded");

describe("0196_patient_merge_atomic.sql", () => {
  it("creates the private role NOLOGIN/NOINHERIT/NOBYPASSRLS and grants it only to postgres", () => {
    expect(sql).toContain("create role patient_merge_writer nologin noinherit nobypassrls");
    expect(sql).toContain("alter role patient_merge_writer nologin noinherit nobypassrls");
    expect(sql).toContain("grant patient_merge_writer to postgres with inherit true, set true");
    expect(sql).toContain("revoke patient_merge_writer from anon, authenticated, service_role, authenticator");
  });

  it.each([
    ["merge_patients_guarded", "uuid, uuid, uuid, jsonb"],
    ["undo_patient_merge_guarded", "uuid, uuid, jsonb"],
  ])("%s is SECURITY DEFINER, pinned search_path, owned by the writer, service_role-only", (name, sig) => {
    const body = fnBody(name);
    expect(body).toMatch(/security definer/);
    expect(body).toContain("set search_path = pg_catalog, public, pg_temp");
    expect(sql).toContain(`alter function public.${name}(${sig}) owner to patient_merge_writer`);
    expect(sql).toContain(`revoke all on function public.${name}(${sig}) from public, anon, authenticated`);
    expect(sql).toContain(`grant execute on function public.${name}(${sig}) to service_role`);
    expect(sql).not.toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to [^;]*(anon|authenticated)`));
  });

  it("wraps the ownership transfer in a transient CREATE grant", () => {
    const grant = sql.indexOf("grant create on schema public to patient_merge_writer");
    const revoke = sql.indexOf("revoke create on schema public from patient_merge_writer");
    const alter = sql.indexOf("alter function public.merge_patients_guarded");
    expect(grant).toBeGreaterThan(-1);
    expect(alter).toBeGreaterThan(grant);
    expect(revoke).toBeGreaterThan(alter);
  });

  it("grants the writer EXECUTE on exactly the helpers the functions call", () => {
    for (const fn of [
      "lifecycle_lock(uuid[], boolean)",
      "lifecycle_lock_results(uuid[], boolean)",
      "recompute_patient_consent_cache(uuid)",
    ]) {
      expect(sql).toContain(`grant execute on function public.${fn} to patient_merge_writer`);
    }
  });

  it.each([["merge", MERGE], ["undo", UNDO]])("%s locks membership → patient → row (all present)", (_n, body) => {
    const results = body.indexOf("public.lifecycle_lock_results(");
    const patients = body.indexOf("public.lifecycle_lock(");
    const rows = body.indexOf("for no key update");
    expect(results).toBeGreaterThan(0);
    expect(patients).toBeGreaterThan(results);
    expect(rows).toBeGreaterThan(patients);
  });

  it("merge moves the six tables in MERGE_MOVED_TABLES order", () => {
    const positions = MERGE_MOVED_TABLES.map((t) => MERGE.indexOf(`update public.${t} `));
    for (const p of positions) expect(p).toBeGreaterThan(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it.each([["merge", MERGE], ["undo", UNDO]])("%s fill list equals MERGE_FILL_FIELDS", (_n, body) => {
    const m = body.match(/k_fill constant text\[\] := array\[([^\]]+)\]/);
    expect(m, "k_fill missing").not.toBeNull();
    const fields = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(fields).toEqual([...MERGE_FILL_FIELDS]);
  });

  it("every raise in the migration carries an errcode (P0058/P0072/P0078/P0079/P0080) outside post-condition blocks", () => {
    const withoutAsserts = sql.replace(/do \$assert\$[\s\S]*?\$assert\$;/g, "");
    const raises = withoutAsserts.match(/raise exception[\s\S]*?;/g) ?? [];
    expect(raises.length).toBeGreaterThan(10);
    for (const r of raises) expect(r).toMatch(/errcode = 'P00(58|72|78|79|80)'/);
  });

  it("the consent trigger delegates to the fold helper (one copy of the rule)", () => {
    const sync = fnBody("sync_patient_consent_state");
    expect(sync).toContain("perform public.recompute_patient_consent_cache(new.patient_id)");
  });

  it("ships the rollback guard on patients.merged_into_id", () => {
    expect(sql).toContain("create trigger trg_patients_live_merge_guard");
    expect(sql).toMatch(/before update of merged_into_id on public\.patients/);
  });
});
