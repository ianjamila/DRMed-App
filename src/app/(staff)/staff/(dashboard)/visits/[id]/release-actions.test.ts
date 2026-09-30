import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "1.2.3.4", "user-agent": "ua" }),
}));
const fx = vi.hoisted(() => ({
  role: "admin" as string,
  db: null as unknown,
  revalidate: [] as Array<[string, string | undefined]>,
  audits: [] as Array<Record<string, unknown>>,
  notifyOne: [] as unknown[],
  notifyBulk: [] as Array<{ testRequestIds: string[] }>,
  alerts: [] as Array<[string, number]>,
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
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: null, ua: null }) }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({ deleteVisitAction: async () => ({ ok: true }) }));
vi.mock("@/lib/notifications/notify-released", () => ({
  notifyResultReleased: async (a: unknown) => void fx.notifyOne.push(a),
}));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({
  notifyResultsReleasedBulk: async (a: { testRequestIds: string[] }) => void fx.notifyBulk.push(a),
}));
vi.mock("@/lib/results/viewed-count", () => ({ countResultViews: async (id: string) => (id === "a" ? 3 : 0) }));
vi.mock("@/lib/notifications/release-staff-alert", () => ({
  scheduleReleaseStaffAlert: (v: string, n: number) => void fx.alerts.push([v, n]),
}));

import { RELEASE_REFUSAL } from "@/lib/queue/release-eligibility";
import { REPORT_REFUSAL } from "@/lib/queue/report-release-scope";
import { COULDNT_CONFIRM_RELEASE } from "@/lib/actions/visits/release-reports";
import { makeFakeReleaseDb, type FakeLink, type FakeTestRow } from "@/lib/actions/visits/fake-release-db";

const { releaseTestAction, releaseSelectedAction, releaseAllReadyComponentsAction, undoReleaseSelectedAction } = await import("./actions");

const NONE_READY = "None of the selected tests are ready to release.";

/**
 * The fake serves test_requests pre-reads and the 0198 RPCs. The visit page's
 * actions also read `visits` (deleted check) and use `.maybeSingle()`, so wrap
 * the fake: a live visit, and maybeSingle = first row of the fake's result.
 */
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
      const q = inner.from(table);
      q.maybeSingle = async () => {
        const r = (await (q as unknown as Promise<{ data: unknown[] | null; error: unknown }>)) as {
          data: unknown[] | null;
          error: unknown;
        };
        return { data: r.data?.[0] ?? null, error: r.error };
      };
      return q;
    },
  };
  return fake;
}
type Fake = ReturnType<typeof setup>;
const statusOf = (fake: Fake, id: string) => fake.rows.find((r) => r.id === id)!.status;
/** The release_visit_results calls the action made (the one write path). */
const writes = (fake: Fake) => fake.rpcCalls.filter((c) => c.name === "release_visit_results");
const report = (result: string, ...ids: string[]): FakeLink[] => ids.map((id) => ({ testRequestId: id, resultId: result }));
/** Run `fn` just before the release RPC plans — to change a row between the page's read and the write. */
function beforeRelease(fake: Fake, fn: () => void) {
  fake.hooks.beforeRpc = (name) => {
    if (name === "release_visit_results") fn();
  };
}
const REVALIDATED = [
  ["/staff/visits/v1", undefined],
  ["/(staff)/staff/(dashboard)/queue", "layout"],
  ["/staff", undefined],
];

/** report r1 = a,b; plain x; package h with c1 (plain) and c2 (on r2 with d, outside the package). */
function seed(over: Record<string, Partial<FakeTestRow>> = {}) {
  const rows: FakeTestRow[] = [
    { id: "a" },
    { id: "b" },
    { id: "x" },
    { id: "h", isPackageHeader: true },
    { id: "c1", parentId: "h" },
    { id: "c2", parentId: "h" },
    { id: "d" },
  ].map((r) => ({ ...r, ...(over[r.id] ?? {}) }));
  return setup(rows, [...report("r1", "a", "b"), ...report("r2", "c2", "d")]);
}

beforeEach(() => {
  fx.role = "admin";
  fx.revalidate.length = 0;
  fx.audits.length = 0;
  fx.notifyOne.length = 0;
  fx.notifyBulk.length = 0;
  fx.alerts.length = 0;
});

