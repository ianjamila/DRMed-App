import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * undoBulkQueueAction, end to end against an in-memory fake client
 * (src/lib/testing/fake-db). Nothing in the action is stubbed except the
 * edges: the session, the audit writer, headers/cache, and the patient-active
 * guard. The real planQueueUndo, loadOwnBatchRows, unclaimPanelMembers,
 * reclaimPanelMembers, restorePanelMembers, restoreTestRequestsForVisit and the action's own conditional writes all run,
 * against rows whose state the tests then read back — so a predicate dropped
 * from a write (or a check dropped from a guard) changes the rows and fails a
 * test, instead of only changing what a source-text grep sees.
 *
 * The fake compares timestamps as instants (as Postgres does) and the fixtures
 * spell the SAME instant two ways ("...Z" in audit metadata, "+00:00" on the
 * row) exactly as PostgREST does on read-back.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "9.9.9.9", "user-agent": "vitest" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const h = vi.hoisted(() => ({
  session: { user_id: "user-admin", role: "admin" } as { user_id: string; role: string },
  db: null as unknown,
  audit: vi.fn(async (entry: Record<string, unknown>) => void entry),
  patientActive: vi.fn<(db?: unknown, visitId?: string) => Promise<{ ok: true } | { ok: false; error: string }>>(async () => ({ ok: true })),
}));

vi.mock("@/lib/auth/require-staff", () => ({ requireActiveStaff: async () => h.session }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as FakeDb).client() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/audit/log", () => ({ audit: h.audit }));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: h.patientActive }));

import { revalidatePath } from "next/cache";
import { undoBulkQueueAction } from "./actions";
import { FakeDb, type CallRecord, type Row } from "@/lib/testing/fake-db";
import { panelRowKey } from "@/lib/queue/bulk-queue";
import { BULK_UNDO_VIA, UNDO_ALREADY, UNDO_EXPIRED, UNDO_WINDOW_MS } from "@/lib/ui/bulk-undo";

// ---- literals the action owns (pinned here on purpose: they are user-facing) ----
const ROLE_CHANGED = "Your role can no longer do this.";
const MOVED_ON = "claimed work has moved on — a result was uploaded or someone else holds it";
const HOLDER_UNUSABLE = "the person who held it can no longer take this test";
const STATE_MOVED = "someone claimed it since, or it changed";
const PANEL_CHANGED = "part of this panel was already restored or changed";
const CHANGED_SINCE = "changed again since — refresh to see its status";
const P0077_FALLBACK = "Some tests in this report were already claimed or changed status.";
// 0200's own messages, which translatePgError passes straight through (P0082)
const RECLAIM_P0082 = "Someone claimed or changed part of this report since — nothing was put back.";
const RESTORE_P0082 = "Part of this report was already restored or changed — nothing was restored.";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
/** The same instant as PostgREST reads it back: "+00:00" spelling, no trailing zeros. */
const pg = (isoZ: string) => isoZ.replace(/\.?0*Z$/, "+00:00").replace(/(\.\d*?)0+\+/, "$1+");

const BATCH = "0b7c3d2e-1111-4111-8111-000000000001";
const VISIT = "visit-1";
const GROUP = "group-1";
const KEY = panelRowKey(VISIT, GROUP);
const VISIT_2 = "visit-2";
const KEY_2 = panelRowKey(VISIT_2, GROUP);

let db: FakeDb;
let seq = 0;
const auditCalls = () => h.audit.mock.calls.map((c) => c[0] as Record<string, unknown>);
const auditsOf = (action: string) => auditCalls().filter((a) => a.action === action);
const meta = (a: Record<string, unknown>) => a.metadata as Record<string, unknown>;
const revalidated = () => vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);

/** A test_requests row, in the shape both the action's reads and the core's reads select from. */
function tr(id: string, over: Row = {}): Row {
  return {
    id,
    visit_id: VISIT,
    status: "requested",
    assigned_to: null,
    started_at: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    parent_id: null,
    services: { section: "chemistry", kind: "lab_test", name: `Svc ${id}`, code: `C-${id}` },
    visits: { deleted_at: null, payment_status: "paid", hmo_provider_id: null, patient_id: "patient-1" },
    ...over,
  };
}

/** One audit row of the ORIGINAL bulk call (what the Undo reads back). */
function batchAudit(action: string, resourceId: string, m: Row, over: Row = {}): Row {
  seq += 1;
  return {
    id: `a-${String(seq).padStart(5, "0")}`,
    actor_id: h.session.user_id,
    resource_type: "test_request",
    resource_id: resourceId,
    action,
    metadata: { bulk_batch_id: BATCH, visit_id: VISIT, ...m },
    created_at: new Date(NOW - 120_000 + seq * 10).toISOString(),
    ...over,
  };
}

const claimed = (id: string, startedAt: string | null, panelKey: string | null = KEY, over: Row = {}) =>
  batchAudit("test_request.claimed", id, { started_at: startedAt, panel_key: panelKey, ...(panelKey ? { grouped: true } : {}) }, over);
const unclaimed = (id: string, holder: string, startedAt: string | null, panelKey: string | null = KEY) =>
  batchAudit("test_request.unclaimed", id, {
    previous_assignee: holder,
    previous_started_at: startedAt,
    panel_key: panelKey,
  });
const deleted = (id: string, deletedAt: string | null, panelKey: string | null = KEY, visitId = VISIT) =>
  batchAudit("test_request.deleted", id, { deleted_at: deletedAt, panel_key: panelKey, visit_id: visitId });

const profile = (id: string, over: Row = {}): Row => ({
  id,
  role: "medtech",
  is_active: true,
  deleted_at: null,
  ...over,
});

type RpcHandler = NonNullable<FakeDb["hooks"]["rpc"]>;
const visitOf = (r: Row) => r.visits as Row;

/** Mirrors 0191's unclaim_panel_members: every member still in progress under ITS holder, or nothing changes. */
const unclaimRpc: RpcHandler = (rec, d) => {
  const ids = rec.args.p_test_request_ids as string[];
  const holders = rec.args.p_holders as string[];
  const rows = ids.map((id) => d.row("test_requests", id));
  const ok = rows.every((r, i) => r.status === "in_progress" && r.assigned_to === holders[i] && r.deleted_at === null);
  if (!ok) return { error: { code: "P0077", message: "Some tests in this report were already claimed or changed status." } };
  for (const r of rows) Object.assign(r, { status: "requested", assigned_to: null, started_at: null });
  return { error: null };
};

/**
 * Mirrors 0200's reclaim_panel_members: every id still requested + unassigned +
 * live on a live visit, or P0082 with NO row changed; otherwise each member goes
 * in_progress under its own holder at its own started_at (null = now()).
 */
const reclaimRpc: RpcHandler = (rec, d) => {
  const ids = rec.args.p_test_request_ids as string[];
  const holders = rec.args.p_holders as string[];
  const startedAt = rec.args.p_started_at as Array<string | null>;
  const rows = ids.map((id) => d.row("test_requests", id));
  const ok = rows.every(
    (r) => r.status === "requested" && r.assigned_to === null && r.deleted_at === null && visitOf(r).deleted_at === null,
  );
  if (!ok) return { error: { code: "P0082", message: RECLAIM_P0082 } };
  rows.forEach((r, i) =>
    Object.assign(r, { status: "in_progress", assigned_to: holders[i], started_at: startedAt[i] ?? new Date().toISOString() }),
  );
  return { data: rows.length, error: null };
};

