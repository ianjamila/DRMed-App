import { beforeEach, describe, expect, it, vi } from "vitest";

// Behaviour of the 10-minute batch Undo (undoReleaseBatchAction) and the
// hand-picked undoReleaseSelectedAction over the fake release DB, whose
// undo_visit_release model mirrors migration 0198 (p_expected_released_at:
// a line is undone only while it still carries exactly that released_at; a
// combined report only when EVERY member does).

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "1.2.3.4", "user-agent": "ua" }),
}));
const fx = vi.hoisted(() => ({
  role: "admin" as string,
  db: null as unknown,
  revalidate: [] as Array<[string, string | undefined]>,
  audits: [] as Array<Record<string, unknown>>,
  reported: [] as Array<{ scope: string }>,
  loadArgs: [] as Array<Record<string, unknown>>,
  loaded: null as unknown,
}));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string, t?: string) => void fx.revalidate.push([p, t]),
}));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: "u1", role: fx.role, actual_role: fx.role, view_as: null }),
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: async () => ({ user_id: "u1", role: "admin" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fx.db }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: async () => ({ ok: true }) }));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/audit/bulk-batch", () => ({
  loadOwnBatchRows: async (a: Record<string, unknown>) => {
    fx.loadArgs.push(a);
    return fx.loaded;
  },
}));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: null, ua: null }) }));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (a: { scope: string }) => void fx.reported.push(a),
}));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({ deleteVisitAction: async () => ({ ok: true }) }));
vi.mock("@/lib/notifications/notify-released", () => ({ notifyResultReleased: async () => {} }));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({ notifyResultsReleasedBulk: async () => {} }));
vi.mock("@/lib/results/viewed-count", () => ({ countResultViews: async (id: string) => (id === "a" ? 3 : 0) }));
vi.mock("@/lib/notifications/release-staff-alert", () => ({ scheduleReleaseStaffAlert: () => {} }));

import { BULK_UNDO_VIA, CHANGED_SINCE_REASON, UNDO_ALREADY, UNDO_EXPIRED } from "@/lib/ui/bulk-undo";
import { FAKE_RELEASED_AT, makeFakeReleaseDb, type FakeLink, type FakeTestRow } from "@/lib/actions/visits/fake-release-db";

const { undoReleaseBatchAction, undoReleaseSelectedAction } = await import("./actions");

const BATCH = "11111111-1111-4111-8111-111111111111";
const REASON = "Undone within 10 minutes of release";
/** Another instant, e.g. a re-release by someone else inside the window. */
const OTHER_AT = "2026-09-30T07:05:00.654321+00:00";

/** Live visit v1 + fake test_requests/RPCs (the visit page's actions also read `visits`, via maybeSingle). */
function setup(rows: FakeTestRow[], links: FakeLink[] = []) {
  const fake = makeFakeReleaseDb({ rows, links, actorRole: () => fx.role });
  const inner = fake.client as { from: (t: string) => Record<string, unknown>; rpc: unknown };
  fx.db = {
    rpc: inner.rpc,
    from(table: string) {
      if (table === "visits") {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is"]) q[m] = () => q;
        q.maybeSingle = async () => ({ data: { deleted_at: null }, error: null });
        return q;
      }
      return inner.from(table);
    },
  };
  return fake;
}
type Fake = ReturnType<typeof setup>;

const REL = { status: "released", releasedAt: FAKE_RELEASED_AT, releaseMedium: "email" } as const;
/** report r1 = a,b; report r2 = c,d; plain x, y, z — every line released by the batch unless overridden. */
function seed(over: Record<string, Partial<FakeTestRow>> = {}) {
  const rows: FakeTestRow[] = ["a", "b", "c", "d", "x", "y", "z"].map((id) => ({ id, ...REL, ...(over[id] ?? {}) }));
  return setup(rows, [
    { testRequestId: "a", resultId: "r1" },
    { testRequestId: "b", resultId: "r1" },
    { testRequestId: "c", resultId: "r2" },
    { testRequestId: "d", resultId: "r2" },
  ]);
}
const statusOf = (fake: Fake, id: string) => fake.rows.find((r) => r.id === id)!.status;
const undoCalls = (fake: Fake) => fake.rpcCalls.filter((c) => c.name === "undo_visit_release");