describe("releaseTestAction — whole-report rule", () => {
  it("1. releasing one member of a combined report releases the whole report and announces it once", async () => {
    const fake = seed();
    const res = await releaseTestAction("a", "v1", "email");
    expect(res).toEqual({ ok: true, changedCount: 1, alsoReleasedCount: 1, skipped: [], warnings: [] });
    expect([statusOf(fake, "a"), statusOf(fake, "b")]).toEqual(["released", "released"]);
    expect(fx.notifyBulk).toHaveLength(1);
    expect(fx.notifyBulk[0].testRequestIds.sort()).toEqual(["a", "b"]);
    expect(fx.notifyOne).toEqual([]);
    expect(fx.alerts).toEqual([["v1", 2]]);
    expect(fx.audits.every((a) => (a.metadata as { source: string }).source === "visit_page")).toBe(true);
  });

  it("2. refuses when a sibling is unfinished: nothing released, no notice, no alert", async () => {
    const fake = seed({ b: { status: "result_uploaded" } });
    expect(await releaseTestAction("a", "v1", "email")).toEqual({
      ok: false,
      error: REPORT_REFUSAL.notFinished(1),
    });
    expect(statusOf(fake, "a")).toBe("ready_for_release");
    expect(statusOf(fake, "b")).toBe("result_uploaded");
    expect(fx.notifyBulk).toEqual([]);
    expect(fx.notifyOne).toEqual([]);
    expect(fx.alerts).toEqual([]);
  });

  it("3. refuses when an unreleased sibling was deleted", async () => {
    const fake = seed({ b: { deleted: true } });
    expect(await releaseTestAction("a", "v1", "email")).toEqual({ ok: false, error: REPORT_REFUSAL.deletedMember });
    expect(statusOf(fake, "a")).toBe("ready_for_release");
  });

  it("4. a whole-call refusal (P0081) passes its message through; nothing is released or announced", async () => {
    const fake = seed();
    fake.failNextRpc("release_visit_results", { code: "P0081", message: "This visit was deleted from the queue. Restore it before releasing results." });
    expect(await releaseTestAction("a", "v1", "email")).toEqual({
      ok: false,
      error: "This visit was deleted from the queue. Restore it before releasing results.",
    });
    expect(statusOf(fake, "a")).toBe("ready_for_release");
    expect(fx.alerts).toEqual([]);
    expect(fx.audits).toEqual([]);
  });

  it("5. a plain test releases alone with the single patient notice", async () => {
    const fake = seed();
    const res = await releaseTestAction("x", "v1", "email");
    expect(res).toEqual({ ok: true, changedCount: 1, alsoReleasedCount: 0, skipped: [], warnings: [] });
    expect(statusOf(fake, "x")).toBe("released");
    expect(fx.notifyOne).toEqual([{ testRequestId: "x", visitId: "v1", releaseMedium: "email" }]);
    expect(fx.notifyBulk).toEqual([]);
    expect(fx.alerts).toEqual([["v1", 1]]);
    expect(fx.audits[0].metadata).toMatchObject({ source: "visit_page", bulk: false, selection: false });
  });

  it("keeps the not-ready and section messages", async () => {
    seed({ x: { status: "result_uploaded" } });
    expect(await releaseTestAction("x", "v1", "email")).toEqual({ ok: false, error: RELEASE_REFUSAL.notReady });
    seed({ x: { section: "xray" } });
    fx.role = "medtech";
    expect(await releaseTestAction("x", "v1", "email")).toEqual({ ok: false, error: RELEASE_REFUSAL.section });
  });

  it("11. a malformed RPC result is never announced and points the operator at the page", async () => {
    const fake = seed();
    fake.overrideNextRpc("release_visit_results", { released: "nope" });
    const res = await releaseTestAction("a", "v1", "email");
    expect(res).toEqual({ ok: false, error: COULDNT_CONFIRM_RELEASE });
    expect(fx.notifyBulk).toEqual([]);
    expect(fx.notifyOne).toEqual([]);
    expect(fx.alerts).toEqual([]);
    expect(fx.audits).toEqual([]);
  });

  it("12. a sibling goes stale between the page read and the write: the DB refuses the whole report, nothing goes out", async () => {
    const fake = seed();
    beforeRelease(fake, () => {
      fake.rows.find((r) => r.id === "b")!.status = "result_uploaded";
    });
    const res = await releaseTestAction("a", "v1", "email");
    expect(res).toEqual({ ok: false, error: REPORT_REFUSAL.notFinished(1) });
    expect([statusOf(fake, "a"), statusOf(fake, "b")]).toEqual(["ready_for_release", "result_uploaded"]);
    expect(fx.notifyBulk).toEqual([]);
    expect(fx.alerts).toEqual([]);
  });
});

