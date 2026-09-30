import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * loadOwnBatchRows against the in-memory fake client (src/lib/testing/fake-db):
 * the read the bulk Undo's whole safety story rests on. Pinned here:
 *   - the main read is the CALLER's OWN rows for ONE batch and resource type;
 *   - the 10-minute deadline is ONE decision from the batch's earliest row,
 *     compared as instants (PostgREST's "+00:00" vs JS's "Z");
 *   - changedSince = a NEWER audit row (any actor, any action) on one of the
 *     batch's resources that is not itself part of the batch — read in
 *     IN_CHUNK slices, paged past 1000 rows, and failing CLOSED.
 */

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.client }));

import { loadOwnBatchRows } from "./bulk-batch";
import { FakeDb, type Row } from "@/lib/testing/fake-db";
import { UNDO_EXPIRED, UNDO_WINDOW_MS } from "@/lib/ui/bulk-undo";
import { IN_CHUNK } from "@/lib/supabase/in-chunks";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const ACTOR = "actor-1";
const BATCH = "batch-1";
const READ_FAILED = "Could not read what that bulk change did — try again.";

let db: FakeDb;
let seq = 0;

function audit(over: Row): Row {
  seq += 1;
  return {
    id: `a-${String(seq).padStart(5, "0")}`,
    actor_id: ACTOR,
    resource_type: "test_request",
    resource_id: "r1",
    action: "test_request.claimed",
    metadata: { bulk_batch_id: BATCH },
    created_at: iso(60_000),
    ...over,
  };
}

const load = (over: Partial<Parameters<typeof loadOwnBatchRows>[0]> = {}) =>
  loadOwnBatchRows({ actorId: ACTOR, batchId: BATCH, resourceType: "test_request", nowMs: NOW, ...over });

beforeEach(() => {
  db = new FakeDb();
  h.client = db.client();
  seq = 0;
});

describe("the main read: the caller's own rows for one batch", () => {
  it("returns only this actor's rows of this resource type and batch, oldest first, projected", async () => {
    db.seed("audit_log", [
      audit({ resource_id: "r2", created_at: iso(30_000), metadata: { bulk_batch_id: BATCH, n: 2 } }),
      audit({ resource_id: "r1", created_at: iso(50_000), metadata: { bulk_batch_id: BATCH, n: 1 } }),
      audit({ resource_id: "x-actor", actor_id: "someone-else" }),
      audit({ resource_id: "x-type", resource_type: "appointment" }),
      audit({ resource_id: "x-batch", metadata: { bulk_batch_id: "other-batch" } }),
      audit({ resource_id: "x-old", created_at: iso(25 * 60 * 60 * 1000) }), // outside the 24h index bound
    ]);
    const r = await load();
    expect(r).toMatchObject({ ok: true, alreadyUndone: false });
    if (!r.ok) throw new Error("unreachable");
    expect(r.rows).toEqual([
      { resource_id: "r1", action: "test_request.claimed", metadata: { bulk_batch_id: BATCH, n: 1 } },
      { resource_id: "r2", action: "test_request.claimed", metadata: { bulk_batch_id: BATCH, n: 2 } },
    ]);
    expect([...r.changedSince]).toEqual([]);
  });

  it("no rows for the caller reads as expired — another actor's batch is never disclosed", async () => {
    db.seed("audit_log", [audit({ actor_id: "someone-else" })]);
    expect(await load()).toEqual({ ok: false, error: UNDO_EXPIRED });
  });

  it("a failed main read fails closed", async () => {
    db.hooks.readError = (c) => (c.select?.startsWith("resource_id, action") ? { message: "boom" } : undefined);
    db.seed("audit_log", [audit({})]);
    expect(await load()).toEqual({ ok: false, error: READ_FAILED });
  });
});

