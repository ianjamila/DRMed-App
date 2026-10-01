import { beforeEach, describe, expect, it, vi } from "vitest";

// The Queue's "Delete sample visit…" row action and its bulk twin share
// deleteSampleVisitAction's core. Pins: admin-only on the EFFECTIVE role (View
// as), is_sample re-proved server-side, the audit `source` marker, distinct
// visits, and a per-visit skip reason for every refusal.

vi.mock("server-only", () => ({}));
type Visit = { id: string; payment_status: string; deleted_at: string | null; is_sample: boolean; test_requests: unknown[] };
const fx = vi.hoisted(() => ({
  role: "admin" as string,
  actualRole: "admin" as string,
  visits: {} as Record<string, unknown>,
  undoCalls: [] as Array<Record<string, unknown>>,
  deleteCalls: [] as Array<[string, string, string | undefined]>,
  deleteResult: {} as Record<string, { ok: boolean; error?: string }>,
  revalidated: [] as unknown[][],
  dbReads: 0,
  patientActive: true,
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => fx.revalidated.push(a) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: "u1", role: fx.role, actual_role: fx.actualRole, view_as: null }),
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: async () => ({ user_id: "u1", role: "admin" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "undo_visit_release") fx.undoCalls.push(args);
      return {
        data: { undone: [{ id: "t0", prior_release_medium: null, prior_released_at: null, report_id: null }], skipped: [] },
        error: null,
      };
    },
    from() {
      let id = "";
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (_c: string, v: string) => {
        id = v;
        return q;
      };
      q.maybeSingle = async () => {
        fx.dbReads++;
        return { data: fx.visits[id] ?? null, error: null };
      };
      return q;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: async () =>
    fx.patientActive ? { ok: true } : { ok: false, error: "This patient record is inactive." } }));
vi.mock("@/lib/audit/log", () => ({ audit: async () => {} }));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: null, ua: null }) }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));
vi.mock("@/lib/results/viewed-count", () => ({ countResultViews: async () => 0 }));
vi.mock("@/lib/notifications/notify-released", () => ({ notifyResultReleased: async () => {} }));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({ notifyResultsReleasedBulk: async () => {} }));
vi.mock("@/lib/notifications/release-staff-alert", () => ({ scheduleReleaseStaffAlert: () => {} }));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({
  deleteVisitAction: async (id: string, reason: string, source?: string) => {
    fx.deleteCalls.push([id, reason, source]);
    return fx.deleteResult[id] ?? { ok: true };
  },
}));

const { MAX_BULK_SELECTION } = await import("@/lib/visits/bulk-selection");
const { deleteSampleVisitFromQueueAction, deleteSampleVisitsFromQueueAction, deleteSampleVisitAction } = await import(
  "./actions"
);

const visit = (id: string, over: Partial<Visit> = {}, statuses: string[] = ["released"]): Visit => ({
  id,
  payment_status: "unpaid",
  deleted_at: null,
  is_sample: true,
  test_requests: statuses.map((status, i) => ({
    id: `${id}-t${i}`,
    status,
    is_package_header: false,
    deleted_at: null,
    hmo_claim_items: [],
  })),
  ...over,
});

beforeEach(() => {
  fx.role = "admin";
  fx.actualRole = "admin";
  fx.visits = { v1: visit("v1"), v2: visit("v2") };
  fx.undoCalls.length = 0;
  fx.deleteCalls.length = 0;
  fx.deleteResult = {};
  fx.revalidated.length = 0;
  fx.dbReads = 0;
  fx.patientActive = true;
});

describe("deleteSampleVisitFromQueueAction", () => {
  it("un-releases then deletes a sample visit, tagging both audit paths with source: queue", async () => {
    const res = await deleteSampleVisitFromQueueAction("v1", "demo");
    expect(res).toEqual({ ok: true, count: 1 });
    const audit = (fx.undoCalls[0].p_audit as { metadata: Record<string, unknown> }).metadata;
    expect(audit).toMatchObject({ bulk: true, sample_visit_delete: true, source: "queue" });
    expect(fx.deleteCalls).toEqual([["v1", "Sample visit: demo", "queue"]]);
    expect(fx.revalidated).toContainEqual(["/staff/visits/v1"]);
    expect(fx.revalidated).toContainEqual(["/(staff)/staff/(dashboard)/queue", "layout"]);
  });

  it.each(["reception", "lab_tech", "pathologist"])("refuses %s before reading anything", async (role) => {
    fx.role = role;
    const res = await deleteSampleVisitFromQueueAction("v1", "demo");
    expect(res).toEqual({ ok: false, error: "Only an admin can delete a sample visit." });
    expect(fx.dbReads).toBe(0);
    expect(fx.deleteCalls).toEqual([]);
  });

  it("uses the EFFECTIVE role: an admin viewing as reception is refused", async () => {
    fx.role = "reception";
    fx.actualRole = "admin";
    const res = await deleteSampleVisitFromQueueAction("v1", "demo");
    expect(res.ok).toBe(false);
    expect(fx.deleteCalls).toEqual([]);
  });

  it("refuses a visit that is not a sample — nothing is un-released or deleted", async () => {
    fx.visits = { v1: visit("v1", { is_sample: false }) };
    const res = await deleteSampleVisitFromQueueAction("v1", "demo");
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/Not a sample visit/);
    expect(fx.undoCalls).toEqual([]);
    expect(fx.deleteCalls).toEqual([]);
  });

  it("requires a reason", async () => {
    const res = await deleteSampleVisitFromQueueAction("v1", "  ");
    expect(res.ok).toBe(false);
    expect(fx.deleteCalls).toEqual([]);
  });

  it("still applies the money blockers (a payment keeps the sample visit)", async () => {
    fx.visits = { v1: visit("v1", { payment_status: "paid" }) };
    const res = await deleteSampleVisitFromQueueAction("v1", "demo");
    expect(res.ok).toBe(false);
    expect(fx.undoCalls).toEqual([]);
  });
});