describe("releaseSelectedAction — whole-report rule", () => {
  it("6. pulls in the rest of a selected report and counts it separately", async () => {
    const fake = seed();
    const res = await releaseSelectedAction("v1", ["a", "x"], "physical");
    // A physical hand-off sends no message, so notifiedCount is 0.
    expect(res).toEqual({
      ok: true,
      count: 2,
      alsoReleasedCount: 1,
      skipped: [],
      warnings: [],
      batchId: expect.any(String),
      notifiedCount: 0,
    });
    expect(["a", "b", "x"].map((id) => statusOf(fake, id))).toEqual(["released", "released", "released"]);
    expect(fx.notifyBulk).toHaveLength(1);
    expect(fx.notifyBulk[0].testRequestIds.sort()).toEqual(["a", "b", "x"]);
    expect(fx.alerts).toEqual([["v1", 3]]);
  });

  it("7. a refused report is skipped with its reason while the plain row still releases", async () => {
    const fake = seed({ b: { status: "result_uploaded" } });
    const res = await releaseSelectedAction("v1", ["a", "x"], "physical");
    expect(res).toEqual({
      ok: true,
      count: 1,
      alsoReleasedCount: 0,
      skipped: [{ id: "a", reason: REPORT_REFUSAL.notFinished(1) }],
      warnings: [],
      batchId: expect.any(String),
      notifiedCount: 0,
    });
    expect([statusOf(fake, "a"), statusOf(fake, "x")]).toEqual(["ready_for_release", "released"]);
    expect(fx.notifyOne).toHaveLength(1);
  });

  it("8. everything refused is an error carrying the first reason; no candidates keeps the generic message", async () => {
    seed({ b: { status: "result_uploaded" } });
    expect(await releaseSelectedAction("v1", ["a"], "physical")).toEqual({
      ok: false,
      error: REPORT_REFUSAL.notFinished(1),
    });
    seed({ x: { status: "result_uploaded" } });
    expect(await releaseSelectedAction("v1", ["x"], "physical")).toEqual({ ok: false, error: NONE_READY });
    expect(fx.notifyBulk).toEqual([]);
    expect(fx.alerts).toEqual([]);
  });

  it("skips ids that were not ready candidates, in request order", async () => {
    seed({ x: { status: "result_uploaded" } });
    const res = await releaseSelectedAction("v1", ["x", "a"], "physical");
    expect(res).toEqual({
      ok: true,
      count: 1,
      alsoReleasedCount: 1,
      skipped: [{ id: "x", reason: RELEASE_REFUSAL.notReady }],
      warnings: [],
      batchId: expect.any(String),
      notifiedCount: 0,
    });
  });

  it("12. the selected test goes stale before the write: skipped with the RPC's reason, the plain row still releases", async () => {
    const fake = seed();
    beforeRelease(fake, () => {
      fake.rows.find((r) => r.id === "x")!.status = "result_uploaded";
    });
    const res = await releaseSelectedAction("v1", ["a", "x"], "physical");
    expect(res).toEqual({
      ok: true,
      count: 1,
      alsoReleasedCount: 1,
      skipped: [{ id: "x", reason: "Released by someone else or changed just now." }],
      warnings: [],
      batchId: expect.any(String),
      notifiedCount: 0,
    });
    expect(statusOf(fake, "x")).toBe("result_uploaded");
  });
});

