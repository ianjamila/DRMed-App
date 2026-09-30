import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({
  revalidated: [] as unknown[][],
  // maybeSingle() results in call order: visit row, then the release candidate.
  reads: [] as Array<{ data: unknown }>,
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
    q.maybeSingle = async () => fx.reads.shift() ?? { data: null };
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

const { releaseTestAction } = await import("./actions");

beforeEach(() => {
  fx.revalidated.length = 0;
  fx.reads = [{ data: { deleted_at: null } }, { data: null }];
});

describe("release refreshes every surface", () => {
  it("names the visit page, the route-group-correct queue layout, and the dashboard", async () => {
    const r = await releaseTestAction("t1", "v1", "physical");
    expect(r).toEqual({ ok: false, error: "This result is no longer ready to release." });
    expect(fx.revalidated).toEqual([
      ["/staff/visits/v1"],
      ["/(staff)/staff/(dashboard)/queue", "layout"],
      ["/staff"],
    ]);
  });
});
