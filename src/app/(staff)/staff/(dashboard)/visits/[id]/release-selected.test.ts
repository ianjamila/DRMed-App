import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({
  releaseResult: { ok: true, released: [] } as unknown,
  releaseCalls: [] as unknown[],
  notified: [] as unknown[][],
  revalidated: [] as unknown[][],
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => fx.revalidated.push(a) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: "u1", role: "admin", actual_role: "admin", view_as: null }),
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: async () => ({ user_id: "u1", role: "admin" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "in", "update"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: { deleted_at: null } });
    return { from: () => q };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: async () => ({ ok: true }) }));
vi.mock("@/lib/audit/log", () => ({ audit: async () => {} }));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: null, ua: null }) }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));
vi.mock("@/lib/notifications/notify-released", () => ({ notifyResultReleased: async () => {} }));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({ notifyResultsReleasedBulk: async () => {} }));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({ deleteVisitAction: async () => ({ ok: true }) }));
vi.mock("@/lib/actions/visits/release-rows", () => ({
  releaseRows: async (a: unknown) => {
    fx.releaseCalls.push(a);
    return fx.releaseResult;
  },
  notifyReleased: async (...a: unknown[]) => void fx.notified.push(a),
}));

const { releaseSelectedAction } = await import("./actions");

beforeEach(() => {
  fx.notified.length = 0;
  fx.releaseCalls.length = 0;
  fx.revalidated.length = 0;
});

describe("releaseSelectedAction (pin)", () => {
  it("notifies with the released rows and returns the count", async () => {
    const released = [{ id: "a", name: "FBS" }, { id: "b", name: "BUN" }];
    fx.releaseResult = { ok: true, released };
    const r = await releaseSelectedAction("v1", ["a", "b"], "email");
    expect(r).toEqual({ ok: true, count: 2 });
    expect(fx.releaseCalls).toHaveLength(1);
    expect(fx.releaseCalls[0]).toMatchObject({
      visitId: "v1",
      ids: ["a", "b"],
      medium: "email",
      session: { user_id: "u1", role: "admin" },
    });
    expect(fx.notified).toEqual([["v1", released, "email"]]);
    expect(fx.revalidated.length).toBeGreaterThan(0);
  });
  it("keeps the existing error when nothing was released, without notifying", async () => {
    fx.releaseResult = { ok: true, released: [] };
    const r = await releaseSelectedAction("v1", ["a"], "email");
    expect(r).toEqual({ ok: false, error: "None of the selected tests are ready to release." });
    expect(fx.notified).toEqual([]);
    expect(fx.revalidated.length).toBeGreaterThan(0);
  });
  it("passes a release error through", async () => {
    fx.releaseResult = { ok: false, error: "nope" };
    const r = await releaseSelectedAction("v1", ["a"], "email");
    expect(r).toEqual({ ok: false, error: "nope" });
    expect(fx.notified).toEqual([]);
  });
});