/** What loadOwnBatchRows returns: one test_request.released audit row per id (released_at from `at`, or omitted). */
function loadBatch(ids: string[], opts: { changedSince?: string[]; at?: Record<string, string | null>; alreadyUndone?: boolean } = {}) {
  fx.loaded = {
    ok: true,
    alreadyUndone: opts.alreadyUndone ?? false,
    changedSince: new Set(opts.changedSince ?? []),
    rows: ids.map((id) => {
      const at = opts.at && id in opts.at ? opts.at[id] : FAKE_RELEASED_AT;
      return {
        action: "test_request.released",
        resource_id: id,
        metadata: { visit_id: "v1", ...(at === null ? {} : { released_at: at }) },
      };
    }),
  };
}
const undoAudits = () => fx.audits.filter((a) => a.action === "test_request.release_undone");

beforeEach(() => {
  fx.role = "admin";
  fx.revalidate.length = 0;
  fx.audits.length = 0;
  fx.reported.length = 0;
  fx.loadArgs.length = 0;
  fx.loaded = null;
});

describe("undoReleaseBatchAction — reports", () => {
  it("a whole report this batch released comes back whole, and nothing is left unrestored", async () => {
    const fake = seed();
    loadBatch(["a", "b", "x"]);
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    expect(res).toEqual({ ok: true, restoredIds: ["a", "b", "x"], notRestored: [] });
    expect(["a", "b", "x"].map((id) => statusOf(fake, id))).toEqual(["ready_for_release", "ready_for_release", "ready_for_release"]);
    // Lines of other reports/batches are untouched.
    expect(["c", "d", "y", "z"].every((id) => statusOf(fake, id) === "released")).toBe(true);
    expect(fx.loadArgs).toEqual([
      { actorId: "u1", batchId: BATCH, resourceType: "test_request", nowMs: expect.any(Number) },
    ]);
  });

  it("a report with one member changed since stays wholly released, and every batch id of it is named", async () => {
    const fake = seed();
    loadBatch(["a", "b", "x"], { changedSince: ["b"] });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual(["x"]);
    expect(res.notRestored.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(res.notRestored.every((n) => n.reason === CHANGED_SINCE_REASON)).toBe(true);
    expect([statusOf(fake, "a"), statusOf(fake, "b")]).toEqual(["released", "released"]);
    expect(statusOf(fake, "x")).toBe("ready_for_release");
    expect(undoAudits().map((a) => a.resource_id)).toEqual(["x"]);
  });

  it("a report-mate this batch did NOT release keeps the report released and is not named", async () => {
    const fake = seed();
    // b is in a's report but released separately: no audit row in this batch.
    loadBatch(["a", "x"]);
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual(["x"]);
    expect(res.notRestored).toEqual([{ id: "a", reason: CHANGED_SINCE_REASON }]);
    expect(res.notRestored.some((n) => n.id === "b")).toBe(false);
    expect([statusOf(fake, "a"), statusOf(fake, "b")]).toEqual(["released", "released"]);
  });

  it("a report-mate re-released by someone else (different released_at) keeps the whole report released", async () => {
    const fake = seed({ b: { releasedAt: OTHER_AT } });
    loadBatch(["a", "b"]);
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual([]);
    expect(res.notRestored.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect([statusOf(fake, "a"), statusOf(fake, "b")]).toEqual(["released", "released"]);
    expect(fake.rows.find((r) => r.id === "b")!.releasedAt).toBe(OTHER_AT);
    expect(undoAudits()).toEqual([]);
  });
});

describe("undoReleaseBatchAction — plain lines", () => {
  it("a line re-released by someone else (different released_at) is not restored and is named; the rest comes back", async () => {
    const fake = seed({ x: { releasedAt: OTHER_AT } });
    loadBatch(["x", "y"]);
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    expect(res).toEqual({ ok: true, restoredIds: ["y"], notRestored: [{ id: "x", reason: CHANGED_SINCE_REASON }] });
    expect([statusOf(fake, "x"), statusOf(fake, "y")]).toEqual(["released", "ready_for_release"]);
    expect(fake.rows.find((r) => r.id === "x")!.releasedAt).toBe(OTHER_AT);
  });

  it("a batch row whose audit lacks released_at is sent but not in the map: not restored, named", async () => {
    const fake = seed();
    loadBatch(["x", "y"], { at: { x: null } });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    expect(res).toEqual({ ok: true, restoredIds: ["y"], notRestored: [{ id: "x", reason: CHANGED_SINCE_REASON }] });
    expect(statusOf(fake, "x")).toBe("released");
    const [call] = undoCalls(fake);
    expect(call.args.p_test_request_ids).toEqual(expect.arrayContaining(["x", "y"]));
    expect(call.args.p_expected_released_at).toEqual({ y: FAKE_RELEASED_AT });
  });

  it("sends the map without changedSince ids and with the full-precision strings untouched", async () => {
    const A_AT = "2026-09-30T07:00:00.123456+00:00";
    const Y_AT = "2026-09-30T07:00:00.654321+00:00";
    const fake = seed({ x: { releasedAt: A_AT }, y: { releasedAt: Y_AT }, z: { releasedAt: A_AT } });
    loadBatch(["x", "y", "z"], { changedSince: ["z"], at: { x: A_AT, y: Y_AT, z: A_AT } });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    const calls = undoCalls(fake);
    expect(calls).toHaveLength(1);
    // Exactly the audit strings (microseconds intact), no z, ALL candidate ids.
    expect(calls[0].args.p_expected_released_at).toStrictEqual({ x: A_AT, y: Y_AT });
    expect(calls[0].args.p_test_request_ids).toEqual(["x", "y"]);
    expect(calls[0].args.p_visit_id).toBe("v1");
    expect(calls[0].args.p_actor).toBe("u1");
    // Restored because the strings matched exactly; z (changedSince) is named and stays released.
    expect(res.restoredIds.sort()).toEqual(["x", "y"]);
    expect(res.notRestored).toEqual([{ id: "z", reason: CHANGED_SINCE_REASON }]);
    expect(statusOf(fake, "z")).toBe("released");
  });

  it("a microsecond difference alone blocks the restore (the strings are compared exactly)", async () => {
    const fake = seed({ x: { releasedAt: "2026-09-30T07:00:00.123457+00:00" } });
    loadBatch(["x"], { at: { x: "2026-09-30T07:00:00.123456+00:00" } });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    expect(res).toEqual({ ok: true, restoredIds: [], notRestored: [{ id: "x", reason: CHANGED_SINCE_REASON }] });
    expect(statusOf(fake, "x")).toBe("released");
  });
});

describe("undoReleaseBatchAction — audit and outcome", () => {
  it("every undo audit row carries via, undo_of_batch, a NEW bulk_batch_id, the reason, the RPC's prior values and the report id", async () => {
    seed({ a: { releaseMedium: "viber" } });
    loadBatch(["a", "b", "x"]);
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    const audits = undoAudits();
    expect(audits.map((a) => a.resource_id)).toEqual(["a", "b", "x"]);
    const newBatchIds = new Set<string>();
    for (const a of audits) {
      expect(a).toMatchObject({ actor_id: "u1", actor_type: "staff", resource_type: "test_request", ip_address: "1.2.3.4", user_agent: "ua" });
      const m = a.metadata as Record<string, unknown>;
      expect(m).toMatchObject({ visit_id: "v1", reason: REASON, bulk: true, via: BULK_UNDO_VIA, undo_of_batch: BATCH, prior_released_at: FAKE_RELEASED_AT });
      expect(m.bulk_batch_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(m.bulk_batch_id).not.toBe(BATCH);
      newBatchIds.add(m.bulk_batch_id as string);
    }
    expect(newBatchIds.size).toBe(1);
    expect(audits[0].metadata).toMatchObject({ prior_release_medium: "viber", viewed_count: 3, report_result_id: "r1" });
    expect(audits[1].metadata).toMatchObject({ report_result_id: "r1", viewed_count: 0 });
    expect(audits[2].metadata).toMatchObject({ report_result_id: null });
    expect(fx.revalidate.length).toBeGreaterThan(0);
  });

  it("every candidate refused restores nothing but is NOT an error: ok with all ids named", async () => {
    seed({ a: { releasedAt: OTHER_AT } });
    loadBatch(["a", "b"]);
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual([]);
    expect(res.notRestored.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(fx.reported).toEqual([]);
  });

  it("when every batch id is changed since, no RPC is made and all are named", async () => {
    const fake = seed();
    loadBatch(["x", "y"], { changedSince: ["x", "y"] });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    expect(res).toEqual({
      ok: true,
      restoredIds: [],
      notRestored: [{ id: "x", reason: CHANGED_SINCE_REASON }, { id: "y", reason: CHANGED_SINCE_REASON }],
    });
    expect(undoCalls(fake)).toHaveLength(0);
  });

  it("a batch already undone, an unreadable batch and a malformed batch id all refuse before any write", async () => {
    const fake = seed();
    loadBatch(["x"], { alreadyUndone: true });
    expect(await undoReleaseBatchAction({ batchId: BATCH })).toEqual({ ok: false, error: UNDO_ALREADY });
    fx.loaded = { ok: false, error: "nope" };
    expect(await undoReleaseBatchAction({ batchId: BATCH })).toEqual({ ok: false, error: "nope" });
    expect(await undoReleaseBatchAction({ batchId: "not-a-uuid" })).toEqual({ ok: false, error: UNDO_EXPIRED });
    expect(undoCalls(fake)).toHaveLength(0);
    expect(statusOf(fake, "x")).toBe("released");
  });

  it("a database refusal (P0081) is shown, nothing is audited", async () => {
    const fake = seed();
    loadBatch(["x"]);
    fake.failNextRpc("undo_visit_release", { code: "P0081", message: "Couldn't read which release to undo — try again." });
    expect(await undoReleaseBatchAction({ batchId: BATCH })).toEqual({
      ok: false,
      error: "Couldn't read which release to undo — try again.",
    });
    expect(undoAudits()).toEqual([]);
  });
});

describe("undoReleaseSelectedAction", () => {
  it("sends p_expected_released_at: null, so a line released at any instant is undone (no identity check)", async () => {
    const fake = seed({ x: { releasedAt: OTHER_AT } });
    const res = await undoReleaseSelectedAction("v1", ["x"], "wrong patient");
    expect(res).toEqual({ ok: true, count: 1 });
    const [call] = undoCalls(fake);
    expect(call.args).toHaveProperty("p_expected_released_at", null);
    expect(statusOf(fake, "x")).toBe("ready_for_release");
    expect(undoAudits()[0].metadata).toMatchObject({ reason: "wrong patient", bulk: true, prior_released_at: OTHER_AT });
    expect(undoAudits()[0].metadata).not.toHaveProperty("via");
  });

  it("with nothing to undo it is still an error (only a batch Undo may restore nothing)", async () => {
    seed({ x: { status: "ready_for_release", releasedAt: null, releaseMedium: null } });
    expect(await undoReleaseSelectedAction("v1", ["x"], "r")).toEqual({
      ok: false,
      error: "None of the selected tests can be unreleased.",
    });
  });
});