/**
 * Mirrors 0200's restore_panel_members: every id on p_visit_id, top-level, and
 * deleted at the SAME INSTANT as passed, on a live visit, or P0082 with NO row
 * changed; otherwise the three delete columns are cleared.
 */
const restoreRpc: RpcHandler = (rec, d) => {
  const ids = rec.args.p_test_request_ids as string[];
  const deletedAt = rec.args.p_deleted_at as string[];
  const rows = ids.map((id) => d.row("test_requests", id));
  const ok = rows.every(
    (r, i) =>
      r.visit_id === rec.args.p_visit_id &&
      r.parent_id === null &&
      typeof r.deleted_at === "string" &&
      Date.parse(r.deleted_at) === Date.parse(deletedAt[i]!) &&
      visitOf(r).deleted_at === null,
  );
  if (!ok) return { error: { code: "P0082", message: RESTORE_P0082 } };
  for (const r of rows) Object.assign(r, { deleted_at: null, deleted_by: null, delete_reason: null });
  return { data: rows.length, error: null };
};

/** The three panel RPCs, dispatched by function name. */
function installPanelRpcs(dbx: FakeDb) {
  dbx.hooks.rpc = (rec, d) => {
    if (rec.fn === "unclaim_panel_members") return unclaimRpc(rec, d);
    if (rec.fn === "reclaim_panel_members") return reclaimRpc(rec, d);
    if (rec.fn === "restore_panel_members") return restoreRpc(rec, d);
    throw new Error(`unexpected rpc ${rec.fn}`);
  };
}

/** Run `race` against the DB in the instant BEFORE the named RPC's SQL rule runs (a lost race inside the RPC's window). */
function raceBeforeRpc(dbx: FakeDb, fn: string, race: (d: FakeDb) => void) {
  const real = dbx.hooks.rpc!;
  dbx.hooks.rpc = (rec, d) => {
    if (rec.fn === fn) race(d);
    return real(rec, d);
  };
}

/** A beforeWrite hook that fails the first `times` matching test_requests updates with P0072 (the lifecycle race). */
function lifecycleRaceOnUpdates(dbx: FakeDb, match: (patch: Row) => boolean, times: number) {
  let left = times;
  dbx.hooks.beforeWrite = (call) => {
    if (call.table === "test_requests" && call.patch && match(call.patch) && left > 0) {
      left -= 1;
      return { code: "P0072", message: "moved" };
    }
  };
}

function expectNoWrites() {
  expect(db.updates("test_requests")).toEqual([]);
  expect(db.rpcCalls).toEqual([]);
  expect(h.audit).not.toHaveBeenCalled();
}

const targets = (c: Pick<CallRecord, "filters">): string[] => {
  const f = c.filters.find(([n, a]) => n === "in" && a[0] === "id");
  const eq = c.filters.find(([n, a]) => n === "eq" && a[0] === "id");
  return f ? (f[1][1] as string[]) : eq ? [eq[1][1] as string] : [];
};

const run = (batchId: unknown = BATCH) => undoBulkQueueAction({ batchId });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = new FakeDb();
  h.db = db;
  h.session = { user_id: "user-admin", role: "admin" };
  h.audit.mockClear();
  h.patientActive.mockReset();
  h.patientActive.mockResolvedValue({ ok: true });
  vi.mocked(revalidatePath).mockClear();
  seq = 0;
  installPanelRpcs(db);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// claimed -> un-claim: a chemistry panel goes through unclaim_panel_members
// ---------------------------------------------------------------------------
describe("Undo of a bulk Claim: a chemistry panel", () => {
  const S1 = "2026-09-30T11:58:01.000Z";
  const S2 = "2026-09-30T11:58:02.000Z";
  const S3 = "2026-09-30T11:58:03.000Z";

  function seedPanel(over: { holder?: string } = {}) {
    const holder = over.holder ?? h.session.user_id;
    db.seed("test_requests", [
      tr("m1", { status: "in_progress", assigned_to: holder, started_at: pg(S1) }),
      tr("m2", { status: "in_progress", assigned_to: holder, started_at: pg(S2) }),
      tr("m3", { status: "in_progress", assigned_to: holder, started_at: pg(S3) }),
    ]);
    db.seed("audit_log", [claimed("m1", S1), claimed("m2", S2), claimed("m3", S3)]);
  }

  it("calls the all-or-nothing rpc ONCE with every member and the caller as holder, and reports 3 tests for 1 key", async () => {
    seedPanel();
    const r = await run();

    expect(r).toEqual({ ok: true, restoredIds: [KEY], restoredTestCount: 3, notRestored: [] });
    expect(db.rpcCalls).toEqual([
      {
        fn: "unclaim_panel_members",
        args: { p_test_request_ids: ["m1", "m2", "m3"], p_holders: ["user-admin", "user-admin", "user-admin"] },
      },
    ]);
    for (const id of ["m1", "m2", "m3"]) {
      expect(db.row("test_requests", id)).toMatchObject({ status: "requested", assigned_to: null, started_at: null });
    }
    // the panel goes through the rpc only — no per-row update fallback
    expect(db.updates("test_requests")).toEqual([]);
  });

  it("writes one unclaimed audit row per member carrying via/undo_of_batch/a NEW batch id/panel_key", async () => {
    seedPanel();
    await run();
    const rows = auditsOf("test_request.unclaimed");
    expect(rows.map((a) => a.resource_id)).toEqual(["m1", "m2", "m3"]);
    const newBatch = meta(rows[0]!).bulk_batch_id;
    expect(newBatch).toMatch(/^[0-9a-f-]{36}$/);
    expect(newBatch).not.toBe(BATCH);
    for (const a of rows) {
      expect(a).toMatchObject({ actor_id: "user-admin", actor_type: "staff", resource_type: "test_request" });
      expect(meta(a)).toMatchObject({
        visit_id: VISIT,
        previous_assignee: "user-admin",
        reason: "Undo of a bulk claim",
        self_service: false,
        grouped: true,
        via: BULK_UNDO_VIA,
        undo_of_batch: BATCH,
        bulk_batch_id: newBatch,
        panel_key: KEY,
      });
    }
    expect(auditCalls()).toHaveLength(3);
  });

  it("a non-admin (medtech) undoing their own claim is audited self_service", async () => {
    h.session = { user_id: "user-med", role: "medtech" };
    db = new FakeDb();
    h.db = db;
    installPanelRpcs(db);
    seedPanel({ holder: "user-med" });
    const r = await run();
    expect(r).toMatchObject({ ok: true, restoredIds: [KEY], restoredTestCount: 3 });
    expect(auditsOf("test_request.unclaimed").every((a) => meta(a).self_service === true)).toBe(true);
    expect(db.rpcCalls[0]!.args.p_holders).toEqual(["user-med", "user-med", "user-med"]);
  });

  it("revalidates the queue, each member's page and the panel's consolidated page", async () => {
    seedPanel();
    await run();
    expect(revalidated()).toEqual(
      expect.arrayContaining([
        "/staff/queue",
        "/staff/queue/m1",
        "/staff/queue/m2",
        "/staff/queue/m3",
        `/staff/queue/consolidated/${VISIT}/${GROUP}`,
      ]),
    );
  });

  it("refuses the WHOLE panel, without calling the rpc, when one member's started_at differs (re-claimed since)", async () => {
    seedPanel();
    db.row("test_requests", "m2").started_at = pg("2026-09-30T11:59:30.000Z"); // same holder, later claim
    const r = await run();

    expect(r).toEqual({ ok: true, restoredIds: [], restoredTestCount: 0, notRestored: [{ id: KEY, reason: MOVED_ON }] });
    expectNoWrites();
    expect(revalidated()).toEqual([]);
    expect(db.row("test_requests", "m1")).toMatchObject({ status: "in_progress", assigned_to: "user-admin" });
  });

  it.each([
    ["a member is held by someone else now", { assigned_to: "user-other" }],
    ["a member has moved on (result uploaded)", { status: "result_uploaded" }],
    ["a member was deleted from the queue", { deleted_at: "2026-09-30T11:59:00+00:00" }],
    ["a member's visit was deleted", { visits: { deleted_at: "2026-09-30T11:59:00+00:00" } }],
  ])("refuses the whole panel when %s", async (_name, patch) => {
    seedPanel();
    Object.assign(db.row("test_requests", "m3"), patch);
    const r = await run();
    expect(r).toMatchObject({ ok: true, restoredIds: [], restoredTestCount: 0, notRestored: [{ id: KEY, reason: MOVED_ON }] });
    expectNoWrites();
  });

  it("refuses the panel when a member has vanished from the read (fewer rows than ids)", async () => {
    seedPanel();
    db.tables.test_requests = db.rows("test_requests").filter((r) => r.id !== "m3");
    const r = await run();
    expect(r).toMatchObject({ restoredIds: [], notRestored: [{ id: KEY, reason: MOVED_ON }] });
    expectNoWrites();
  });

  it("a claim whose read-back failed (audit started_at null) can never be undone", async () => {
    seedPanel();
    db.tables.audit_log = [claimed("m1", null), claimed("m2", S2), claimed("m3", S3)];
    const r = await run();
    expect(r).toMatchObject({ restoredIds: [], notRestored: [{ id: KEY, reason: MOVED_ON }] });
    expectNoWrites();
  });

  it("a P0077 from the rpc (lost the race in the instant after the read) puts the panel in notRestored with the translated message and writes NO audit", async () => {
    seedPanel();
    db.hooks.rpc = () => ({ error: { code: "P0077", message: "Two of these tests were just claimed by someone else." } });
    const r = await run();
    expect(r).toEqual({
      ok: true,
      restoredIds: [],
      restoredTestCount: 0,
      notRestored: [{ id: KEY, reason: "Two of these tests were just claimed by someone else." }],
    });
    expect(db.rpcCalls).toHaveLength(1);
    expect(h.audit).not.toHaveBeenCalled();
    expect(revalidated()).toEqual([]);
    expect(db.row("test_requests", "m1")).toMatchObject({ status: "in_progress" });
  });

  it("a P0077 with no message falls back to the standard refusal text", async () => {
    seedPanel();
    db.hooks.rpc = () => ({ error: { code: "P0077" } });
    const r = await run();
    expect(r).toMatchObject({ notRestored: [{ id: KEY, reason: P0077_FALLBACK }] });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("one panel refused does not stop another panel of the same batch", async () => {
    seedPanel();
    db.seed("test_requests", [
      tr("n1", { visit_id: VISIT_2, status: "in_progress", assigned_to: "user-admin", started_at: pg(S1) }),
      tr("n2", { visit_id: VISIT_2, status: "in_progress", assigned_to: "user-admin", started_at: pg(S2) }),
    ]);
    db.seed("audit_log", [
      claimed("n1", S1, KEY_2, { metadata: { bulk_batch_id: BATCH, visit_id: VISIT_2, started_at: S1, panel_key: KEY_2 } }),
      claimed("n2", S2, KEY_2, { metadata: { bulk_batch_id: BATCH, visit_id: VISIT_2, started_at: S2, panel_key: KEY_2 } }),
    ]);
    db.row("test_requests", "m2").assigned_to = "user-other";
    const r = await run();
    expect(r).toEqual({
      ok: true,
      restoredIds: [KEY_2],
      restoredTestCount: 2,
      notRestored: [{ id: KEY, reason: MOVED_ON }],
    });
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]!.args.p_test_request_ids).toEqual(["n1", "n2"]);
  });
});

