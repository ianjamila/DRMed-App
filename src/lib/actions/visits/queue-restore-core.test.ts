import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Codex review finding 3 (P1, 2026-09-30): restoreTestRequestsForVisit used to
// filter the READ by the exact deleted_at a bulk Undo expected (sameInstant),
// but predicate the WRITE only on "deleted_at is not null" — so a
// restore-and-re-delete landing between the read and the write still matched
// that looser predicate and got silently undone by an Undo that had nothing
// to do with it. The fix groups the validated rows by the exact deleted_at
// value read (groupIdsByDeletedAt, src/lib/queue/partial-panel.ts — its own
// grouping logic is unit-tested there) and issues one UPDATE per group, each
// predicated on `.eq("deleted_at", thatValue)`. restoreTestRequestsForVisit
// itself has no pure seam (admin client, StaffSession, audit()) — pinned here
// as source text.

const FILE = join(process.cwd(), "src/lib/actions/visits/queue-restore-core.ts");
const src = readFileSync(FILE, "utf8");

describe("restoreTestRequestsForVisit's bulk-Undo write predicates on the exact deleted_at read, not just NOT NULL", () => {
  it("groups the expectedDeletedAtOf branch's rows via groupIdsByDeletedAt", () => {
    expect(src).toMatch(/import \{ groupIdsByDeletedAt \} from "@\/lib\/queue\/partial-panel";/);
    expect(src).toMatch(/groupIdsByDeletedAt\(/);
  });

  it("the expectedDeletedAtOf branch's write predicates on the exact value, never merely NOT NULL", () => {
    const branchStart = src.indexOf("if (expectedDeletedAtOf) {", src.indexOf("let restored:"));
    expect(branchStart, "expectedDeletedAtOf write branch not found").toBeGreaterThan(-1);
    const branchEnd = src.indexOf("\n  } else {", branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = src.slice(branchStart, branchEnd);
    expect(branch).toMatch(/\.eq\("deleted_at",\s*deletedAtValue\)/);
    expect(branch).not.toMatch(/\.not\("deleted_at",\s*"is",\s*null\)/);
  });

  it("the manual-restore (no expectedDeletedAtOf) branch is unchanged: still predicates on NOT NULL", () => {
    const elseStart = src.indexOf("\n  } else {", src.indexOf("let restored:"));
    expect(elseStart).toBeGreaterThan(-1);
    const elseEnd = src.indexOf("\n  }\n\n  const rowById", elseStart);
    expect(elseEnd).toBeGreaterThan(elseStart);
    const branch = src.slice(elseStart, elseEnd);
    expect(branch).toMatch(/\.not\("deleted_at",\s*"is",\s*null\)/);
    expect(branch).not.toMatch(/groupIdsByDeletedAt/);
  });

  it("every write in both branches still scopes to the visit", () => {
    // Losing `.eq("visit_id", visitId)` on either branch would let a
    // same-batch id belonging to a DIFFERENT visit slip through the write.
    const writes = [...src.matchAll(/\.update\(\{ deleted_at: null[\s\S]{0,300}?\.select\("id"\)/g)];
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) {
      expect(w[0]).toMatch(/\.eq\("visit_id",\s*visitId\)/);
    }
  });
});

// Behavioural: a restore UPDATE that loses a lock race (40P01) re-runs once.
// PR B's proof (S7, scripts/panel-undo-concurrency-proof.ts) showed a manual
// Restore racing a panel Undo-restore on one visit can lose a deadlock. Real
// rows live in the shared FakeDb; `beforeWrite` makes a chosen UPDATE fail
// with 40P01 (nothing is written, exactly like a rolled-back statement).
const h = vi.hoisted(() => ({
  db: null as unknown,
  audits: [] as Array<{ resource_id: string; action: string }>,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (h.db as { client: () => unknown }).client(),
}));
vi.mock("@/lib/audit/log", () => ({
  audit: async (e: { resource_id: string; action: string }) => void h.audits.push(e),
}));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: null, ua: null }) }));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: async () => ({ ok: true }) }));

const { restoreTestRequestsForVisit } = await import("./queue-restore-core");
const { translatePgError } = await import("@/lib/accounting/pg-errors");
const { FakeDb } = await import("@/lib/testing/fake-db");
type FakeDbT = InstanceType<typeof FakeDb>;

const SESSION = { user_id: "u1", role: "admin" } as never;
const T1 = "2026-10-02T01:00:00.000Z";
const T2 = "2026-10-02T01:00:05.000Z";
const LOST = { code: "40P01", message: "deadlock detected" };

function row(id: string, deletedAt: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    visit_id: "v1",
    deleted_at: deletedAt,
    deleted_by: deletedAt ? "someone" : null,
    delete_reason: deletedAt ? "typo" : null,
    parent_id: null,
    services: { name: `Svc ${id}`, code: `C-${id}` },
    visits: { patient_id: "p1", deleted_at: null },
    ...over,
  };
}

