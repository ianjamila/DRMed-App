import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Text-level pins on 0212 (no database in `npm test`; the behaviour is proved by
// supabase/tests/0212_release_notice_sweep_cron_smoke.sql). A reviewer deleting
// one of these lines is changing who can run the sweeper tick or when it fires.
const sql = readFileSync("supabase/migrations/0212_release_notice_sweep_cron.sql", "utf8");
const code = sql.replace(/--[^\n]*/g, "");

describe("0212 release_notice_sweep_cron", () => {
  it("the tick is SECURITY DEFINER with a pinned search_path, owned by postgres", () => {
    expect(code).toMatch(/function public\.release_notice_sweep_tick\(\)[\s\S]*?security definer[\s\S]*?set search_path = pg_catalog, public, pg_temp/);
    expect(code).toContain("alter function public.release_notice_sweep_tick() owner to postgres");
  });

  it("revokes EXECUTE from public, anon, authenticated AND service_role, granting postgres only", () => {
    expect(code).toContain("revoke all on function public.release_notice_sweep_tick() from public, anon, authenticated, service_role");
    expect(code).toContain("grant execute on function public.release_notice_sweep_tick() to postgres");
    expect(code).not.toMatch(/grant execute on function public\.release_notice_sweep_tick\(\)\s+to\s+(anon|authenticated|service_role|public)/);
  });

  it("does nothing unless the strict flag is on and BOTH vault secrets are present and non-blank", () => {
    expect(code).toContain("if not public.release_notices_enabled() then");
    expect(code).toContain("'release_notice_sweep_url'");
    expect(code).toContain("'release_notice_cron_secret'");
    expect(code).toMatch(/coalesce\(btrim\(v_url\), ''\) = '' or coalesce\(btrim\(v_secret\), ''\) = ''/);
    // the flag check comes before any secret is read
    expect(code.indexOf("release_notices_enabled()")).toBeLessThan(code.indexOf("vault.decrypted_secrets"));
    expect(code.indexOf("vault.decrypted_secrets")).toBeLessThan(code.indexOf("net.http_post"));
  });

  it("posts with a Bearer header", () => {
    expect(code).toContain("'Authorization', 'Bearer ' || btrim(v_secret)");
  });

  it("schedules release-notice-sweep every 5 minutes, unscheduling any existing job of that name first", () => {
    const un = code.indexOf("cron.unschedule(");
    const sc = code.indexOf("cron.schedule('release-notice-sweep', '*/5 * * * *', 'select public.release_notice_sweep_tick()')");
    expect(un).toBeGreaterThan(0);
    expect(sc).toBeGreaterThan(un);
  });

  it("creates pg_net in extensions and pg_cron in pg_catalog, only if missing", () => {
    expect(code).toContain("create extension if not exists pg_net with schema extensions");
    expect(code).toContain("create extension if not exists pg_cron with schema pg_catalog");
  });

  it("pins every ACL and the job in a post-condition", () => {
    expect(code).toMatch(/do \$\$[\s\S]*proacl[\s\S]*release-notice-sweep[\s\S]*\$\$;\s*$/);
  });
});
