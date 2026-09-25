// src/lib/auth/view-as-switch.test.ts
// `npm test` has no database: the admin client is faked (captures the
// staff_profiles update) and the audit writer is captured.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({
  updates: [] as { table: string; values: Record<string, unknown>; filters: [string, unknown][] }[],
  updateError: null as { message: string } | null,
  audits: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        const rec = { table, values, filters: [] as [string, unknown][] };
        fx.updates.push(rec);
        const q = {
          eq: (col: string, val: unknown) => {
            rec.filters.push([col, val]);
            return q;
          },
          then: (resolve: (v: { error: { message: string } | null }) => void) =>
            resolve({ error: fx.updateError }),
        };
        return q;
      },
    }),
  }),
}));
vi.mock("@/lib/audit/log", () => ({
  audit: async (entry: Record<string, unknown>) => {
    fx.audits.push(entry);
  },
}));

const { startViewAs, exitViewAs } = await import("./view-as-switch");
import type { StaffSession } from "./require-staff";

const NOW = new Date("2026-09-25T04:00:00.000Z");
const ctx = { ip: "10.0.0.1", ua: "vitest", now: NOW };

function admin(view_as: StaffSession["view_as"] = null): StaffSession {
  return {
    user_id: "admin-1",
    email: "a@x.test",
    full_name: "Ada Admin",
    role: view_as?.role ?? "admin",
    actual_role: "admin",
    view_as,
  };
}

beforeEach(() => {
  fx.updates.length = 0;
  fx.audits.length = 0;
  fx.updateError = null;
});

describe("startViewAs", () => {
  it("refuses a non-admin actual_role even if role says admin", async () => {
    const s: StaffSession = { ...admin(), role: "admin", actual_role: "medtech" };
    const r = await startViewAs(s, "reception", ctx);
    expect(r.ok).toBe(false);
    expect(fx.updates).toHaveLength(0);
    expect(fx.audits).toHaveLength(0);
  });

  it("refuses an unknown role, including admin", async () => {
    expect((await startViewAs(admin(), "admin", ctx)).ok).toBe(false);
    expect((await startViewAs(admin(), "owner", ctx)).ok).toBe(false);
    expect((await startViewAs(admin(), null, ctx)).ok).toBe(false);
    expect(fx.updates).toHaveLength(0);
  });

  it("writes the override on the caller's own admin row with a 4h expiry and audits started", async () => {
    const r = await startViewAs(admin(), "reception", ctx);
    expect(r).toEqual({ ok: true });
    expect(fx.updates).toHaveLength(1);
    const u = fx.updates[0];
    expect(u.table).toBe("staff_profiles");
    expect(u.values).toEqual({
      view_as_role: "reception",
      view_as_until: "2026-09-25T08:00:00.000Z",
    });
    expect(u.filters).toEqual([["id", "admin-1"], ["role", "admin"]]);
    expect(fx.audits).toEqual([
      expect.objectContaining({
        actor_id: "admin-1",
        actor_type: "staff",
        action: "staff.view_as.started",
        metadata: { role: "reception", until: "2026-09-25T08:00:00.000Z" },
        ip_address: "10.0.0.1",
        user_agent: "vitest",
      }),
    ]);
  });

  it("switching from an active override audits ended(switched) then started", async () => {
    const s = admin({ role: "medtech", until: "2026-09-25T07:00:00.000Z" });
    await startViewAs(s, "xray_technician", ctx);
    expect(fx.audits.map((a) => a.action)).toEqual([
      "staff.view_as.ended",
      "staff.view_as.started",
    ]);
    expect(fx.audits[0].metadata).toEqual({ role: "medtech", reason: "switched" });
  });

  it("a failed update returns an error and audits nothing", async () => {
    fx.updateError = { message: "boom" };
    const r = await startViewAs(admin(), "reception", ctx);
    expect(r.ok).toBe(false);
    expect(fx.audits).toHaveLength(0);
  });
});

describe("exitViewAs", () => {
  it("refuses a non-admin actual_role", async () => {
    const s: StaffSession = { ...admin(), actual_role: "reception" };
    expect((await exitViewAs(s, ctx)).ok).toBe(false);
    expect(fx.updates).toHaveLength(0);
  });

  it("nulls both columns and audits ended(manual) when an override was active", async () => {
    const s = admin({ role: "reception", until: "2026-09-25T07:00:00.000Z" });
    expect(await exitViewAs(s, ctx)).toEqual({ ok: true });
    expect(fx.updates[0].values).toEqual({ view_as_role: null, view_as_until: null });
    expect(fx.updates[0].filters).toEqual([["id", "admin-1"], ["role", "admin"]]);
    expect(fx.audits).toEqual([
      expect.objectContaining({
        action: "staff.view_as.ended",
        metadata: { role: "reception", reason: "manual" },
      }),
    ]);
  });

  it("with no active override still clears (stale columns) but audits nothing", async () => {
    expect(await exitViewAs(admin(), ctx)).toEqual({ ok: true });
    expect(fx.updates).toHaveLength(1);
    expect(fx.audits).toHaveLength(0);
  });
});
