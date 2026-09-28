import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({
  start: { ok: true, role: "reception" } as { ok: boolean; role?: string | null; error?: string },
  exit: { ok: true, role: null } as { ok: boolean; role?: string | null; error?: string },
  redirected: null as string | null,
  revalidated: [] as unknown[][],
  reported: [] as Record<string, unknown>[],
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => fx.revalidated.push(a) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    fx.redirected = to;
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({
    user_id: "admin-1", email: "", full_name: "Ada", role: "admin", actual_role: "admin", view_as: null,
  }),
}));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: null, ua: null }) }));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (e: Record<string, unknown>) => { fx.reported.push(e); },
}));
vi.mock("@/lib/auth/view-as-switch", () => ({
  startViewAs: async () => fx.start,
  exitViewAs: async () => fx.exit,
}));

const { startViewAsAction, exitViewAsAction } = await import("./actions");

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  fx.redirected = null;
  fx.revalidated.length = 0;
  fx.reported.length = 0;
  fx.start = { ok: true, role: "reception" };
  fx.exit = { ok: true, role: null };
});

describe("startViewAsAction", () => {
  it("on success revalidates the layout and returns to an allowed page", async () => {
    await expect(
      startViewAsAction({ error: null }, form({ role: "reception", return_to: "/staff/patients" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(fx.revalidated).toEqual([["/staff", "layout"]]);
    expect(fx.redirected).toBe("/staff/patients");
  });
  it("falls back to /staff for a page the new role cannot reach", async () => {
    await expect(
      startViewAsAction({ error: null }, form({ role: "reception", return_to: "/staff/users" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(fx.redirected).toBe("/staff");
  });
  it("on failure returns the error, reports it, and does not redirect", async () => {
    fx.start = { ok: false, error: "Could not start viewing as another role." };
    const state = await startViewAsAction({ error: null }, form({ role: "reception" }));
    expect(state).toEqual({ error: "Could not start viewing as another role." });
    expect(fx.redirected).toBeNull();
    expect(fx.reported[0]).toMatchObject({ scope: "view-as.start" });
  });
});

describe("exitViewAsAction", () => {
  it("returns to the page as admin", async () => {
    await expect(
      exitViewAsAction({ error: null }, form({ return_to: "/staff/users?q=a" })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(fx.redirected).toBe("/staff/users?q=a");
  });
  it("on failure returns the error", async () => {
    fx.exit = { ok: false, error: "Could not exit the role view." };
    expect(await exitViewAsAction({ error: null }, form({}))).toEqual({ error: "Could not exit the role view." });
    expect(fx.redirected).toBeNull();
  });
});