// ---------------------------------------------------------------------------
// claimed -> un-claim: single rows (exact-predicate update)
// ---------------------------------------------------------------------------
describe("Undo of a bulk Claim: single tests", () => {
  const S1 = "2026-09-30T11:58:01.000Z";
  const S2 = "2026-09-30T11:58:02.500Z";

  function seedSingles() {
    db.seed("test_requests", [
      tr("s1", { status: "in_progress", assigned_to: "user-admin", started_at: pg(S1) }),
      tr("s2", { status: "in_progress", assigned_to: "user-admin", started_at: pg(S2) }),
    ]);
    db.seed("audit_log", [claimed("s1", S1, null), claimed("s2", S2, null)]);
  }

  it("un-claims each with an update pinned to status, holder, the exact started_at and deleted_at", async () => {
    seedSingles();
    const r = await run();

    expect(r).toEqual({ ok: true, restoredIds: ["s1", "s2"], restoredTestCount: 2, notRestored: [] });
    const writes = db.updates("test_requests");
    expect(writes.map(targets)).toEqual([["s1"], ["s2"]]);
    for (const w of writes) {
      expect(w.patch).toEqual({ status: "requested", assigned_to: null, started_at: null });
      expect(w.filters).toEqual(
        expect.arrayContaining([
          ["eq", ["status", "in_progress"]],
          ["eq", ["assigned_to", "user-admin"]],
          ["is", ["deleted_at", null]],
        ]),
      );
    }
    expect(writes[0]!.filters).toContainEqual(["eq", ["started_at", S1]]);
    expect(writes[1]!.filters).toContainEqual(["eq", ["started_at", S2]]);
    expect(db.row("test_requests", "s1")).toMatchObject({ status: "requested", assigned_to: null, started_at: null });
    expect(db.rpcCalls).toEqual([]); // singles never use the panel rpc

    const rows = auditsOf("test_request.unclaimed");
    expect(rows.map((a) => a.resource_id)).toEqual(["s1", "s2"]);
    for (const a of rows) {
      expect(meta(a)).toMatchObject({
        previous_assignee: "user-admin",
        reason: "Undo of a bulk claim",
        via: BULK_UNDO_VIA,
        undo_of_batch: BATCH,
      });
      expect(meta(a).bulk_batch_id).not.toBe(BATCH);
      expect(meta(a)).not.toHaveProperty("panel_key");
    }
    expect(revalidated()).toEqual(expect.arrayContaining(["/staff/queue", "/staff/queue/s1", "/staff/queue/s2"]));
  });

  it("a write that matches no row (re-claimed in the instant after the read) leaves it in notRestored and untouched, with no audit for it", async () => {
    seedSingles();
    // someone unclaims + reclaims s2 with a NEW started_at between the action's read and its write
    db.hooks.beforeWrite = (call, d) => {
      if (targets(call)[0] === "s2") d.row("test_requests", "s2").started_at = pg("2026-09-30T11:59:40.000Z");
    };
    const r = await run();

    expect(r).toEqual({
      ok: true,
      restoredIds: ["s1"],
      restoredTestCount: 1,
      notRestored: [{ id: "s2", reason: MOVED_ON }],
    });
    expect(db.row("test_requests", "s2")).toMatchObject({ status: "in_progress", assigned_to: "user-admin" });
    expect(auditsOf("test_request.unclaimed").map((a) => a.resource_id)).toEqual(["s1"]);
  });

  describe("(c) a single-row un-claim retries its write once on a lost lifecycle race", () => {
    const isUnclaimWrite = (patch: Row) => patch.status === "requested";

    it("a P0072 on the first write is retried and the test is un-claimed, audited once", async () => {
      seedSingles();
      lifecycleRaceOnUpdates(db, isUnclaimWrite, 1);
      const r = await run();

      expect(r).toEqual({ ok: true, restoredIds: ["s1", "s2"], restoredTestCount: 2, notRestored: [] });
      // s1 is written twice (the lost race, then the retry); s2 once
      expect(db.updates("test_requests").map(targets)).toEqual([["s1"], ["s1"], ["s2"]]);
      expect(db.row("test_requests", "s1")).toMatchObject({ status: "requested", assigned_to: null, started_at: null });
      expect(auditsOf("test_request.unclaimed").map((a) => a.resource_id)).toEqual(["s1", "s2"]);
    });

    it("a second P0072 is reported as not restored — exactly one retry, the row untouched, nothing audited for it", async () => {
      seedSingles();
      lifecycleRaceOnUpdates(db, isUnclaimWrite, 2);
      const r = await run();

      expect(r).toEqual({
        ok: true,
        restoredIds: ["s2"],
        restoredTestCount: 1,
        notRestored: [{ id: "s1", reason: MOVED_ON }],
      });
      expect(db.updates("test_requests").map(targets)).toEqual([["s1"], ["s1"], ["s2"]]);
      expect(db.row("test_requests", "s1")).toMatchObject({ status: "in_progress", assigned_to: "user-admin" });
      expect(auditsOf("test_request.unclaimed").map((a) => a.resource_id)).toEqual(["s2"]);
    });
  });

  it("a row whose read shows a different started_at is refused before any write", async () => {
    seedSingles();
    db.row("test_requests", "s1").started_at = pg("2026-09-30T11:59:00.000Z");
    const r = await run();
    expect(r).toMatchObject({ restoredIds: ["s2"], restoredTestCount: 1, notRestored: [{ id: "s1", reason: MOVED_ON }] });
    expect(db.updates("test_requests").map(targets)).toEqual([["s2"]]);
  });

  it("a mixed selection counts TESTS: a 3-member panel plus one single restores 4", async () => {
    db.seed("test_requests", [
      tr("m1", { status: "in_progress", assigned_to: "user-admin", started_at: pg(S1) }),
      tr("m2", { status: "in_progress", assigned_to: "user-admin", started_at: pg(S1) }),
      tr("m3", { status: "in_progress", assigned_to: "user-admin", started_at: pg(S1) }),
      tr("s1", { status: "in_progress", assigned_to: "user-admin", started_at: pg(S1) }),
    ]);
    db.seed("audit_log", [claimed("s1", S1, null), claimed("m1", S1), claimed("m2", S1), claimed("m3", S1)]);
    const r = await run();
    expect(r).toEqual({ ok: true, restoredIds: ["s1", KEY], restoredTestCount: 4, notRestored: [] });
  });
});