describe("alreadyUndone", () => {
  it("is true when ANY audit row names this batch as undo_of_batch", async () => {
    db.seed("audit_log", [
      audit({}),
      audit({ actor_id: "an-admin", resource_id: "r1", metadata: { undo_of_batch: BATCH, via: "bulk_undo" } }),
    ]);
    const r = await load();
    expect(r).toMatchObject({ ok: true, alreadyUndone: true });
  });

  it("an undo of a DIFFERENT batch does not count", async () => {
    db.seed("audit_log", [audit({}), audit({ metadata: { undo_of_batch: "other-batch" } })]);
    expect(await load()).toMatchObject({ ok: true, alreadyUndone: false });
  });
});

describe("the 10-minute deadline", () => {
  it("is open at exactly ten minutes and closed one millisecond later", async () => {
    db.seed("audit_log", [audit({ created_at: iso(UNDO_WINDOW_MS) })]);
    expect(await load()).toMatchObject({ ok: true });
    db = new FakeDb().seed("audit_log", [audit({ created_at: iso(UNDO_WINDOW_MS + 1) })]);
    h.client = db.client();
    expect(await load()).toEqual({ ok: false, error: UNDO_EXPIRED });
  });

  it("compares instants, not strings: PostgREST's +00:00 spelling of the boundary is still open", async () => {
    const boundary = new Date(NOW - UNDO_WINDOW_MS).toISOString().replace(".000Z", ".000000+00:00");
    db.seed("audit_log", [audit({ created_at: boundary })]);
    expect(await load()).toMatchObject({ ok: true });
  });

  it("is decided ONCE from the batch's EARLIEST row — a batch that started 11 minutes ago is expired even if its last row is recent", async () => {
    db.seed("audit_log", [
      audit({ resource_id: "r1", created_at: iso(11 * 60_000) }),
      audit({ resource_id: "r2", created_at: iso(30_000) }),
    ]);
    expect(await load()).toEqual({ ok: false, error: UNDO_EXPIRED });
  });
});