describe("releaseSelectedAction — Undo handle (bulk-select follow-ups)", () => {
  it("stamps ONE server-minted batch id and the exact released_at on every released row's audit row, report-mates included", async () => {
    const fake = seed();
    const res = await releaseSelectedAction("v1", ["a", "x"], "email");
    if (!res.ok) throw new Error(res.error);
    expect(res.batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.notifiedCount).toBe(3);
    const released = fx.audits.filter((e) => e.action === "test_request.released");
    // "b" was not selected: the whole-report rule pulled it in, and Undo must
    // see it as this batch's own row.
    expect(released.map((e) => e.resource_id).sort()).toEqual(["a", "b", "x"]);
    for (const e of released) {
      const meta = e.metadata as Record<string, unknown>;
      expect(meta.bulk_batch_id).toBe(res.batchId);
      expect(meta.visit_id).toBe("v1");
      // The exact value written to the row — what Undo predicates its revert on.
      expect(meta.released_at).toBe(fake.rows.find((r) => r.id === e.resource_id)!.releasedAt);
    }
    // The patient notice carries the batch id too, so its audit row is not
    // read as a later, unrelated change that blocks the Undo.
    expect(fx.notifyBulk).toHaveLength(1);
    expect((fx.notifyBulk[0] as { bulkBatchId?: string }).bulkBatchId).toBe(res.batchId);
  });

  it("counts nothing as notified on a physical hand-off or a sample visit", async () => {
    seed();
    const physical = await releaseSelectedAction("v1", ["x"], "physical");
    if (!physical.ok) throw new Error(physical.error);
    expect(physical.notifiedCount).toBe(0);

    seed();
    // A sample visit: notify-released skips the message (SAMPLE_SKIP_REASON).
    const wrapped = fx.db as { from: (t: string) => Record<string, unknown> };
    fx.db = {
      from(table: string) {
        const q = wrapped.from(table);
        if (table === "visits") q.maybeSingle = async () => ({ data: { deleted_at: null, is_sample: true }, error: null });
        return q;
      },
    };
    const sample = await releaseSelectedAction("v1", ["x"], "email");
    if (!sample.ok) throw new Error(sample.error);
    expect(sample.count).toBe(1);
    expect(sample.notifiedCount).toBe(0);
  });

  it("mints a fresh batch id per call", async () => {
    seed();
    const one = await releaseSelectedAction("v1", ["x"], "email");
    seed();
    const two = await releaseSelectedAction("v1", ["x"], "email");
    if (!one.ok || !two.ok) throw new Error("release failed");
    expect(one.batchId).not.toBe(two.batchId);
    expect((fx.notifyOne[0] as { bulkBatchId?: string }).bulkBatchId).toBe(one.batchId);
  });
});

describe("releaseAllReadyComponentsAction — whole-report rule", () => {
  it("9. releases the ready components plus the report member outside the package; the header is untouched", async () => {
    const fake = seed();
    const res = await releaseAllReadyComponentsAction("h", "v1", "physical");
    expect(res).toEqual({ ok: true, changedCount: 2, alsoReleasedCount: 1, skipped: [], warnings: [] });
    expect(["c1", "c2", "d"].map((id) => statusOf(fake, id))).toEqual(["released", "released", "released"]);
    expect(statusOf(fake, "h")).toBe("ready_for_release");
    // The page sends the ready components; d is pulled in by the database, not selected.
    expect(writes(fake)).toHaveLength(1);
    expect((writes(fake)[0].args.p_test_request_ids as string[]).slice().sort()).toEqual(["c1", "c2"]);
    expect(fx.audits.every((a) => (a.metadata as { package_header_id?: string }).package_header_id === "h")).toBe(true);
    expect(fx.alerts).toEqual([["v1", 3]]);
  });

  it("10. a component whose report is unfinished is skipped with the reason; the rest release", async () => {
    const fake = seed({ d: { status: "result_uploaded" } });
    const res = await releaseAllReadyComponentsAction("h", "v1", "physical");
    expect(res).toEqual({
      ok: true,
      changedCount: 1,
      alsoReleasedCount: 0,
      skipped: [{ id: "c2", reason: REPORT_REFUSAL.notFinished(1) }],
      warnings: [],
    });
    expect([statusOf(fake, "c1"), statusOf(fake, "c2")]).toEqual(["released", "ready_for_release"]);
  });

  it("12. every component refused is an error; a component going stale before the write is refused with its report", async () => {
    seed({ c1: { status: "result_uploaded" }, d: { status: "result_uploaded" } });
    expect(await releaseAllReadyComponentsAction("h", "v1", "physical")).toEqual({
      ok: false,
      error: REPORT_REFUSAL.notFinished(1),
    });
    const fake = seed({ c1: { status: "result_uploaded" } });
    beforeRelease(fake, () => {
      fake.rows.find((r) => r.id === "d")!.status = "result_uploaded";
    });
    expect(await releaseAllReadyComponentsAction("h", "v1", "physical")).toEqual({
      ok: false,
      error: REPORT_REFUSAL.notFinished(1),
    });
    expect(statusOf(fake, "c2")).toBe("ready_for_release");
  });

  it("13. changedCount is what the write released: a component already released is neither sent nor counted", async () => {
    const fake = seed();
    // Released by someone else before the click: never read as a candidate.
    fake.rows.push({ ...fake.rows[0], id: "c3", parentId: "h", status: "released" });
    const res = await releaseAllReadyComponentsAction("h", "v1", "physical");
    expect(res).toEqual({ ok: true, changedCount: 2, alsoReleasedCount: 1, skipped: [], warnings: [] });
    expect(writes(fake)[0].args.p_test_request_ids).not.toContain("c3");
  });

  it("keeps its guards: a non-header id and an empty package", async () => {
    seed();
    expect(await releaseAllReadyComponentsAction("x", "v1", "physical")).toEqual({
      ok: false,
      error: "Package not found on this visit.",
    });
    seed({ c1: { status: "result_uploaded" }, c2: { status: "result_uploaded" } });
    expect(await releaseAllReadyComponentsAction("h", "v1", "physical")).toEqual({
      ok: false,
      error: "No components are ready to release.",
    });
  });
});

