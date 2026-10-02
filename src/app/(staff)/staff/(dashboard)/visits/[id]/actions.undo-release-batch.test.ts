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
  viewCountReads: [] as string[],
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
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (a: { scope: string }) => void fx.reported.push(a),
}));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({ deleteVisitAction: async () => ({ ok: true }) }));
vi.mock("@/lib/notifications/notify-released", () => ({ notifyResultReleased: async () => {} }));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({ notifyResultsReleasedBulk: async () => {} }));
// A spy: the undo's viewed_count is computed in SQL (0205), so TypeScript must never read it.
vi.mock("@/lib/results/viewed-count", () => ({ countResultViews: async (id: string) => { fx.viewCountReads.push(id); return 0; } }));
vi.mock("@/lib/notifications/release-staff-alert", () => ({ scheduleReleaseStaffAlert: () => {} }));

import { BULK_UNDO_VIA, CHANGED_SINCE_REASON, UNDO_ALREADY, UNDO_EXPIRED } from "@/lib/ui/bulk-undo";
import { RELEASED_SEPARATELY_REASON } from "@/lib/actions/visits/release-undo-refusal";
import { FAKE_RELEASED_AT, makeFakeReleaseDb, type FakeLink, type FakeTestRow } from "@/lib/actions/visits/fake-release-db";

const { undoReleaseBatchAction, undoReleaseSelectedAction } = await import("./actions");

const BATCH = "11111111-1111-4111-8111-111111111111";
const REASON = "Undone within 10 minutes of release";
/** Another instant, e.g. a re-release by someone else inside the window. */
const OTHER_AT = "2026-09-30T07:05:00.654321+00:00";