describe("changedSince", () => {
  it("names a resource with a NEWER row from another actor / action outside the batch", async () => {
    db.seed("audit_log", [
      audit({ resource_id: "r1", created_at: iso(60_000) }),
      audit({ resource_id: "r2", created_at: iso(60_000) }),
      // someone reassigned r2 afterwards
      audit({
        actor_id: "other",
        resource_id: "r2",
        action: "test_request.reassigned",
        metadata: {},
        created_at: iso(30_000),
      }),
    ]);
    const r = await load();
    if (!r.ok) throw new Error("unreachable");
    expect([...r.changedSince]).toEqual(["r2"]);
  });

  it("counts the SAME actor acting outside the batch too", async () => {
    db.seed("audit_log", [
      audit({ resource_id: "r1", created_at: iso(60_000) }),
      audit({ resource_id: "r1", action: "test_request.unclaimed", metadata: {}, created_at: iso(20_000) }),
    ]);
    const r = await load();
    if (!r.ok) throw new Error("unreachable");
    expect(r.changedSince.has("r1")).toBe(true);
  });

  it("counts a newer row even when read back in PostgREST's +00:00 spelling", async () => {
    db.seed("audit_log", [
      audit({ resource_id: "r1", created_at: iso(60_000) }),
      audit({ actor_id: "other", resource_id: "r1", metadata: {}, created_at: iso(59_000).replace(".000Z", ".000000+00:00") }),
    ]);
    const r = await load();
    if (!r.ok) throw new Error("unreachable");
    expect([...r.changedSince]).toEqual(["r1"]);
  });

  it("ignores the batch's own later rows and a foreign row at the very same instant (other spelling)", async () => {
    db.seed("audit_log", [
      audit({ resource_id: "r1", created_at: iso(60_000) }),
      audit({ resource_id: "r1", created_at: iso(30_000) }), // this batch, later
      audit({ actor_id: "other", resource_id: "r1", metadata: {}, created_at: iso(60_000).replace(".000Z", ".000000+00:00") }),
    ]);
    const r = await load();
    if (!r.ok) throw new Error("unreachable");
    expect([...r.changedSince]).toEqual([]);
  });

  it("only looks at this resource type and this batch's own resources", async () => {
    db.seed("audit_log", [
      audit({ resource_id: "r1", created_at: iso(60_000) }),
      audit({ actor_id: "other", resource_type: "appointment", resource_id: "r1", metadata: {}, created_at: iso(30_000) }),
      audit({ actor_id: "other", resource_id: "unrelated", metadata: {}, created_at: iso(30_000) }),
    ]);
    const r = await load();
    if (!r.ok) throw new Error("unreachable");
    expect([...r.changedSince]).toEqual([]);
  });

  it("skips audit rows with no resource_id", async () => {
    db.seed("audit_log", [
      audit({ resource_id: "r1", created_at: iso(60_000) }),
      audit({ resource_id: null, metadata: { bulk_batch_id: BATCH, summary: true }, created_at: iso(59_000) }),
    ]);
    const r = await load();
    if (!r.ok) throw new Error("unreachable");
    expect([...r.changedSince]).toEqual([]);
  });

  it("reads a batch of more than 200 ids in IN_CHUNK slices and still finds a change in the last slice", async () => {
    const N = 450;
    const ids = Array.from({ length: N }, (_, i) => `r${String(i).padStart(3, "0")}`);
    db.seed(
      "audit_log",
      ids.map((id, i) => audit({ resource_id: id, created_at: iso(120_000 - i) })),
    );
    // the newest resource — in the THIRD slice — was changed by someone else afterwards
    db.seed("audit_log", [
      audit({ actor_id: "other", resource_id: ids[N - 1], metadata: {}, created_at: iso(10_000) }),
    ]);
    const r = await load();
    if (!r.ok) throw new Error("unreachable");
    expect(r.rows).toHaveLength(N);
    expect([...r.changedSince]).toEqual([ids[N - 1]]);

    const laterReads = db
      .selects("audit_log")
      .filter((c) => c.filters.some(([n, a]) => n === "in" && a[0] === "resource_id"));
    const sizes = laterReads.map((c) => (c.filters.find(([n]) => n === "in")![1][1] as string[]).length);
    expect(IN_CHUNK).toBe(200);
    expect(sizes).toEqual([200, 200, 50]);
  });

  it("pages a slice past 1000 rows rather than trust one page as all of it", async () => {
    db.seed("audit_log", [
      audit({ resource_id: "r1", created_at: iso(120_000) }),
      audit({ resource_id: "r2", created_at: iso(120_000) }),
    ]);
    // 1,200 later rows of the batch itself on r1 (never a change) …
    db.seed(
      "audit_log",
      Array.from({ length: 1200 }, (_, i) => audit({ resource_id: "r1", created_at: iso(100_000 - i) })),
    );
    // … and, sorted AFTER all of them, one foreign row on r2 — only on page 2.
    db.seed("audit_log", [audit({ actor_id: "other", resource_id: "r2", metadata: {}, created_at: iso(1_000) })]);
    const r = await load();
    if (!r.ok) throw new Error("unreachable");
    expect([...r.changedSince]).toEqual(["r2"]);
    const ranges = db
      .selects("audit_log")
      .flatMap((c) => c.filters.filter(([n]) => n === "range").map(([, a]) => a));
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("fails CLOSED when any slice's read fails — never an empty changedSince", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `r${i}`);
    db.seed(
      "audit_log",
      ids.map((id) => audit({ resource_id: id })),
    );
    let laterCalls = 0;
    db.hooks.readError = (c) => {
      if (!c.filters.some(([n, a]) => n === "in" && a[0] === "resource_id")) return undefined;
      laterCalls += 1;
      return laterCalls === 2 ? { message: "boom" } : undefined;
    };
    expect(await load()).toEqual({ ok: false, error: READ_FAILED });
  });
});
