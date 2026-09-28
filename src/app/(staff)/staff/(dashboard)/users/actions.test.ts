// Covers endViewAsForAction (spec addendum A3, "End now" on Active role
// views). The other actions in this file are exercised through the app; this
// file is new alongside the End-now feature, so it scopes to that action.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({
  end: { ok: true, ended: true } as { ok: boolean; ended?: boolean; error?: string },
  revalidated: [] as unknown[][],
  reported: [] as Record<string, unknown>[],
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => fx.revalidated.push(a) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`unexpected redirect to ${to}`);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Map<string, string>(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit/log", () => ({ audit: async () => {} }));
vi.mock("@/lib/auth/require-admin", () => ({
  requireAdminStaff: async () => ({
    user_id: "admin-1", email: "", full_name: "Ada", role: "admin", actual_role: "admin", view_as: null,
  }),
}));
vi.mock("@/lib/server/action-helpers", () => ({
  ipAndAgent: async () => ({ ip: null, ua: null }),
  firstIssue: (err: { issues: { message: string }[] }) => err.issues[0]?.message ?? "Please check the form.",
}));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (e: Record<string, unknown>) => { fx.reported.push(e); },
}));
vi.mock("@/lib/auth/view-as-switch", () => ({
  endViewAsFor: async () => fx.end,
}));

const { endViewAsForAction } = await import("./actions");

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  fx.end = { ok: true, ended: true };
  fx.revalidated.length = 0;
  fx.reported.length = 0;
});

describe("endViewAsForAction", () => {
  it("on success revalidates /staff/users and returns no error/notice", async () => {
    const state = await endViewAsForAction({ error: null, notice: null }, form({ target_id: "target-1" }));
    expect(state).toEqual({ error: null, notice: null });
    expect(fx.revalidated).toEqual([["/staff/users"]]);
  });

  it("on ended:false returns the already-ended notice without revalidating", async () => {
    fx.end = { ok: true, ended: false };
    const state = await endViewAsForAction({ error: null, notice: null }, form({ target_id: "target-1" }));
    expect(state).toEqual({ error: null, notice: "That role view had already ended." });
    expect(fx.revalidated).toHaveLength(0);
  });

  it("on failure returns and reports the error, and does not revalidate", async () => {
    fx.end = { ok: false, error: "Could not end that role view." };
    const state = await endViewAsForAction({ error: null, notice: null }, form({ target_id: "target-1" }));
    expect(state).toEqual({ error: "Could not end that role view.", notice: null });
    expect(fx.revalidated).toHaveLength(0);
    expect(fx.reported[0]).toMatchObject({ scope: "view-as.end-for" });
  });
});
