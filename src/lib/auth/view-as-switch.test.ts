// src/lib/auth/view-as-switch.test.ts
// `npm test` has no database: the admin client is faked and records rpc()
// calls; all state + audit writes now happen inside view_as_transition /
// view_as_expire (0187), so TS must not call audit() at all.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  result: { data: null as unknown, error: null as { code?: string; message: string } | null },
  audits: 0,
  reported: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      fx.calls.push({ fn, args });
      return fx.result;
    },
  }),
}));
vi.mock("@/lib/audit/log", () => ({ audit: async () => { fx.audits++; } }));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (e: Record<string, unknown>) => { fx.reported.push(e); },
}));

const { startViewAs, exitViewAs, expireStaleViewAs } = await import("./view-as-switch");
import type { StaffSession } from "./require-staff";

const ctx = { ip: "10.0.0.1", ua: "vitest" };

function session(actual: StaffSession["role"] = "admin"): StaffSession {
  return { user_id: "admin-1", email: "a@x.test", full_name: "Ada", role: actual, actual_role: actual, view_as: null };
}

beforeEach(() => {
  fx.calls.length = 0;
  fx.reported.length = 0;
  fx.audits = 0;
  fx.result = { data: null, error: null };
});

describe("startViewAs", () => {
  it("calls view_as_transition with the role, ip and ua and returns the new role", async () => {
    fx.result = { data: { role: "reception", until: "2026-09-28T08:00:00+00:00" }, error: null };
    const r = await startViewAs(session(), "reception", ctx);
    expect(r).toEqual({ ok: true, role: "reception" });
    expect(fx.calls).toEqual([
      { fn: "view_as_transition", args: { p_actor: "admin-1", p_role: "reception", p_ip: "10.0.0.1", p_ua: "vitest" } },
    ]);
    expect(fx.audits).toBe(0);
  });
  it("refuses a non-admin and an unknown role without touching the database", async () => {
    expect(await startViewAs(session("medtech"), "reception", ctx)).toMatchObject({ ok: false });
    expect(await startViewAs(session(), "admin", ctx)).toEqual({ ok: false, error: "Unknown role." });
    expect(fx.calls).toHaveLength(0);
  });
  it("maps P0074 to the not-admin message and anything else to the generic one", async () => {
    fx.result = { data: null, error: { code: "P0074", message: "x" } };
    expect(await startViewAs(session(), "reception", ctx)).toEqual({
      ok: false, error: "Only an admin can view the app as another role.",
    });
    fx.result = { data: null, error: { code: "08006", message: "down" } };
    expect(await startViewAs(session(), "reception", ctx)).toEqual({
      ok: false, error: "Could not start viewing as another role.",
    });
  });
  it("omits null ip/ua instead of sending null", async () => {
    fx.result = { data: { role: "medtech", until: "x" }, error: null };
    await startViewAs(session(), "medtech", { ip: null, ua: null });
    expect(fx.calls[0].args).toEqual({ p_actor: "admin-1", p_role: "medtech" });
  });
});

describe("exitViewAs", () => {
  it("calls view_as_transition with no role", async () => {
    fx.result = { data: { role: null, until: null }, error: null };
    expect(await exitViewAs(session(), ctx)).toEqual({ ok: true, role: null });
    expect(fx.calls).toEqual([
      { fn: "view_as_transition", args: { p_actor: "admin-1", p_ip: "10.0.0.1", p_ua: "vitest" } },
    ]);
  });
  it("uses the actual role, so an admin viewing as reception can exit", async () => {
    const s = { ...session(), role: "reception" as const, view_as: { role: "reception" as const, until: "x" } };
    fx.result = { data: { role: null, until: null }, error: null };
    expect(await exitViewAs(s, ctx)).toEqual({ ok: true, role: null });
  });
  it("returns the exit error on failure", async () => {
    fx.result = { data: null, error: { code: "XX000", message: "boom" } };
    expect(await exitViewAs(session(), ctx)).toEqual({ ok: false, error: "Could not exit the role view." });
  });
});

describe("expireStaleViewAs", () => {
  it("calls view_as_expire and never throws on error (reports instead)", async () => {
    await expireStaleViewAs("admin-1", ctx);
    expect(fx.calls).toEqual([{ fn: "view_as_expire", args: { p_actor: "admin-1", p_ip: "10.0.0.1", p_ua: "vitest" } }]);
    fx.result = { data: null, error: { message: "down" } };
    await expect(expireStaleViewAs("admin-1", ctx)).resolves.toBeUndefined();
    expect(fx.reported[0]).toMatchObject({ scope: "view-as.expire" });
  });
});