describe("14. every action refreshes every surface", () => {
  it.each([
    ["releaseTestAction success", () => releaseTestAction("x", "v1", "email")],
    ["releaseTestAction refusal", () => releaseTestAction("a", "v1", "email"), { b: { status: "result_uploaded" } }],
    ["releaseTestAction not ready", () => releaseTestAction("nope", "v1", "email")],
    ["releaseSelectedAction success", () => releaseSelectedAction("v1", ["x"], "email")],
    ["releaseSelectedAction refusal", () => releaseSelectedAction("v1", ["a"], "email"), { b: { status: "result_uploaded" } }],
    ["releaseSelectedAction no candidates", () => releaseSelectedAction("v1", ["nope"], "email")],
    ["releaseAllReadyComponentsAction success", () => releaseAllReadyComponentsAction("h", "v1", "email")],
    [
      "releaseAllReadyComponentsAction refusal",
      () => releaseAllReadyComponentsAction("h", "v1", "email"),
      { c1: { status: "result_uploaded" }, d: { status: "result_uploaded" } },
    ],
    [
      "releaseAllReadyComponentsAction empty",
      () => releaseAllReadyComponentsAction("h", "v1", "email"),
      { c1: { status: "result_uploaded" }, c2: { status: "result_uploaded" } },
    ],
  ] as Array<[string, () => Promise<unknown>, Record<string, Partial<FakeTestRow>>?]>)(
    "%s",
    async (_n, run, over) => {
      seed(over);
      await run();
      expect(fx.revalidate).toEqual(REVALIDATED);
    },
  );
});