// ---------------------------------------------------------------------------
// unclaimed -> reclaim, each member back to its OWN holder
// ---------------------------------------------------------------------------
describe("Undo of a bulk Unclaim: reclaim", () => {
  const A = "user-a";
  const B = "user-b";
  const TA1 = "2026-09-30T11:50:01.000Z";
  const TA2 = "2026-09-30T11:50:02.000Z";
  const TB1 = "2026-09-30T11:50:03.000Z";

  function seedSplitPanel() {
    db.seed("test_requests", [tr("a1"), tr("b1"), tr("a2")]);
    // Order matters: [a1, b1, a2] — the members of ONE holder are not adjacent.
    db.seed("audit_log", [unclaimed("a1", A, TA1), unclaimed("b1", B, TB1), unclaimed("a2", A, TA2)]);
    db.seed("staff_profiles", [profile(A), profile(B)]);
  }

  it("(a) puts a panel back in ONE reclaim_panel_members call: each member under ITS OWN holder at ITS OWN started_at, audited per member", async () => {
    seedSplitPanel();
    const r = await run();

    expect(r).toEqual({ ok: true, restoredIds: [KEY], restoredTestCount: 3, notRestored: [] });
    // exactly one rpc, parallel arrays in the audit's member order, each holder and started_at its own
    expect(db.rpcCalls).toEqual([
      {
        fn: "reclaim_panel_members",
        args: { p_test_request_ids: ["a1", "b1", "a2"], p_holders: [A, B, A], p_started_at: [TA1, TB1, TA2] },
      },
    ]);
    expect(db.row("test_requests", "a1")).toMatchObject({ status: "in_progress", assigned_to: A, started_at: TA1 });
    expect(db.row("test_requests", "a2")).toMatchObject({ status: "in_progress", assigned_to: A, started_at: TA2 });
    expect(db.row("test_requests", "b1")).toMatchObject({ status: "in_progress", assigned_to: B, started_at: TB1 });
    // the panel goes through the rpc only — no per-row update, so nothing to compensate
    expect(db.updates("test_requests")).toEqual([]);

    const rows = auditsOf("test_request.reassigned");
    expect(rows.map((a) => [a.resource_id, meta(a).to])).toEqual([
      ["a1", A],
      ["b1", B],
      ["a2", A],
    ]);
    const newBatch = meta(rows[0]!).bulk_batch_id;
    expect(newBatch).toMatch(/^[0-9a-f-]{36}$/);
    expect(newBatch).not.toBe(BATCH);
    for (const a of rows) {
      expect(a).toMatchObject({ actor_id: "user-admin", actor_type: "staff", resource_type: "test_request" });
      expect(meta(a)).toMatchObject({
        from: null,
        via: BULK_UNDO_VIA,
        undo_of_batch: BATCH,
        bulk_batch_id: newBatch,
        panel_key: KEY,
        visit_id: VISIT,
      });
      expect(meta(a)).not.toHaveProperty("partial_panel");
    }
    expect(auditCalls()).toHaveLength(3);
    expect(revalidated()).toEqual(
      expect.arrayContaining(["/staff/queue", "/staff/queue/a1", "/staff/queue/b1", "/staff/queue/a2", `/staff/queue/consolidated/${VISIT}/${GROUP}`]),
    );
  });

  it("(a) hands the rpc a null started_at for a member whose audit row has none (the database then uses now()), and the exact string for the rest", async () => {
    db.seed("test_requests", [tr("a1"), tr("a2")]);
    db.seed("audit_log", [unclaimed("a1", A, "2026-09-30T11:50:01.123456Z"), unclaimed("a2", A, null)]);
    db.seed("staff_profiles", [profile(A)]);
    await run();
    // the microsecond string is passed through untouched — never round-tripped through Date
    expect(db.rpcCalls[0]!.args.p_started_at).toEqual(["2026-09-30T11:50:01.123456Z", null]);
  });

  it("checks BOTH holders are usable, not just the first member's", async () => {
    seedSplitPanel();
    await run();
    const profileReads = db.selects("staff_profiles");
    expect(profileReads).toHaveLength(1);
    const ids = profileReads[0]!.filters.find(([n]) => n === "in")![1][1] as string[];
    expect([...ids].sort()).toEqual([A, B]);
  });

  it.each([
    ["deactivated", { is_active: false }],
    ["deleted", { deleted_at: "2026-09-29T00:00:00+00:00" }],
    ["moved to a role that is not lab staff", { role: "reception" }],
  ])("refuses the WHOLE panel with no writes when one member's holder is %s", async (_n, patch) => {
    seedSplitPanel();
    Object.assign(db.row("staff_profiles", B), patch);
    const r = await run();
    expect(r).toEqual({ ok: true, restoredIds: [], restoredTestCount: 0, notRestored: [{ id: KEY, reason: HOLDER_UNUSABLE }] });
    expectNoWrites();
    expect(db.row("test_requests", "a1")).toMatchObject({ status: "requested", assigned_to: null });
  });

  it("refuses when a holder has no profile row at all", async () => {
    seedSplitPanel();
    db.tables.staff_profiles = [profile(A)];
    const r = await run();
    expect(r).toMatchObject({ restoredIds: [], notRestored: [{ id: KEY, reason: HOLDER_UNUSABLE }] });
    expectNoWrites();
  });

  it("refuses a holder who may not claim that section (medtech cannot hold x-ray)", async () => {
    seedSplitPanel();
    db.row("test_requests", "a2").services = { section: "imaging_xray", kind: "lab_test", name: "x", code: "x" };
    const r = await run();
    expect(r).toMatchObject({ restoredIds: [], notRestored: [{ id: KEY, reason: STATE_MOVED }] });
    expectNoWrites();
  });

  it("refuses a member somebody else has claimed since, before any write", async () => {
    seedSplitPanel();
    Object.assign(db.row("test_requests", "b1"), { status: "in_progress", assigned_to: "user-c" });
    const r = await run();
    expect(r).toMatchObject({ restoredIds: [], notRestored: [{ id: KEY, reason: STATE_MOVED }] });
    expectNoWrites();
  });

  it("re-applies the payment gate: a visit whose payment was voided since is refused with the waiting-for-payment hint", async () => {
    seedSplitPanel();
    db.row("test_requests", "a1").visits = { deleted_at: null, payment_status: "unpaid", hmo_provider_id: null };
    const r = await run();
    expect(r).toMatchObject({ restoredIds: [], notRestored: [{ id: KEY, reason: expect.stringContaining("waiting for payment") }] });
    expectNoWrites();
  });

  it("falls back to now() only when the audit row has no previous_started_at", async () => {
    db.seed("test_requests", [tr("s1")]);
    db.seed("audit_log", [unclaimed("s1", A, null, null)]);
    db.seed("staff_profiles", [profile(A)]);
    const r = await run();
    expect(r).toMatchObject({ restoredIds: ["s1"] });
    expect(db.row("test_requests", "s1")).toMatchObject({ assigned_to: A, started_at: iso(0) });
  });

  describe("a lost race is refused whole by the database — nothing to compensate", () => {
    /** Someone else takes a2 in the instant before the rpc's rule runs. */
    const a2TakenInsideRpc = () =>
      raceBeforeRpc(db, "reclaim_panel_members", (d) =>
        Object.assign(d.row("test_requests", "a2"), { status: "in_progress", assigned_to: "user-c", started_at: pg(TA1) }),
      );

    it("puts the panel in notRestored with the P0082 message, leaves EVERY member as it was, and writes no audit", async () => {
      seedSplitPanel();
      a2TakenInsideRpc();
      const r = await run();

      expect(r).toEqual({ ok: true, restoredIds: [], restoredTestCount: 0, notRestored: [{ id: KEY, reason: RECLAIM_P0082 }] });
      expect(db.row("test_requests", "a1")).toMatchObject({ status: "requested", assigned_to: null, started_at: null });
      expect(db.row("test_requests", "b1")).toMatchObject({ status: "requested", assigned_to: null, started_at: null });
      // a2 is somebody else's and stays theirs
      expect(db.row("test_requests", "a2")).toMatchObject({ status: "in_progress", assigned_to: "user-c" });
      // one rpc, no per-row write and no compensating revert
      expect(db.rpcCalls).toHaveLength(1);
      expect(db.updates("test_requests")).toEqual([]);
      expect(h.audit).not.toHaveBeenCalled();
      expect(revalidated()).toEqual([]);
    });

    it("a member deleted in that instant is refused the same way", async () => {
      seedSplitPanel();
      raceBeforeRpc(db, "reclaim_panel_members", (d) => {
        d.row("test_requests", "b1").deleted_at = "2026-09-30T11:59:59+00:00";
      });
      const r = await run();
      expect(r).toEqual({ ok: true, restoredIds: [], restoredTestCount: 0, notRestored: [{ id: KEY, reason: RECLAIM_P0082 }] });
      expect(db.row("test_requests", "a1")).toMatchObject({ status: "requested", assigned_to: null });
      expect(h.audit).not.toHaveBeenCalled();
    });

    it("one panel refused by the database does not stop another panel of the same batch", async () => {
      seedSplitPanel();
      db.seed("test_requests", [tr("n1", { visit_id: VISIT_2 }), tr("n2", { visit_id: VISIT_2 })]);
      db.seed(
        "audit_log",
        [unclaimed("n1", A, TA1, KEY_2), unclaimed("n2", A, TA2, KEY_2)].map((row) => ({
          ...row,
          metadata: { ...(row.metadata as Row), visit_id: VISIT_2 },
        })),
      );
      a2TakenInsideRpc();
      const r = await run();
      expect(r).toEqual({
        ok: true,
        restoredIds: [KEY_2],
        restoredTestCount: 2,
        notRestored: [{ id: KEY, reason: RECLAIM_P0082 }],
      });
      expect(db.row("test_requests", "n1")).toMatchObject({ status: "in_progress", assigned_to: A });
      expect(auditsOf("test_request.reassigned").map((a) => a.resource_id)).toEqual(["n1", "n2"]);
    });

    it("a lifecycle race (P0072) on the rpc is retried once and then succeeds", async () => {
      seedSplitPanel();
      let calls = 0;
      const real = db.hooks.rpc!;
      db.hooks.rpc = (rec, d) => {
        if (rec.fn === "reclaim_panel_members" && (calls += 1) === 1) return { error: { code: "P0072", message: "moved" } };
        return real(rec, d);
      };
      const r = await run();
      expect(r).toEqual({ ok: true, restoredIds: [KEY], restoredTestCount: 3, notRestored: [] });
      expect(db.rpcCalls.map((c) => c.fn)).toEqual(["reclaim_panel_members", "reclaim_panel_members"]);
      expect(auditsOf("test_request.reassigned")).toHaveLength(3);
    });
  });

  describe("(c) a single-row reclaim retries its write once on a lost lifecycle race", () => {
    function seedSingle() {
      db.seed("test_requests", [tr("s1")]);
      db.seed("audit_log", [unclaimed("s1", A, TA1, null)]);
      db.seed("staff_profiles", [profile(A)]);
    }
    const isReclaimWrite = (patch: Row) => patch.status === "in_progress";

    it("a P0072 on the first write is retried and the test is put back, audited once", async () => {
      seedSingle();
      lifecycleRaceOnUpdates(db, isReclaimWrite, 1);
      const r = await run();

      expect(r).toEqual({ ok: true, restoredIds: ["s1"], restoredTestCount: 1, notRestored: [] });
      expect(db.updates("test_requests").filter((c) => isReclaimWrite(c.patch!))).toHaveLength(2);
      expect(db.row("test_requests", "s1")).toMatchObject({ status: "in_progress", assigned_to: A, started_at: TA1 });
      expect(auditsOf("test_request.reassigned")).toHaveLength(1);
    });

    it("a real write error (P0075, the claim-holder guard) is reported with its own message, not the generic moved-on text", async () => {
      seedSingle();
      const message = "Only an X-ray Technician can hold this test.";
      db.hooks.beforeWrite = (call) => {
        if (call.table === "test_requests" && call.patch && isReclaimWrite(call.patch)) return { code: "P0075", message };
      };
      const r = await run();

      expect(r).toEqual({ ok: true, restoredIds: [], restoredTestCount: 0, notRestored: [{ id: "s1", reason: message }] });
      expect(db.updates("test_requests").filter((c) => isReclaimWrite(c.patch!))).toHaveLength(1); // P0075 is not a retryable race
      expect(db.row("test_requests", "s1")).toMatchObject({ status: "requested", assigned_to: null });
      expect(h.audit).not.toHaveBeenCalled();
    });

    it("a write that matches no row (someone claimed it in the instant) still reads as the plain moved-on reason", async () => {
      seedSingle();
      db.hooks.beforeWrite = (call, d) => {
        if (call.patch && isReclaimWrite(call.patch)) Object.assign(d.row("test_requests", "s1"), { status: "in_progress", assigned_to: "user-c" });
      };
      const r = await run();
      expect(r).toEqual({ ok: true, restoredIds: [], restoredTestCount: 0, notRestored: [{ id: "s1", reason: STATE_MOVED }] });
    });

    it("a second P0072 is reported as not restored, with the row untouched and nothing audited", async () => {
      seedSingle();
      lifecycleRaceOnUpdates(db, isReclaimWrite, 2);
      const r = await run();

      // the second loss is shown as the lifecycle message (translatePgError), not the plain moved-on text
      expect(r).toEqual({
        ok: true,
        restoredIds: [],
        restoredTestCount: 0,
        notRestored: [{ id: "s1", reason: "This patient's records changed while you were saving. Please try again." }],
      });
      expect(db.updates("test_requests").filter((c) => isReclaimWrite(c.patch!))).toHaveLength(2); // exactly one retry, never more
      expect(db.row("test_requests", "s1")).toMatchObject({ status: "requested", assigned_to: null });
      expect(h.audit).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// deleted -> restore
// ---------------------------------------------------------------------------
describe("Undo of a bulk Delete: restore", () => {
  // Microseconds on purpose: the exact string must reach the rpc (Date would cut it to ms).
  const D = "2026-09-30T11:58:00.123456Z";

  function seedDeletedPanel(visitId = VISIT, ids = ["d1", "d2", "d3"], key = KEY) {
    db.seed(
      "test_requests",
      ids.map((id) =>
        tr(id, {
          visit_id: visitId,
          deleted_at: pg(D),
          deleted_by: "user-rec",
          delete_reason: "entered on the wrong visit",
        }),
      ),
    );
    db.seed(
      "audit_log",
      ids.map((id) => deleted(id, D, key, visitId)),
    );
  }

  beforeEach(() => {
    h.session = { user_id: "user-rec", role: "reception" };
  });

  it("(b) restores a deleted panel in ONE restore_panel_members call with the row's own deleted_at strings, and audits each member", async () => {
    seedDeletedPanel();
    const r = await run();

    expect(r).toEqual({ ok: true, restoredIds: [KEY], restoredTestCount: 3, notRestored: [] });
    // one call per panel, carrying the spelling the ROW has (the pre-check proved it is the audit's instant) —
    // microseconds intact, never round-tripped through Date
    expect(db.rpcCalls).toEqual([
      { fn: "restore_panel_members", args: { p_visit_id: VISIT, p_test_request_ids: ["d1", "d2", "d3"], p_deleted_at: [pg(D), pg(D), pg(D)] } },
    ]);
    for (const id of ["d1", "d2", "d3"]) {
      expect(db.row("test_requests", id)).toMatchObject({ deleted_at: null, deleted_by: null, delete_reason: null });
    }
    // the same active-patient rule a single Restore applies, asked of the panel's visit BEFORE the rpc
    expect(h.patientActive).toHaveBeenCalledWith(expect.anything(), VISIT);
    // the panel goes through the rpc only — no per-row update, so nothing to compensate
    expect(db.updates("test_requests")).toEqual([]);

    const rows = auditsOf("test_request.restored");
    expect(rows.map((a) => a.resource_id)).toEqual(["d1", "d2", "d3"]);
    const newBatch = meta(rows[0]!).bulk_batch_id;
    expect(newBatch).not.toBe(BATCH);
    for (const a of rows) {
      expect(a).toMatchObject({ actor_id: "user-rec", patient_id: "patient-1" });
      expect(meta(a)).toMatchObject({
        visit_id: VISIT,
        reason: "Undo of a bulk delete",
        via: BULK_UNDO_VIA,
        undo_of_batch: BATCH,
        bulk_batch_id: newBatch,
        panel_key: KEY,
        prior_delete_reason: "entered on the wrong visit",
        prior_deleted_at: pg(D),
      });
    }
    expect(auditsOf("test_request.deleted")).toEqual([]);
    expect(revalidated()).toEqual(expect.arrayContaining(["/staff/queue", `/staff/queue/consolidated/${VISIT}/${GROUP}`]));
  });

  it("(b) a restore calls only restore_panel_members — never the un-claim or reclaim functions", async () => {
    seedDeletedPanel();
    await run();
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["restore_panel_members"]);
  });

  it("(b) one rpc call per panel: two panels on two visits make two calls, each on its own visit", async () => {
    seedDeletedPanel(VISIT, ["d1", "d2"], KEY);
    seedDeletedPanel(VISIT_2, ["e1", "e2"], KEY_2);
    const r = await run();
    expect(r).toEqual({ ok: true, restoredIds: [KEY, KEY_2], restoredTestCount: 4, notRestored: [] });
    expect(db.rpcCalls.map((c) => [c.fn, c.args.p_visit_id, c.args.p_test_request_ids])).toEqual([
      ["restore_panel_members", VISIT, ["d1", "d2"]],
      ["restore_panel_members", VISIT_2, ["e1", "e2"]],
    ]);
    expect(h.patientActive.mock.calls.map((c) => (c as unknown[])[1])).toEqual([VISIT, VISIT_2]);
  });

  it("refuses the whole panel, with no writes, when one member's deleted_at differs (restored and re-deleted since)", async () => {
    seedDeletedPanel();
    db.row("test_requests", "d2").deleted_at = pg("2026-09-30T11:59:10.000Z");
    const r = await run();

    expect(r).toEqual({ ok: true, restoredIds: [], restoredTestCount: 0, notRestored: [{ id: KEY, reason: PANEL_CHANGED }] });
    expectNoWrites();
    expect(db.row("test_requests", "d1").deleted_at).toBe(pg(D)); // the other members stay deleted
  });

  it("refuses a panel one of whose members was already restored by someone else", async () => {
    seedDeletedPanel();
    db.row("test_requests", "d3").deleted_at = null;
    const r = await run();
    expect(r).toMatchObject({ restoredIds: [], notRestored: [{ id: KEY, reason: PANEL_CHANGED }] });
    expectNoWrites();
  });

  it("refuses a member whose audit row carries no deleted_at (predates the exact-predicate fix)", async () => {
    seedDeletedPanel();
    db.tables.audit_log = ["d1", "d2", "d3"].map((id) => deleted(id, id === "d2" ? null : D));
    const r = await run();
    expect(r).toMatchObject({ restoredIds: [], notRestored: [{ id: KEY, reason: PANEL_CHANGED }] });
    expectNoWrites();
  });

  it("refuses a PANEL when the patient is inactive — with the patient message, before the rpc — and writes nothing", async () => {
    seedDeletedPanel();
    h.patientActive.mockResolvedValue({ ok: false, error: "This patient record is deleted." });
    const r = await run();
    expect(r).toEqual({
      ok: true,
      restoredIds: [],
      restoredTestCount: 0,
      notRestored: [{ id: KEY, reason: "This patient record is deleted." }],
    });
    expect(h.patientActive).toHaveBeenCalledWith(expect.anything(), VISIT);
    expectNoWrites();
    expect(db.row("test_requests", "d1").deleted_at).toBe(pg(D));
  });

  it("refuses a SINGLE test when the patient is inactive (restore refused by the core), with the patient message, and writes nothing", async () => {
    db.seed("test_requests", [tr("only", { deleted_at: pg(D), deleted_by: "user-rec", delete_reason: "dup" })]);
    db.seed("audit_log", [deleted("only", D, null)]);
    h.patientActive.mockResolvedValue({ ok: false, error: "This patient record is deleted." });
    const r = await run();
    // the core's own reason reaches the operator, not the generic "already restored or changed"
    expect(r).toEqual({
      ok: true,
      restoredIds: [],
      restoredTestCount: 0,
      notRestored: [{ id: "only", reason: "This patient record is deleted." }],
    });
    expectNoWrites();
  });

  it("a single test's restore that the core refuses names the core's reason for that test only; a good single on another visit is still restored", async () => {
    db.seed("test_requests", [
      tr("only", { deleted_at: pg(D), deleted_by: "user-rec", delete_reason: "dup" }),
      tr("other", { visit_id: VISIT_2, deleted_at: pg(D), deleted_by: "user-rec", delete_reason: "dup" }),
    ]);
    db.seed("audit_log", [deleted("only", D, null), deleted("other", D, null, VISIT_2)]);
    h.patientActive.mockImplementation(async (_db?: unknown, visitId?: string) =>
      visitId === VISIT ? { ok: false, error: "This patient record is deleted." } : { ok: true },
    );
    const r = await run();
    expect(r).toEqual({
      ok: true,
      restoredIds: ["other"],
      restoredTestCount: 1,
      notRestored: [{ id: "only", reason: "This patient record is deleted." }],
    });
    expect(db.row("test_requests", "only").deleted_at).toBe(pg(D));
    expect(db.row("test_requests", "other").deleted_at).toBeNull();
  });

  it("only the panel's own visit is asked about — a stale-refused panel is never checked or written", async () => {
    seedDeletedPanel();
    db.row("test_requests", "d2").deleted_at = pg("2026-09-30T11:59:10.000Z");
    await run();
    expect(h.patientActive).not.toHaveBeenCalled();
  });

  it("restores a single deleted test (no panel) under its own id", async () => {
    db.seed("test_requests", [tr("only", { deleted_at: pg(D), deleted_by: "user-rec", delete_reason: "dup" })]);
    db.seed("audit_log", [deleted("only", D, null)]);
    const r = await run();
    expect(r).toEqual({ ok: true, restoredIds: ["only"], restoredTestCount: 1, notRestored: [] });
    expect(db.row("test_requests", "only").deleted_at).toBeNull();
    expect(revalidated()).not.toContain(`/staff/queue/consolidated/${VISIT}/${GROUP}`);
  });

  it("one stale panel does not stop a good one on another visit; the count is only the restored one's tests", async () => {
    seedDeletedPanel(VISIT, ["d1", "d2", "d3"], KEY);
    seedDeletedPanel(VISIT_2, ["e1", "e2"], KEY_2);
    db.row("test_requests", "d1").deleted_at = pg("2026-09-30T11:59:59.000Z");
    const r = await run();
    expect(r).toEqual({
      ok: true,
      restoredIds: [KEY_2],
      restoredTestCount: 2,
      notRestored: [{ id: KEY, reason: PANEL_CHANGED }],
    });
    expect(db.row("test_requests", "e1").deleted_at).toBeNull();
    expect(db.row("test_requests", "d2").deleted_at).toBe(pg(D));
  });

  it("a race that changes one member between the pre-check and the write leaves EVERY member deleted (P0082) — nothing restored, nothing to put back, no audit", async () => {
    seedDeletedPanel();
    // d3 is restored and re-deleted (new deleted_at) in the instant before the rpc's rule runs
    raceBeforeRpc(db, "restore_panel_members", (d) => {
      d.row("test_requests", "d3").deleted_at = pg("2026-09-30T11:59:50.000Z");
    });
    const r = await run();

    expect(r).toEqual({ ok: true, restoredIds: [], restoredTestCount: 0, notRestored: [{ id: KEY, reason: RESTORE_P0082 }] });
    for (const id of ["d1", "d2"]) {
      expect(db.row("test_requests", id)).toMatchObject({
        deleted_at: pg(D),
        deleted_by: "user-rec",
        delete_reason: "entered on the wrong visit",
      });
    }
    expect(db.row("test_requests", "d3").deleted_at).toBe(pg("2026-09-30T11:59:50.000Z"));
    // no per-row write, no compensating re-delete, and no audit of any kind
    expect(db.updates("test_requests")).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
    expect(revalidated()).toEqual([]);
  });

  it("a stale panel refused by the database does not stop a good panel on another visit", async () => {
    seedDeletedPanel(VISIT, ["d1", "d2"], KEY);
    seedDeletedPanel(VISIT_2, ["e1", "e2"], KEY_2);
    raceBeforeRpc(db, "restore_panel_members", (d) => {
      d.row("test_requests", "d1").deleted_at = pg("2026-09-30T11:59:50.000Z");
    });
    const r = await run();
    expect(r).toEqual({
      ok: true,
      restoredIds: [KEY_2],
      restoredTestCount: 2,
      notRestored: [{ id: KEY, reason: RESTORE_P0082 }],
    });
    expect(db.row("test_requests", "e1").deleted_at).toBeNull();
    expect(db.row("test_requests", "d2").deleted_at).toBe(pg(D));
    expect(auditsOf("test_request.restored").map((a) => a.resource_id)).toEqual(["e1", "e2"]);
  });

  it("(d) singles in a restore batch still go through restoreTestRequestsForVisit (an exact-deleted_at update, no rpc); only the panel uses the rpc", async () => {
    seedDeletedPanel();
    db.seed("test_requests", [
      tr("x1", { deleted_at: pg(D), deleted_by: "user-rec", delete_reason: "dup" }),
      tr("x2", { deleted_at: pg(D), deleted_by: "user-rec", delete_reason: "dup" }),
    ]);
    db.seed("audit_log", [deleted("x1", D, null), deleted("x2", D, null)]);
    const r = await run();

    expect(r).toEqual({ ok: true, restoredIds: [KEY, "x1", "x2"], restoredTestCount: 5, notRestored: [] });
    // the rpc carries the panel's members and nothing else
    expect(db.rpcCalls).toEqual([
      { fn: "restore_panel_members", args: { p_visit_id: VISIT, p_test_request_ids: ["d1", "d2", "d3"], p_deleted_at: [pg(D), pg(D), pg(D)] } },
    ]);
    // the singles are restored by the core's conditional update, pinned to deleted_at
    const writes = db.updates("test_requests");
    expect(writes).toHaveLength(1);
    expect(targets(writes[0]!)).toEqual(["x1", "x2"]);
    expect(writes[0]!.filters).toContainEqual(["eq", ["deleted_at", pg(D)]]);
    expect(writes[0]!.filters).toContainEqual(["eq", ["visit_id", VISIT]]);
    for (const id of ["x1", "x2", "d1", "d2", "d3"]) expect(db.row("test_requests", id).deleted_at).toBeNull();
    expect(auditsOf("test_request.restored").map((a) => a.resource_id).sort()).toEqual(["d1", "d2", "d3", "x1", "x2"]);
  });
});

// ---------------------------------------------------------------------------
// guards
// ---------------------------------------------------------------------------
describe("Undo guards", () => {
  const S1 = "2026-09-30T11:58:01.000Z";

  function seedPanelClaim() {
    db.seed("test_requests", [
      tr("m1", { status: "in_progress", assigned_to: "user-admin", started_at: pg(S1) }),
      tr("m2", { status: "in_progress", assigned_to: "user-admin", started_at: pg(S1) }),
    ]);
    db.seed("audit_log", [claimed("m1", S1), claimed("m2", S1)]);
  }

  it("refuses a batch older than 10 minutes with the expired error and touches nothing", async () => {
    seedPanelClaim();
    for (const a of db.rows("audit_log")) a.created_at = new Date(NOW - UNDO_WINDOW_MS - 1_000).toISOString();
    expect(await run()).toEqual({ ok: false, error: UNDO_EXPIRED });
    expectNoWrites();
  });

  it("still allows a batch at nine minutes", async () => {
    seedPanelClaim();
    for (const a of db.rows("audit_log")) a.created_at = new Date(NOW - 9 * 60_000).toISOString();
    expect(await run()).toMatchObject({ ok: true, restoredIds: [KEY] });
  });

  it("refuses a batch that was already undone (any undo row naming it), even one written by someone else", async () => {
    seedPanelClaim();
    db.seed("audit_log", [
      {
        id: "u-1",
        actor_id: "user-admin",
        resource_type: "test_request",
        resource_id: "m1",
        action: "test_request.unclaimed",
        metadata: { via: BULK_UNDO_VIA, undo_of_batch: BATCH, bulk_batch_id: "some-new-batch" },
        created_at: iso(30_000),
      },
    ]);
    expect(await run()).toEqual({ ok: false, error: UNDO_ALREADY });
    expectNoWrites();
  });

  it("an Undo of a different batch does not make this one 'already undone'", async () => {
    seedPanelClaim();
    db.seed("audit_log", [
      {
        id: "u-1",
        actor_id: "user-admin",
        resource_type: "test_request",
        resource_id: "zz",
        action: "test_request.unclaimed",
        metadata: { undo_of_batch: "another-batch" },
        created_at: iso(30_000),
      },
    ]);
    expect(await run()).toMatchObject({ ok: true, restoredIds: [KEY] });
  });

  it("finds nothing for a batch that belongs to another actor — it reads as expired, and nothing is written", async () => {
    seedPanelClaim();
    for (const a of db.rows("audit_log")) a.actor_id = "user-someone-else";
    expect(await run()).toEqual({ ok: false, error: UNDO_EXPIRED });
    expectNoWrites();
    expect(db.row("test_requests", "m1")).toMatchObject({ status: "in_progress" });
  });

  it("refuses a group when a member has a LATER audit row that is not part of this batch (changedSince), and still undoes the others", async () => {
    seedPanelClaim();
    db.seed("test_requests", [tr("s1", { status: "in_progress", assigned_to: "user-admin", started_at: pg(S1) })]);
    db.seed("audit_log", [claimed("s1", S1, null)]);
    db.seed("audit_log", [
      {
        id: "z-1",
        actor_id: "user-other",
        resource_type: "test_request",
        resource_id: "m2",
        action: "test_request.reassigned",
        metadata: { from: "user-admin", to: "user-other" },
        created_at: iso(30_000),
      },
    ]);
    const r = await run();
    expect(r).toEqual({
      ok: true,
      restoredIds: ["s1"],
      restoredTestCount: 1,
      notRestored: [{ id: KEY, reason: CHANGED_SINCE }],
    });
    expect(db.rpcCalls).toEqual([]); // the panel never reached the rpc
    expect(db.row("test_requests", "m1")).toMatchObject({ status: "in_progress" });
  });

  it("a later audit row from the batch ITSELF is not a change", async () => {
    seedPanelClaim();
    db.seed("audit_log", [claimed("m2", S1)]); // a second row for m2, same batch, later
    expect(await run()).toMatchObject({ ok: true, restoredIds: [KEY] });
  });

  it("changedSince also refuses a reclaim group and a restore group", async () => {
    // reclaim
    db.seed("test_requests", [tr("a1")]);
    db.seed("audit_log", [unclaimed("a1", "user-a", S1, null)]);
    db.seed("staff_profiles", [profile("user-a")]);
    db.seed("audit_log", [
      { id: "z-1", actor_id: "user-other", resource_type: "test_request", resource_id: "a1", action: "test_request.claimed", metadata: {}, created_at: iso(30_000) },
    ]);
    expect(await run()).toMatchObject({ restoredIds: [], notRestored: [{ id: "a1", reason: CHANGED_SINCE }] });
    expectNoWrites();

    // restore
    db = new FakeDb();
    h.db = db;
    h.audit.mockClear();
    h.session = { user_id: "user-rec", role: "reception" };
    db.seed("test_requests", [tr("d1", { deleted_at: pg("2026-09-30T11:58:00.000Z") })]);
    db.seed("audit_log", [deleted("d1", "2026-09-30T11:58:00.000Z", null)]);
    db.seed("audit_log", [
      { id: "z-2", actor_id: "user-other", resource_type: "test_request", resource_id: "d1", action: "test_request.restored", metadata: {}, created_at: iso(30_000) },
    ]);
    expect(await run()).toMatchObject({ restoredIds: [], notRestored: [{ id: "d1", reason: CHANGED_SINCE }] });
    expectNoWrites();
  });

  it("a role that can do none of claim / unclaim / delete is refused before ANY read of the batch", async () => {
    seedPanelClaim();
    h.session = { user_id: "user-admin", role: "accountant" };
    expect(await run()).toEqual({ ok: false, error: ROLE_CHANGED });
    expect(db.calls).toEqual([]); // not even the audit_log existence probe
    expectNoWrites();
  });

  it("reception cannot undo a Claim, and a medtech cannot undo a Delete: every group is refused, nothing is written", async () => {
    seedPanelClaim();
    h.session = { user_id: "user-admin", role: "reception" };
    expect(await run()).toEqual({
      ok: true,
      restoredIds: [],
      restoredTestCount: 0,
      notRestored: [{ id: KEY, reason: ROLE_CHANGED }],
    });
    expectNoWrites();

    db = new FakeDb();
    h.db = db;
    h.audit.mockClear();
    h.session = { user_id: "user-med", role: "medtech" };
    db.seed("test_requests", [tr("d1", { deleted_at: pg("2026-09-30T11:58:00.000Z") })]);
    db.seed("audit_log", [deleted("d1", "2026-09-30T11:58:00.000Z", null)]);
    expect(await run()).toEqual({
      ok: true,
      restoredIds: [],
      restoredTestCount: 0,
      notRestored: [{ id: "d1", reason: ROLE_CHANGED }],
    });
    expectNoWrites();
    expect(db.row("test_requests", "d1").deleted_at).not.toBeNull();
  });

  it("rejects a malformed batch id before reading anything", async () => {
    expect(await undoBulkQueueAction({ batchId: "not-a-uuid" })).toEqual({ ok: false, error: UNDO_EXPIRED });
    expect(await undoBulkQueueAction({})).toEqual({ ok: false, error: UNDO_EXPIRED });
    expect(db.calls).toEqual([]);
  });

  it("a batch whose audit rows plan to nothing (no queue action in it) reads as expired", async () => {
    db.seed("audit_log", [batchAudit("test_request.reassigned", "m1", {})]);
    expect(await run()).toEqual({ ok: false, error: UNDO_EXPIRED });
    expectNoWrites();
  });
});
