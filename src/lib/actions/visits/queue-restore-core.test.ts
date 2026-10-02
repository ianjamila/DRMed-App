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
// grouping logic is unit-tested there) and issues one write per group, each
// predicated on that exact value (since 0216: restore_test_request_lines with
// p_deleted_at). restoreTestRequestsForVisit
// itself has no pure seam (admin client, StaffSession, audit()) — pinned here
// as source text.

const FILE = join(process.cwd(), "src/lib/actions/visits/queue-restore-core.ts");
const src = readFileSync(FILE, "utf8");

describe("restoreTestRequestsForVisit's bulk-Undo write predicates on the exact deleted_at read, not just NOT NULL", () => {
  it("groups the expectedDeletedAtOf branch's rows via groupIdsByDeletedAt", () => {
    expect(src).toMatch(/import \{ groupIdsByDeletedAt \} from "@\/lib\/queue\/partial-panel";/);
    expect(src).toMatch(/groupIdsByDeletedAt\(/);
  });

  it("the expectedDeletedAtOf branch writes with the exact value, never merely NOT NULL", () => {
    const branchStart = src.indexOf("if (expectedDeletedAtOf) {", src.indexOf("let restored:"));
    expect(branchStart, "expectedDeletedAtOf write branch not found").toBeGreaterThan(-1);
    const branchEnd = src.indexOf("\n  } else {", branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = src.slice(branchStart, branchEnd);
    expect(branch).toMatch(/rpc\("restore_test_request_lines",\s*\{[^}]*p_deleted_at:\s*deletedAtValue/);
  });

  it("the manual-restore (no expectedDeletedAtOf) branch passes no p_deleted_at (the function then restores any deleted row)", () => {
    const elseStart = src.indexOf("\n  } else {", src.indexOf("let restored:"));
    expect(elseStart).toBeGreaterThan(-1);
    const elseEnd = src.indexOf("\n  }\n\n  const rowById", elseStart);
    expect(elseEnd).toBeGreaterThan(elseStart);
    const branch = src.slice(elseStart, elseEnd);
    const call = branch.match(/rpc\("restore_test_request_lines",\s*\{[^}]*\}/);
    expect(call, "manual-restore rpc call not found").not.toBeNull();
    expect(call![0]).not.toMatch(/p_deleted_at/);
    expect(branch).not.toMatch(/groupIdsByDeletedAt/);
  });

  it("every write in both branches goes through restore_test_request_lines (0216), scoped to the visit and retried once", () => {
    // 0216: a bare UPDATE locked the line before the visit and deadlocked with
    // release / undo; losing p_visit_id would let a same-batch id belonging to
    // a DIFFERENT visit slip through the write.
    expect(src).not.toMatch(/\.from\("test_requests"\)\s*\.update\(/);
    const writes = [...src.matchAll(/withLifecycleRetry\(\(\) =>\s*admin\.rpc\("restore_test_request_lines",\s*\{[^}]*\}/g)];
    expect(writes.length).toBe(2);
    for (const w of writes) expect(w[0]).toMatch(/p_visit_id:\s*visitId/);
  });
});

// The predicates themselves now live in SQL: pin them in the migration that defines the function.
const SQL = readFileSync(join(process.cwd(), "supabase/migrations/0216_delete_restore_lock_order.sql"), "utf8");
const restoreFn = SQL.slice(
  SQL.indexOf("create or replace function public.restore_test_request_lines("),
  SQL.indexOf("comment on function public.restore_test_request_lines("),
);

describe("restore_test_request_lines (0216) keeps the app's write predicates", () => {
  it("exact deleted_at with p_deleted_at, NOT NULL without it, always on the visit", () => {
    expect(restoreFn.length).toBeGreaterThan(100);
    expect(restoreFn).toMatch(/\(\(p_deleted_at is null and deleted_at is not null\) or deleted_at = p_deleted_at\)/);
    expect(restoreFn).toMatch(/and visit_id = p_visit_id/);
  });

  it("patient lock, then visit FOR UPDATE, then the lines and a header's components by id, then the UPDATE", () => {
    const patient = restoreFn.indexOf("lifecycle_lock_and_assert(array[v_patient], false)");
    const visit = restoreFn.indexOf("where v.id = p_visit_id for update");
    const lines = restoreFn.search(/t\.parent_id = any \(p_test_request_ids\)\)\s+order by t\.id\s+for no key update/);
    const write = restoreFn.indexOf("update public.test_requests");
    expect(patient).toBeGreaterThan(-1);
    expect(visit).toBeGreaterThan(patient);
    expect(lines).toBeGreaterThan(visit);
    expect(write).toBeGreaterThan(lines);
  });
});

// Behavioural: a restore write that loses a lock race (40P01) re-runs once.
// PR B's proof (S7, scripts/panel-undo-concurrency-proof.ts) showed a manual
// Restore racing a panel Undo-restore on one visit can lose a deadlock; 0216
// removes that cycle, but the lifecycle classes (40P01 vs an exclusive patient
// lock, P0072 after a merge) remain and the retry stays. Real rows live in the
// shared FakeDb; the `rpc` hook below plays restore_test_request_lines with
// the predicates pinned above, and `loseRace` makes a chosen call fail with
// 40P01 (nothing is written, exactly like a rolled-back transaction).
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

type RestoreArgs = { p_visit_id: string; p_test_request_ids: string[]; p_deleted_at?: string };
type DbErr = { code: string; message: string };

let db: FakeDbT;
/** Per call: the error it failed with, or null. Set by loseRace / failWith. */
let failOn: (args: RestoreArgs) => DbErr | null;
/** One entry per restore_test_request_lines call, with the ids it restored. */
let writes: Array<{ args: RestoreArgs; restoredIds: string[] }>;

/** Fail the first `times` calls whose args satisfy `when` (default: every call) with 40P01. */
function loseRace(times: number, when: (args: RestoreArgs) => boolean = () => true) {
  let left = times;
  failOn = (args) => {
    if (left > 0 && when(args)) {
      left -= 1;
      return LOST;
    }
    return null;
  };
}
const failWith = (err: DbErr) => (failOn = () => err);
const deletedAtOf = (id: string) => db.row("test_requests", id).deleted_at;
const forGroup = (t: string) => (args: RestoreArgs) => args.p_deleted_at === t;

beforeEach(() => {
  db = new FakeDb();
  h.db = db;
  h.audits = [];
  writes = [];
  failOn = () => null;
  db.hooks.rpc = (rec, d) => {
    if (rec.fn !== "restore_test_request_lines") return { error: { code: "42883", message: `no fake for ${rec.fn}` } };
    const args = rec.args as RestoreArgs;
    const err = failOn(args);
    if (err) {
      writes.push({ args, restoredIds: [] });
      return { error: err };
    }
    const hit = d
      .rows("test_requests")
      .filter(
        (r) =>
          args.p_test_request_ids.includes(r.id as string) &&
          r.visit_id === args.p_visit_id &&
          (args.p_deleted_at === undefined ? r.deleted_at !== null : r.deleted_at === args.p_deleted_at),
      );
    for (const r of hit) Object.assign(r, { deleted_at: null, deleted_by: null, delete_reason: null });
    const ids = hit.map((r) => r.id as string);
    writes.push({ args, restoredIds: ids });
    return { data: ids, error: null };
  };
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

  it("40P01 then success: ok, two identical calls, rows restored, one audit row per line", async () => {
    loseRace(1);
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "oops");
    expect(out).toEqual({ ok: true, restoredIds: ["a", "b"] });
    expect(writes).toHaveLength(2);
    expect(writes[1]!.args).toEqual(writes[0]!.args);
    expect(writes[0]!.args).toEqual({ p_visit_id: "v1", p_test_request_ids: ["a", "b"] }); // manual: no p_deleted_at
    expect(writes[0]!.restoredIds).toEqual([]); // the lost attempt wrote nothing
    expect(writes[1]!.restoredIds).toEqual(["a", "b"]);
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
    expect(writes).toHaveLength(2);
    expect(db.rows("test_requests").map((r) => r.deleted_at)).toEqual([T1, T1, T1, T1]);
    expect(h.audits).toHaveLength(0);
  });

  it("a non-retryable error (XX000) is not retried", async () => {
    const boom = { code: "XX000", message: "boom" };
    failWith(boom);
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "oops");
    expect(out).toEqual({ ok: false, error: translatePgError(boom) });
    expect(writes).toHaveLength(1);
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
    expect(writes).toHaveLength(3); // A lost, A retried, B
    expect(writes[1]!.args).toEqual(writes[0]!.args);
    expect(writes[2]!.args).not.toEqual(writes[0]!.args);
    expect([deletedAtOf("a"), deletedAtOf("b")]).toEqual([null, null]);
    expect(deletedAtOf("c")).toBe(T1); // same deleted_at as A but not selected
    expect(h.audits.map((a) => a.resource_id)).toEqual(["a", "b"]);
  });

  it("a second 40P01 on the only group is not retried again: translated error, nothing restored", async () => {
    db.tables.test_requests = [row("a", T1)];
    loseRace(2);
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a"], "undo", {}, new Map([["a", T1]]));
    expect(out).toEqual({ ok: false, error: translatePgError(LOST) });
    expect(writes).toHaveLength(2);
    expect(deletedAtOf("a")).toBe(T1);
    expect(h.audits).toHaveLength(0);
  });

  it("mixed: group A loses twice, group B succeeds -> ok with B only", async () => {
    // Known gap: A's real error (40P01) is not surfaced — the core returns ok
    // and the caller lists A as "not restored".
    loseRace(2, forGroup(T1));
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a", "b"], "undo", {}, expected);
    expect(out).toEqual({ ok: true, restoredIds: ["b"] });
    expect(writes).toHaveLength(3); // A twice, B once
    expect(deletedAtOf("a")).toBe(T1);
    expect(deletedAtOf("b")).toBeNull();
    expect(h.audits.map((a) => a.resource_id)).toEqual(["b"]);
  });

  it("a non-retryable error (XX000) is not retried", async () => {
    db.tables.test_requests = [row("a", T1)];
    failWith({ code: "XX000", message: "boom" });
    const out = await restoreTestRequestsForVisit(SESSION, "v1", ["a"], "undo", {}, new Map([["a", T1]]));
    expect(out.ok).toBe(false);
    expect(writes).toHaveLength(1);
  });
});