let db: FakeDbT;
/** Fail the first `times` UPDATEs whose filters satisfy `when` (default: every UPDATE) with 40P01. */
function loseRace(times: number, when: (filters: Array<[string, unknown[]]>) => boolean = () => true) {
  let left = times;
  db.hooks.beforeWrite = (call) => {
    if (left > 0 && when(call.filters)) {
      left -= 1;
      return LOST;
    }
  };
}
const deletedAtOf = (id: string) => db.row("test_requests", id).deleted_at;
const forGroup = (t: string) => (filters: Array<[string, unknown[]]>) =>
  filters.some(([name, args]) => name === "eq" && args[0] === "deleted_at" && args[1] === t);

beforeEach(() => {
  db = new FakeDb();
  h.db = db;
  h.audits = [];
});

describe("manual Restore retries a lost lock race once", () => {
  beforeEach(() => {
    db.seed("test_requests", [
      row("a", T1),
      row("b", T1),
      row("c", T1), // deleted but NOT selected — must stay deleted
      row("z", T1, { visit_id: "v2" }), // another visit — must stay deleted
    ]);
  });

  it("40P01 then success: ok, two identical UPDATEs, rows restored, one audit row per line", async () => {
    loseRace(1);
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "oops");
    expect(out).toEqual({ ok: true, restoredIds: ["a", "b"] });
    const ups = db.updates("test_requests");
    expect(ups).toHaveLength(2);
    expect(ups[1]!.filters).toEqual(ups[0]!.filters);
    expect(ups[0]!.matchedIds).toEqual([]); // the lost attempt wrote nothing
    expect(ups[1]!.matchedIds).toEqual(["a", "b"]);
    expect([deletedAtOf("a"), deletedAtOf("b")]).toEqual([null, null]);
    expect([deletedAtOf("c"), deletedAtOf("z")]).toEqual([T1, T1]);
    expect(h.audits.map((a) => [a.action, a.resource_id])).toEqual([
      ["test_request.restored", "a"],
      ["test_request.restored", "b"],
    ]);
  });

  it("a second 40P01 returns the translated error, writes and audits nothing", async () => {
    loseRace(2);
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "oops");
    expect(out).toEqual({ ok: false, error: translatePgError(LOST) });
    expect(db.updates("test_requests")).toHaveLength(2);
    expect(db.rows("test_requests").map((r) => r.deleted_at)).toEqual([T1, T1, T1, T1]);
    expect(h.audits).toHaveLength(0);
  });

  it("a non-retryable error (XX000) is not retried", async () => {
    const boom = { code: "XX000", message: "boom" };
    db.hooks.beforeWrite = () => boom;
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "oops");
    expect(out).toEqual({ ok: false, error: translatePgError(boom) });
    expect(db.updates("test_requests")).toHaveLength(1);
    expect(deletedAtOf("a")).toBe(T1);
    expect(h.audits).toHaveLength(0);
  });
});

describe("bulk Undo (expected deleted_at) retries each group the same way", () => {
  const expected = new Map([
    ["a", T1],
    ["b", T2],
  ]);
  beforeEach(() => {
    db.seed("test_requests", [row("a", T1), row("b", T2), row("c", T1)]);
  });

  it("a group that loses the race re-runs once with the same filters; the other group is untouched by it", async () => {
    loseRace(1, forGroup(T1));
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "undo", {}, expected);
    expect(out).toEqual({ ok: true, restoredIds: ["a", "b"] });
    const ups = db.updates("test_requests");
    expect(ups).toHaveLength(3); // A lost, A retried, B
    expect(ups[1]!.filters).toEqual(ups[0]!.filters);
    expect(ups[2]!.filters).not.toEqual(ups[0]!.filters);
    expect([deletedAtOf("a"), deletedAtOf("b")]).toEqual([null, null]);
    expect(deletedAtOf("c")).toBe(T1); // same deleted_at as A but not selected
    expect(h.audits.map((a) => a.resource_id)).toEqual(["a", "b"]);
  });

  it("a second 40P01 on the only group is not retried again: translated error, nothing restored", async () => {
    db.tables.test_requests = [row("a", T1)];
    loseRace(2);
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a"], "undo", {}, new Map([["a", T1]]));
    expect(out).toEqual({ ok: false, error: translatePgError(LOST) });
    expect(db.updates("test_requests")).toHaveLength(2);
    expect(deletedAtOf("a")).toBe(T1);
    expect(h.audits).toHaveLength(0);
  });

  it("mixed: group A loses twice, group B succeeds -> ok with B only", async () => {
    // Known gap: A's real error (40P01) is not surfaced — the core returns ok
    // and the caller lists A as "not restored".
    loseRace(2, forGroup(T1));
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "undo", {}, expected);
    expect(out).toEqual({ ok: true, restoredIds: ["b"] });
    expect(db.updates("test_requests")).toHaveLength(3); // A twice, B once
    expect(deletedAtOf("a")).toBe(T1);
    expect(deletedAtOf("b")).toBeNull();
    expect(h.audits.map((a) => a.resource_id)).toEqual(["b"]);
  });

  it("a non-retryable error (XX000) is not retried", async () => {
    db.tables.test_requests = [row("a", T1)];
    db.hooks.beforeWrite = () => ({ code: "XX000", message: "boom" });
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a"], "undo", {}, new Map([["a", T1]]));
    expect(out.ok).toBe(false);
    expect(db.updates("test_requests")).toHaveLength(1);
  });
});