/** Live visit v1 + fake test_requests/RPCs (the visit page's actions also read `visits`, via maybeSingle). */
function setup(rows: FakeTestRow[], links: FakeLink[] = [], viewedCounts?: Record<string, number>) {
  const fake = makeFakeReleaseDb({ rows, links, actorRole: () => fx.role, viewedCounts });
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
function seed(over: Record<string, Partial<FakeTestRow>> = {}, viewedCounts?: Record<string, number>) {
  const rows: FakeTestRow[] = ["a", "b", "c", "d", "x", "y", "z"].map((id) => ({ id, ...REL, ...(over[id] ?? {}) }));
  return setup(rows, [
    { testRequestId: "a", resultId: "r1" },
    { testRequestId: "b", resultId: "r1" },
    { testRequestId: "c", resultId: "r2" },
    { testRequestId: "d", resultId: "r2" },
  ], viewedCounts);
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
/**
 * loadBatch for a Queue batch across visits: `visitOf` maps each id to its audit
 * row's metadata.visit_id ("" = omit visit_id, like a row this action never wrote).
 */
function loadBatchAcross(visitOf: Record<string, string>, opts: { changedSince?: string[] } = {}) {
  fx.loaded = {
    ok: true,
    alreadyUndone: false,
    changedSince: new Set(opts.changedSince ?? []),
    rows: Object.entries(visitOf).map(([id, visitId]) => ({
      action: "test_request.released",
      resource_id: id,
      metadata: { ...(visitId === "" ? {} : { visit_id: visitId }), released_at: FAKE_RELEASED_AT },
    })),
  };
}
/** The release_undone rows the database (as the fake models it) wrote; TypeScript writes none. */
const undoAudits = (fake: Fake) => fake.dbAudits.filter((a) => a.action === "test_request.release_undone");
const tsUndoAudits = () => fx.audits.filter((a) => a.action === "test_request.release_undone");

beforeEach(() => {
  fx.role = "admin";
  fx.revalidate.length = 0;
  fx.audits.length = 0;
  fx.viewCountReads.length = 0;
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
    expect(undoAudits(fake).map((a) => a.resource_id)).toEqual(["x"]);
  });

  it("a report-mate this batch did NOT release keeps the report released: the batch line is named with the released-separately reason, and the mate itself is not named", async () => {
    const fake = seed();
    // b is in a's report but released separately: no audit row in this batch.
    loadBatch(["a", "x"]);
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual(["x"]);
    expect(res.notRestored).toEqual([{ id: "a", reason: RELEASED_SEPARATELY_REASON }]);
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
    expect(undoAudits(fake)).toEqual([]);
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
  it("the batch Undo sends via, undo_of_batch and a NEW bulk_batch_id as p_audit, the reason as p_reason; the database rows carry them plus the prior values and the report id", async () => {
    const fake = seed({ a: { releaseMedium: "viber" } }, { a: 3 });
    loadBatch(["a", "b", "x"]);
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    const [call] = undoCalls(fake);
    expect(call.args.p_reason).toBe(REASON);
    const sent = call.args.p_audit as { metadata: Record<string, unknown>; ip: unknown; user_agent: unknown };
    expect(sent).toEqual({
      metadata: { bulk: true, via: BULK_UNDO_VIA, undo_of_batch: BATCH, bulk_batch_id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      ip: "1.2.3.4",
      user_agent: "ua",
    });
    expect(sent.metadata.bulk_batch_id).not.toBe(BATCH);
    // The database owns the rows now: TypeScript neither writes them nor reads the view counts.
    expect(tsUndoAudits()).toEqual([]);
    expect(fx.viewCountReads).toEqual([]);
    const audits = undoAudits(fake);
    expect(audits.map((a) => a.resource_id)).toEqual(["a", "b", "x"]);
    const newBatchIds = new Set<string>();
    for (const a of audits) {
      expect(a).toMatchObject({ actor_id: "u1", actor_type: "staff", resource_type: "test_request", ip_address: "1.2.3.4", user_agent: "ua" });
      expect(a.metadata.bulk_batch_id).toBe(sent.metadata.bulk_batch_id);
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

  it("0224: a batch Undo reaching a line whose doctor fee was already paid out (P0084) shows the void-the-payout message; nothing is audited", async () => {
    const fake = seed();
    loadBatch(["x"]);
    fake.failNextRpc("undo_visit_release", { code: "P0084", message: "raw database text that must not reach the user" });
    expect(await undoReleaseBatchAction({ batchId: BATCH })).toEqual({
      ok: false,
      error: "This doctor's fee was already paid out — void the payout first.",
    });
    expect(tsUndoAudits()).toEqual([]);
  });

  it("a database refusal (P0081) is shown, nothing is audited", async () => {
    const fake = seed();
    loadBatch(["x"]);
    fake.failNextRpc("undo_visit_release", { code: "P0081", message: "Couldn't read which release to undo — try again." });
    expect(await undoReleaseBatchAction({ batchId: BATCH })).toEqual({
      ok: false,
      error: "Couldn't read which release to undo — try again.",
    });
    expect(tsUndoAudits()).toEqual([]);
  });
});

describe("undoReleaseBatchAction — a Queue batch across visits", () => {
  it("undoes every visit's lines, one undo_visit_release per visit, all under ONE new batch id", async () => {
    const fake = setup([
      { id: "a", visitId: "v1", ...REL },
      { id: "x", visitId: "v1", ...REL },
      { id: "y", visitId: "v2", ...REL },
    ]);
    loadBatchAcross({ a: "v1", x: "v1", y: "v2" });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    expect(res).toEqual({ ok: true, restoredIds: ["a", "x", "y"], notRestored: [] });
    const calls = undoCalls(fake);
    expect(calls.map((c) => [c.args.p_visit_id, c.args.p_test_request_ids])).toEqual([
      ["v1", ["a", "x"]],
      ["v2", ["y"]],
    ]);
    const undoIds = calls.map((c) => (c.args.p_audit as { metadata: { bulk_batch_id: string } }).metadata.bulk_batch_id);
    expect(new Set(undoIds).size).toBe(1);
    expect(undoIds[0]).not.toBe(BATCH);
    expect(calls[0].args.p_expected_released_at).toEqual({ a: FAKE_RELEASED_AT, x: FAKE_RELEASED_AT });
    expect(calls[1].args.p_expected_released_at).toEqual({ y: FAKE_RELEASED_AT });
    // Every visit's release surfaces are refreshed.
    expect(fx.revalidate).toEqual(expect.arrayContaining([["/staff/visits/v1", undefined], ["/staff/visits/v2", undefined]]));
  });

  it("one visit's database refusal names that visit's lines; the other visit still comes back", async () => {
    const fake = setup([{ id: "a", visitId: "v1", ...REL }, { id: "y", visitId: "v2", ...REL }]);
    loadBatchAcross({ a: "v1", y: "v2" });
    fake.failNextRpc("undo_visit_release", { code: "P0081", message: "This visit was deleted from the queue. Restore it before undoing a release." });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual(["y"]);
    expect(res.notRestored).toEqual([{ id: "a", reason: "This visit was deleted from the queue. Restore it before undoing a release." }]);
  });

  it("every visit refused: an error, not an empty success", async () => {
    const fake = setup([{ id: "a", visitId: "v1", ...REL }]);
    loadBatchAcross({ a: "v1" });
    fake.failNextRpc("undo_visit_release", { code: "P0081", message: "Nope." });
    expect(await undoReleaseBatchAction({ batchId: BATCH })).toEqual({ ok: false, error: "Nope." });
  });

  it("a batch row with no visit_id is named, not guessed onto another visit", async () => {
    setup([{ id: "a", visitId: "v1", ...REL }, { id: "b", visitId: "v1", ...REL }]);
    loadBatchAcross({ a: "v1", b: "" });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual(["a"]);
    expect(res.notRestored).toEqual([{ id: "b", reason: CHANGED_SINCE_REASON }]);
  });

  it("a visit's report-mate released outside the batch is named released-separately; another visit's refusal stays changed-since", async () => {
    // a (v1) completes report r1 with b, released separately; y (v2) was re-released by someone else.
    const fake = setup(
      [
        { id: "a", visitId: "v1", ...REL },
        { id: "b", visitId: "v1", ...REL },
        { id: "y", visitId: "v2", ...REL, releasedAt: OTHER_AT },
        { id: "z", visitId: "v2", ...REL },
      ],
      [
        { testRequestId: "a", resultId: "r1" },
        { testRequestId: "b", resultId: "r1" },
      ],
    );
    loadBatchAcross({ a: "v1", y: "v2", z: "v2" });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual(["z"]);
    expect(res.notRestored).toEqual(
      expect.arrayContaining([
        { id: "a", reason: RELEASED_SEPARATELY_REASON },
        { id: "y", reason: CHANGED_SINCE_REASON },
      ]),
    );
    expect(res.notRestored).toHaveLength(2);
    expect(statusOf(fake, "b")).toBe("released");
  });

  it("visits are undone in sorted id order whatever order the batch lists them in", async () => {
    const fake = setup([{ id: "a", visitId: "v1", ...REL }, { id: "y", visitId: "v2", ...REL }]);
    loadBatchAcross({ y: "v2", a: "v1" });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    expect(undoCalls(fake).map((c) => c.args.p_visit_id)).toEqual(["v1", "v2"]);
    expect(res.restoredIds).toEqual(["a", "y"]);
  });

  it("every visit failing is an error carrying the FIRST visit's message", async () => {
    const fake = setup([{ id: "a", visitId: "v1", ...REL }, { id: "y", visitId: "v2", ...REL }]);
    loadBatchAcross({ a: "v1", y: "v2" });
    fake.failNextRpc("undo_visit_release", { code: "P0081", message: "First visit refused." });
    fake.failNextRpc("undo_visit_release", { code: "P0081", message: "Second visit refused." });
    expect(await undoReleaseBatchAction({ batchId: BATCH })).toEqual({ ok: false, error: "First visit refused." });
  });

  it("a failed visit's page is still refreshed, and the shared surfaces are refreshed exactly once", async () => {
    const fake = setup([{ id: "a", visitId: "v1", ...REL }, { id: "y", visitId: "v2", ...REL }]);
    loadBatchAcross({ a: "v1", y: "v2" });
    fake.failNextRpc("undo_visit_release", { code: "P0081", message: "Nope." });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    if (!res.ok) throw new Error(res.error);
    const pages = fx.revalidate.filter(([p]) => p.startsWith("/staff/visits/")).map(([p]) => p);
    expect(pages.sort()).toEqual(["/staff/visits/v1", "/staff/visits/v2"]);
    expect(fx.revalidate.filter(([p]) => p === "/staff")).toHaveLength(1);
    expect(fx.revalidate.filter(([p]) => p.includes("/queue"))).toHaveLength(1);
  });

  it("lines refused up front (changed since) keep their reason and are never sent", async () => {
    const fake = setup([{ id: "a", visitId: "v1", ...REL }, { id: "y", visitId: "v2", ...REL }]);
    loadBatchAcross({ a: "v1", y: "v2" }, { changedSince: ["a"] });
    const res = await undoReleaseBatchAction({ batchId: BATCH });
    expect(res).toEqual({ ok: true, restoredIds: ["y"], notRestored: [{ id: "a", reason: CHANGED_SINCE_REASON }] });
    expect(undoCalls(fake).map((c) => c.args.p_visit_id)).toEqual(["v2"]);
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
    expect(call.args).toMatchObject({
      p_reason: "wrong patient",
      p_audit: { metadata: { bulk: true }, ip: "1.2.3.4", user_agent: "ua" },
    });
    expect(tsUndoAudits()).toEqual([]);
    expect(undoAudits(fake)[0].metadata).toMatchObject({ reason: "wrong patient", bulk: true, prior_released_at: OTHER_AT });
    expect(undoAudits(fake)[0].metadata).not.toHaveProperty("via");
  });

  it("with nothing to undo it is still an error (only a batch Undo may restore nothing)", async () => {
    seed({ x: { status: "ready_for_release", releasedAt: null, releaseMedium: null } });
    expect(await undoReleaseSelectedAction("v1", ["x"], "r")).toEqual({
      ok: false,
      error: "None of the selected tests can be unreleased.",
    });
  });
});
