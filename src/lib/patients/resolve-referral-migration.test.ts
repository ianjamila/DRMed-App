import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// resolve_patient_guarded is the only way the public website forms create a
// patient. 0157 taught it to save "How did you hear about us?". These pins
// keep a later re-creation from silently dropping that — or from widening
// what an anonymous form may write.

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function definitions(): { file: string; body: string }[] {
  const out: { file: string; body: string }[] = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const m = sql.match(
      /create or replace function public\.resolve_patient_guarded\([\s\S]*?\n\$\$;/i,
    );
    if (m) out.push({ file, body: m[0] });
  }
  return out;
}

const all = definitions();
const latest = all[all.length - 1]!;
const latestFile = readFileSync(join(MIGRATIONS, latest.file), "utf8");

describe("resolve_patient_guarded (latest definition)", () => {
  it("is found, and 0157 is not older than the latest", () => {
    expect(all.map((d) => d.file)).toContain("0157_resolve_patient_referral_source.sql");
    expect(latest.file >= "0157").toBe(true);
  });

  it("inserts referral_source on a NEW patient", () => {
    const insert = latest.body.match(/insert into public\.patients \(([\s\S]*?)\)\s*values/i);
    expect(insert?.[1]).toMatch(/\breferral_source\b/);
  });

  it("takes the value only through the referral_sources lookup (unknown id → NULL, never an FK error)", () => {
    expect(latest.body).toMatch(
      /select rs\.id from public\.referral_sources rs where rs\.id = nullif\(p_fields->>'referral_source',''\)/,
    );
  });

  it("never writes onto a MATCHED patient", () => {
    expect(latest.body).not.toMatch(/\bupdate\s+public\.patients\b/i);
    // The matched branch still returns before any insert.
    expect(latest.body).toMatch(/if found then\s+return query select v\.id, v\.drm_id, true;\s+return;/);
  });

  it("keeps the dedup advisory lock", () => {
    expect(latest.body).toMatch(/pg_advisory_xact_lock\(\s*hashtext\('patient_resolve:'/);
  });

  it("restates the service_role-only ACL in the same file", () => {
    const sig = "public\\.resolve_patient_guarded\\(text, text, date, jsonb\\)";
    expect(latestFile).toMatch(new RegExp(`revoke all on function ${sig} from public;`));
    expect(latestFile).toMatch(new RegExp(`revoke execute on function ${sig} from anon, authenticated;`));
    expect(latestFile).toMatch(new RegExp(`grant execute on function ${sig} to service_role;`));
    expect(latestFile).not.toMatch(new RegExp(`grant execute on function ${sig} to (anon|authenticated)`));
  });
});
