import { beforeEach, describe, expect, it, vi } from "vitest";

// deleteSampleVisitAction, waiveVisitBalanceAction and the mark-done actions
// used to refresh only the visit page. Each now refreshes every surface that
// shows a line's release state (visit page, queue layout, dashboard) — on every
// path, success and failure alike.

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({
  role: "admin" as string,
  revalidated: [] as unknown[][],
  visitRow: null as unknown,
  undoRpc: { data: null, error: null } as { data: unknown; error: unknown },
  waiveRpc: { data: null, error: null } as { data: unknown; error: unknown },
  updateResult: { data: null, error: null } as { data: unknown; error: unknown },
  candidate: null as unknown,
  deleteVisit: { ok: true } as { ok: boolean; error?: string },
  rpcCalls: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => fx.revalidated.push(a) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: "u1", role: fx.role, actual_role: fx.role, view_as: null }),
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: async () => ({ user_id: "u1", role: "admin" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string) => {
      fx.rpcCalls.push(name);
      return fx.undoRpc;
    },
    from(table: string) {
      const q: Record<string, unknown> = {};
      let updating = false;
      for (const m of ["select", "eq", "is", "in"]) q[m] = () => q;
      q.update = () => {
        updating = true;
        return q;
      };
      q.maybeSingle = async () => {
        if (table === "visits") return { data: fx.visitRow, error: null };
        return { data: fx.candidate, error: null };
      };
      q.then = (res: (v: unknown) => unknown) => res(updating ? fx.updateResult : { data: null, error: null });
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string) => {
      fx.rpcCalls.push(name);
      return fx.waiveRpc;
    },
  }),
}));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: async () => ({ ok: true }) }));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: null, ua: null }) }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));
vi.mock("@/lib/results/viewed-count", () => ({ countResultViews: async () => 0 }));
vi.mock("@/lib/notifications/notify-released", () => ({ notifyResultReleased: async () => {} }));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({ notifyResultsReleasedBulk: async () => {} }));
vi.mock("@/lib/notifications/release-staff-alert", () => ({ scheduleReleaseStaffAlert: () => {} }));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({ deleteVisitAction: async () => fx.deleteVisit }));

const { deleteSampleVisitAction, waiveVisitBalanceAction, markConsultationDoneAction, markProcedureDoneAction } =
  await import("./actions");

const ALL_SURFACES = [
  ["/staff/visits/v1"],
  ["/(staff)/staff/(dashboard)/queue", "layout"],
  ["/staff"],
];

const sampleVisit = (statuses: string[]) => ({
  id: "v1",
  payment_status: "unpaid",
  deleted_at: null,
  test_requests: statuses.map((status, i) => ({
    id: `t${i}`,
    status,
    is_package_header: false,
    deleted_at: null,
    hmo_claim_items: [],
  })),
});
const undone = { data: { undone: [{ id: "t0", prior_release_medium: null, prior_released_at: null, report_id: null }], skipped: [] }, error: null };

beforeEach(() => {
  fx.role = "admin";
  fx.revalidated.length = 0;
  fx.rpcCalls.length = 0;
  fx.audits.length = 0;
  fx.visitRow = sampleVisit(["released"]);
  fx.undoRpc = undone;
  fx.waiveRpc = { data: { waived_php: 100 }, error: null };
  fx.updateResult = { data: [{ id: "t1" }], error: null };
  fx.candidate = { id: "t1", services: { kind: "doctor_consultation", section: null, name: "Consult" } };
  fx.deleteVisit = { ok: true };
});

describe("deleteSampleVisitAction refreshes every surface", () => {
  it("undo fails: every surface, not just the visit page", async () => {
    fx.undoRpc = { data: null, error: { code: "XX000", message: "boom" } };
    const res = await deleteSampleVisitAction("v1", "sample");
    expect(res.ok).toBe(false);
    expect(fx.revalidated).toEqual(ALL_SURFACES);
  });

  it("delete fails after the undo: every surface", async () => {
    fx.deleteVisit = { ok: false, error: "nope" };
    const res = await deleteSampleVisitAction("v1", "sample");
    expect(res).toEqual({ ok: false, error: "1 result was unreleased, but the visit was not deleted: nope" });
    expect(fx.revalidated).toEqual(ALL_SURFACES);
  });

  it("success after unreleasing results: every surface (deleteVisitAction is mocked and refreshes nothing here)", async () => {
    const res = await deleteSampleVisitAction("v1", "sample");
    expect(res).toEqual({ ok: true, count: 1 });
    expect(fx.revalidated).toEqual(ALL_SURFACES);
  });

  it("success with nothing to unrelease: no extra refresh (deleteVisitAction owns it)", async () => {
    fx.visitRow = sampleVisit(["requested"]);
    const res = await deleteSampleVisitAction("v1", "sample");
    expect(res).toEqual({ ok: true, count: 0 });
    expect(fx.rpcCalls).toEqual([]);
    expect(fx.revalidated).toEqual([]);
  });
});

describe("waiveVisitBalanceAction refreshes every surface", () => {
  it("RPC error: every surface", async () => {
    fx.waiveRpc = { data: null, error: { code: "XX000", message: "boom" } };
    const res = await waiveVisitBalanceAction("v1", "charity");
    expect(res.ok).toBe(false);
    expect(fx.revalidated).toEqual(ALL_SURFACES);
  });

  it("success: every surface", async () => {
    expect(await waiveVisitBalanceAction("v1", "charity")).toEqual({ ok: true });
    expect(fx.audits).toHaveLength(1);
    expect(fx.revalidated).toEqual(ALL_SURFACES);
  });
});

describe("mark consultation / procedure done refreshes every surface", () => {
  it("consultation success: every surface", async () => {
    expect(await markConsultationDoneAction("t1", "v1")).toEqual({ ok: true });
    expect(fx.revalidated).toEqual(ALL_SURFACES);
  });

  it("procedure success: every surface", async () => {
    fx.candidate = { id: "t1", services: { kind: "doctor_procedure", section: null, name: "Proc" } };
    expect(await markProcedureDoneAction("t1", "v1")).toEqual({ ok: true });
    expect(fx.revalidated).toEqual(ALL_SURFACES);
  });

  it("0 rows matched (already completed): every surface, and no audit", async () => {
    fx.updateResult = { data: [], error: null };
    expect(await markConsultationDoneAction("t1", "v1")).toEqual({
      ok: false,
      error: "This consultation is no longer pending.",
    });
    expect(fx.audits).toEqual([]);
    expect(fx.revalidated).toEqual(ALL_SURFACES);
  });

  it("procedure, 0 rows matched: every surface", async () => {
    fx.candidate = { id: "t1", services: { kind: "doctor_procedure", section: null, name: "Proc" } };
    fx.updateResult = { data: [], error: null };
    expect(await markProcedureDoneAction("t1", "v1")).toEqual({
      ok: false,
      error: "This procedure is no longer pending.",
    });
    expect(fx.revalidated).toEqual(ALL_SURFACES);
  });
});