describe("an inactive patient's visit (0167)", () => {
  it.each([
    ["visit_page", () => deleteSampleVisitAction("v1", "demo")],
    ["queue", () => deleteSampleVisitFromQueueAction("v1", "demo")],
  ])("%s source is refused: nothing un-released, nothing deleted", async (_s, run) => {
    fx.patientActive = false;
    const res = await run();
    expect(res).toEqual({ ok: false, error: "This patient record is inactive." });
    expect(fx.undoCalls).toEqual([]);
    expect(fx.deleteCalls).toEqual([]);
  });

  it("bulk reports it as a skipped visit", async () => {
    fx.patientActive = false;
    const res = await deleteSampleVisitsFromQueueAction(["v1"], "demo");
    expect(res).toMatchObject({ ok: true, deletedVisitIds: [], skipped: [{ id: "v1", reason: "This patient record is inactive." }] });
    expect(fx.deleteCalls).toEqual([]);
  });
});

describe("the visit page action keeps its own flow", () => {
  it("still deletes a visit that is not flagged as a sample (the tick is its proof) and adds no source marker", async () => {
    fx.visits = { v1: visit("v1", { is_sample: false }) };
    const res = await deleteSampleVisitAction("v1", "demo");
    expect(res).toEqual({ ok: true, count: 1 });
    expect((fx.undoCalls[0].p_audit as { metadata: Record<string, unknown> }).metadata).not.toHaveProperty("source");
    expect(fx.deleteCalls).toEqual([["v1", "Sample visit: demo", undefined]]);
  });
});

describe("deleteSampleVisitsFromQueueAction", () => {
  it("dedupes visits: a repeated id is deleted once", async () => {
    const res = await deleteSampleVisitsFromQueueAction(["v1", "v1", "v2", "v1"], "demo");
    expect(res).toEqual({ ok: true, deletedVisitIds: ["v1", "v2"], skipped: [], unreleasedCount: 2 });
    expect(fx.deleteCalls.map((c) => c[0]).sort()).toEqual(["v1", "v2"]);
    expect(fx.deleteCalls.every((c) => c[2] === "queue_bulk")).toBe(true);
    expect(
      fx.undoCalls.every(
        (c) => (c.p_audit as { metadata: Record<string, unknown> }).metadata.source === "queue_bulk",
      ),
    ).toBe(true);
  });

  it("names each skipped visit with its own reason and still deletes the rest", async () => {
    fx.visits = {
      v1: visit("v1"),
      v2: visit("v2", { is_sample: false }),
      v3: visit("v3", { payment_status: "paid" }),
    };
    const res = await deleteSampleVisitsFromQueueAction(["v1", "v2", "v3", "gone"], "demo");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.deletedVisitIds).toEqual(["v1"]);
    const reasons = Object.fromEntries(res.skipped.map((s) => [s.id, s.reason]));
    expect(Object.keys(reasons).sort()).toEqual(["gone", "v2", "v3"]);
    expect(reasons.v2).toMatch(/Not a sample visit/);
    expect(reasons.gone).toBe("Visit not found.");
    expect(reasons.v3).not.toBe(reasons.v2);
    expect(fx.deleteCalls.map((c) => c[0])).toEqual(["v1"]);
  });

  it("a delete that fails after the un-release is a skip that says so", async () => {
    fx.deleteResult = { v2: { ok: false, error: "nope" } };
    const res = await deleteSampleVisitsFromQueueAction(["v1", "v2"], "demo");
    expect(res).toMatchObject({ ok: true, deletedVisitIds: ["v1"] });
    expect((res as { skipped: Array<{ reason: string }> }).skipped[0].reason).toBe(
      "1 result was unreleased, but the visit was not deleted: nope",
    );
  });

  it("refuses the whole call for a non-admin", async () => {
    fx.role = "reception";
    const res = await deleteSampleVisitsFromQueueAction(["v1"], "demo");
    expect(res).toEqual({ ok: false, error: "Only an admin can delete a sample visit." });
    expect(fx.dbReads).toBe(0);
  });

  it("refuses more than MAX_BULK_SELECTION distinct visits and deletes nothing", async () => {
    const ids = Array.from({ length: MAX_BULK_SELECTION + 1 }, (_, i) => `x${i}`);
    for (const id of ids) fx.visits[id] = visit(id);
    const res = await deleteSampleVisitsFromQueueAction(ids, "demo");
    expect(res.ok).toBe(false);
    expect(fx.deleteCalls).toEqual([]);
    expect(fx.undoCalls).toEqual([]);
    // Duplicates do not count toward the cap.
    const dup = await deleteSampleVisitsFromQueueAction(Array(MAX_BULK_SELECTION + 5).fill("v1"), "demo");
    expect(dup).toMatchObject({ ok: true, deletedVisitIds: ["v1"] });
  });

  it("refuses an empty selection and a missing reason", async () => {
    expect((await deleteSampleVisitsFromQueueAction([], "demo")).ok).toBe(false);
    expect((await deleteSampleVisitsFromQueueAction(["v1"], "")).ok).toBe(false);
    expect(fx.deleteCalls).toEqual([]);
  });
});