describe("undoReleaseSelectedAction — undo_visit_release", () => {
  const undoCalls = (fake: Fake) => fake.rpcCalls.filter((c) => c.name === "undo_visit_release");
  const releasedSeed = (over: Record<string, Partial<FakeTestRow>> = {}) =>
    seed({
      a: { status: "released", releasedAt: "2026-09-01T02:00:00.000Z", releaseMedium: "email" },
      b: { status: "released", releasedAt: "2026-09-02T02:00:00.000Z", releaseMedium: "viber" },
      x: { status: "released", releasedAt: "2026-09-03T02:00:00.000Z", releaseMedium: "physical" },
      ...over,
    });

  it("calls the RPC once with the visit, the selection and the acting staff id", async () => {
    const fake = releasedSeed();
    await undoReleaseSelectedAction("v1", ["x"], "  wrong patient ");
    expect(undoCalls(fake)).toEqual([
      { name: "undo_visit_release", args: { p_visit_id: "v1", p_test_request_ids: ["x"], p_actor: "u1" } },
    ]);
  });

  it("audits every undone row with the prior medium/time FROM THE RPC, the viewed-count snapshot and the report id; the report's other member is audited too", async () => {
    const fake = releasedSeed();
    const res = await undoReleaseSelectedAction("v1", ["a"], "wrong patient");
    expect(res).toEqual({ ok: true, count: 2 });
    expect([statusOf(fake, "a"), statusOf(fake, "b")]).toEqual(["ready_for_release", "ready_for_release"]);
    expect(fx.audits.map((e) => e.resource_id)).toEqual(["a", "b"]);
    expect(fx.audits[0]).toMatchObject({
      actor_id: "u1",
      actor_type: "staff",
      action: "test_request.release_undone",
      resource_type: "test_request",
      resource_id: "a",
      ip_address: "1.2.3.4",
      user_agent: "ua",
      metadata: {
        visit_id: "v1",
        reason: "wrong patient",
        prior_release_medium: "email",
        prior_released_at: "2026-09-01T02:00:00.000Z",
        viewed_count: 3,
        bulk: true,
        report_result_id: "r1",
      },
    });
    expect(fx.audits[1].metadata).toMatchObject({
      prior_release_medium: "viber",
      prior_released_at: "2026-09-02T02:00:00.000Z",
      viewed_count: 0,
      report_result_id: "r1",
    });
  });

  it("a plain row is undone alone with report_result_id null", async () => {
    releasedSeed();
    expect(await undoReleaseSelectedAction("v1", ["x"], "typo")).toEqual({ ok: true, count: 1 });
    expect(fx.audits).toHaveLength(1);
    expect(fx.audits[0].metadata).toMatchObject({ prior_release_medium: "physical", report_result_id: null });
  });

  it("a whole-request refusal (P0081) passes the database's message through; nothing is audited", async () => {
    const fake = releasedSeed();
    fake.failNextRpc("undo_visit_release", {
      code: "P0081",
      message: "This report has tests outside the sections you can act on, so it can't be undone from here — ask an admin.",
    });
    expect(await undoReleaseSelectedAction("v1", ["a"], "r")).toEqual({
      ok: false,
      error: "This report has tests outside the sections you can act on, so it can't be undone from here — ask an admin.",
    });
    expect(fx.audits).toEqual([]);
  });

  it("40001 is retried once and then succeeds", async () => {
    const fake = releasedSeed();
    fake.failNextRpc("undo_visit_release", { code: "40001", message: "changed" });
    expect(await undoReleaseSelectedAction("v1", ["x"], "r")).toEqual({ ok: true, count: 1 });
    expect(undoCalls(fake)).toHaveLength(2);
  });

  it("a payment/database error is translated and nothing is audited", async () => {
    const fake = releasedSeed();
    fake.failNextRpc("undo_visit_release", { code: "XX000", message: "boom" });
    expect(await undoReleaseSelectedAction("v1", ["x"], "r")).toEqual({ ok: false, error: "boom" });
    expect(fx.audits).toEqual([]);
  });

  it("an empty undo list reads as nothing to unrelease", async () => {
    const fake = releasedSeed();
    fake.overrideNextRpc("undo_visit_release", { undone: [] });
    expect(await undoReleaseSelectedAction("v1", ["x"], "r")).toEqual({
      ok: false,
      error: "None of the selected tests can be unreleased.",
    });
    expect(fx.audits).toEqual([]);
  });

  it("malformed data is never guessed at: reported, refused with the confirm message, no audit", async () => {
    const fake = releasedSeed();
    fake.overrideNextRpc("undo_visit_release", { undone: [{ id: 5 }] });
    const res = await undoReleaseSelectedAction("v1", ["x"], "r");
    expect(res).toEqual({ ok: false, error: "Couldn't confirm what was undone — check the visit page." });
    expect(fx.audits).toEqual([]);
  });

  it("checks the visit is not deleted BEFORE calling the RPC", async () => {
    const fake = releasedSeed();
    const inner = fx.db as { from: (t: string) => Record<string, unknown> };
    fx.db = {
      ...inner,
      from(table: string) {
        if (table === "visits") {
          const q: Record<string, unknown> = {};
          for (const m of ["select", "eq"]) q[m] = () => q;
          q.maybeSingle = async () => ({ data: { deleted_at: "2026-09-01T00:00:00Z" }, error: null });
          return q;
        }
        return inner.from(table);
      },
    };
    const res = await undoReleaseSelectedAction("v1", ["x"], "r");
    expect(res.ok).toBe(false);
    expect(undoCalls(fake)).toHaveLength(0);
  });
});
