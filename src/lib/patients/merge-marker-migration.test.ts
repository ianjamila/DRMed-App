// Reads migration 0197 as text. Pins: a SECURITY INVOKER guard keyed on
// current_user = 'patient_merge_writer'; the three legal transitions; the
// merged-row edit refusal; INSERT refusal; errcodes P0080/P0058 only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0197_merge_marker_enforcement.sql"), "utf8");

describe("0197_merge_marker_enforcement.sql", () => {
  it("installs an invoker guard on patients for insert and update", () => {
    expect(sql).toMatch(/create or replace function public\.enforce_merge_marker\(\)[\s\S]*security invoker/);
    expect(sql).toContain("create trigger trg_patients_merge_marker_guard");
    expect(sql).toMatch(/before insert or update on public\.patients/);
    expect(sql).toContain("current_user <> 'patient_merge_writer'");
  });
  it("every raise outside post-conditions carries P0080 or P0058", () => {
    const body = sql.replace(/do \$assert\$[\s\S]*?\$assert\$;/g, "");
    const raises = body.match(/raise exception[\s\S]*?;/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(6);
    for (const r of raises) expect(r).toMatch(/errcode = 'P00(80|58)'/);
  });
  it("exempts only the marker pair and bookkeeping columns (widening either weakens the guard)", () => {
    expect(sql).toContain("k_marker constant text[] := array['merged_into_id', 'merged_at', 'updated_at', 'row_version'];");
    expect(sql).toContain("k_bookkeeping constant text[] := array['updated_at', 'row_version'];");
  });
  it("revokes the guard function from runtime roles", () => {
    expect(sql).toContain("revoke all on function public.enforce_merge_marker() from public, anon, authenticated, service_role");
  });
  it("retires 0196's narrower live-v2 guard it supersedes", () => {
    expect(sql).toContain("drop trigger if exists trg_patients_live_merge_guard on public.patients");
    expect(sql).toContain("drop function if exists public.guard_live_merge_marker()");
    expect(sql).toContain("drop function if exists public.patient_has_live_v2_merge(uuid)");
  });
});
