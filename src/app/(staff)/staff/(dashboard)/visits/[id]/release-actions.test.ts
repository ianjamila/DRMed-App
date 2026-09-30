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
vi.mock("@/lib/notifications/release-staff-alert", () => ({
  scheduleReleaseStaffAlert: (v: string, n: number) => void fx.alerts.push([v, n]),
}));

import { RELEASE_REFUSAL } from "@/lib/queue/release-eligibility";
import { REPORT_REFUSAL } from "@/lib/queue/report-release-scope";
import { COULDNT_CHECK_REPORT, RACED_REASON, REPORT_CHANGED_REASON } from "@/lib/actions/visits/release-reports";
import { makeFakeReleaseDb, type FakeLink, type FakeTestRow } from "@/lib/actions/visits/fake-release-db";

const { releaseTestAction, releaseSelectedAction, releaseAllReadyComponentsAction } = await import("./actions");

const NONE_READY = "None of the selected tests are ready to release.";

/**
 * The fake speaks test_requests / result_test_requests only. The visit page's
 * actions also read `visits` (deleted check) and use `.maybeSingle()`, so wrap
 * the fake: a live visit, and maybeSingle = first row of the fake's result.
 */
function setup(rows: FakeTestRow[], links: FakeLink[] = []) {
  const fake = makeFakeReleaseDb({ rows, links });
  const inner = fake.client as { from: (t: string) => Record<string, unknown> };
  fx.db = {
    from(table: string) {
      if (table === "visits") {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) q[m] = () => q;
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
const updates = (fake: Fake) => fake.calls.filter((c) => c.table === "test_requests" && c.op === "update");
const report = (result: string, ...ids: string[]): FakeLink[] => ids.map((id) => ({ testRequestId: id, resultId: result }));
/** Run `fn` on the n-th (1-based) test_requests read — to change a row between the plan and the write. */
function onTestRequestRead(fake: Fake, n: number, fn: () => void) {
  let seen = 0;
  fake.hooks.beforeRead = (table) => {
    if (table === "test_requests" && ++seen === n) fn();
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
    expect(updates(fake)).toHaveLength(0);
    expect(fx.notifyBulk).toEqual([]);
    expect(fx.notifyOne).toEqual([]);
    expect(fx.alerts).toEqual([]);
  });

  it("3. refuses when an unreleased sibling was deleted", async () => {
    const fake = seed({ b: { deleted: true } });
    expect(await releaseTestAction("a", "v1", "email")).toEqual({ ok: false, error: REPORT_REFUSAL.deletedMember });
    expect(statusOf(fake, "a")).toBe("ready_for_release");
  });

  it("4. fails closed when the report membership cannot be read", async () => {
    const fake = seed();
    fake.failNext("result_test_requests", "read");
    expect(await releaseTestAction("a", "v1", "email")).toEqual({ ok: false, error: COULDNT_CHECK_REPORT });
    expect(updates(fake)).toHaveLength(0);
    expect(fx.alerts).toEqual([]);
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

  it("11. a write that only half-lands warns, and neither notifies nor alerts", async () => {
    const fake = seed();
    fake.failNext("test_requests", "update-partial");
    const res = await releaseTestAction("a", "v1", "email");
    expect(res).toEqual({ ok: true, changedCount: 1, alsoReleasedCount: 0, skipped: [], warnings: [REPORT_CHANGED_REASON] });
    expect([statusOf(fake, "a"), statusOf(fake, "b")]).toEqual(["released", "ready_for_release"]);
    expect(fx.notifyBulk).toEqual([]);
    expect(fx.notifyOne).toEqual([]);
    expect(fx.alerts).toEqual([]);
  });

  it("12. the selected row races away but a pulled-in sibling releases: still ok, never a bare error", async () => {
    const fake = seed();
    // read 1 = the candidate read, read 2 = releaseRows' — a goes stale in between.
    onTestRequestRead(fake, 2, () => {
      fake.rows.find((r) => r.id === "a")!.status = "result_uploaded";
    });
    const res = await releaseTestAction("a", "v1", "email");
    expect(res).toEqual({
      ok: true,
      changedCount: 0,
      alsoReleasedCount: 1,
      skipped: [{ id: "a", reason: REPORT_CHANGED_REASON }],
      warnings: [],
    });
    expect(statusOf(fake, "b")).toBe("released");
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

  it("12. the selected report races away but a pulled-in member releases: count 0, still ok", async () => {
    const fake = seed();
    onTestRequestRead(fake, 2, () => {
      fake.rows.find((r) => r.id === "a")!.status = "result_uploaded";
    });
    const res = await releaseSelectedAction("v1", ["a"], "physical");
    expect(res).toEqual({
      ok: true,
      count: 0,
      alsoReleasedCount: 1,
      skipped: [{ id: "a", reason: REPORT_CHANGED_REASON }],
      warnings: [],
      batchId: expect.any(String),
      notifiedCount: 0,
    });
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
    const written = updates(fake).flatMap((c) => c.filters.filter((f) => f.column === "id").flatMap((f) => f.value as string[]));
    expect(written.sort()).toEqual(["c1", "c2", "d"]);
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

  it("12. every component refused is an error; a raced selected row with a pulled-in release is ok", async () => {
    seed({ c1: { status: "result_uploaded" }, d: { status: "result_uploaded" } });
    expect(await releaseAllReadyComponentsAction("h", "v1", "physical")).toEqual({
      ok: false,
      error: REPORT_REFUSAL.notFinished(1),
    });
    const fake = seed({ c1: { status: "result_uploaded" } });
    // reads: 1 header, 2 ready components, 3 releaseRows — c2 goes stale in between.
    onTestRequestRead(fake, 3, () => {
      fake.rows.find((r) => r.id === "c2")!.status = "result_uploaded";
    });
    expect(await releaseAllReadyComponentsAction("h", "v1", "physical")).toEqual({
      ok: true,
      changedCount: 0,
      alsoReleasedCount: 1,
      skipped: [{ id: "c2", reason: REPORT_CHANGED_REASON }],
      warnings: [],
    });
  });

  it("13. changedCount is what the write released: a component already released is not counted, one that races is skipped", async () => {
    const fake = seed();
    // Released by someone else before the click: never read as a candidate.
    fake.rows.push({ ...fake.rows[0], id: "c3", parentId: "h", status: "released" });
    fake.failNext("test_requests", "update-partial");
    const res = await releaseAllReadyComponentsAction("h", "v1", "physical");
    // partial write lands c1 only; c2 (and its report) did not go out.
    expect(res).toEqual({
      ok: true,
      changedCount: 1,
      alsoReleasedCount: 0,
      skipped: [{ id: "c2", reason: RACED_REASON }],
      warnings: [],
    });
    expect(res.ok && res.skipped.some((s) => s.id === "c3")).toBe(false);
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
