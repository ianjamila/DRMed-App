import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// deleteTestRequestsForVisit (the per-visit body of the queue's Delete) reads the visit's
// deleted_at WITHOUT a lock, then calls delete_test_request_lines. 0221: a visit soft-deleted in
// between is refused by the RPC under its visit lock (P0083, nothing deleted); the core answers it
// with the very message its pre-check shows, and does not retry it. The rest of the retry
// behaviour (P0072 / 40P01, once) is withLifecycleRetry's and is unchanged.

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

const { deleteTestRequestsForVisit, VISIT_ALREADY_DELETED_ERROR } = await import("./bulk-delete-core");
const { translatePgError } = await import("@/lib/accounting/pg-errors");
const { FakeDb } = await import("@/lib/testing/fake-db");
type FakeDbT = InstanceType<typeof FakeDb>;

const SESSION = { user_id: "u1", role: "admin" } as never;
type DbErr = { code: string; message: string };
type DeleteArgs = { p_visit_id: string; p_test_request_ids: string[]; p_deleted_at: string };

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    visit_id: "v1",
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    parent_id: null,
    final_price_php: "100",
    is_package_header: false,
    services: { name: `Svc ${id}`, code: `C-${id}` },
    visits: { patient_id: "p1", deleted_at: null },
    ...over,
  };
}

let db: FakeDbT;
let failOn: DbErr | null;
let calls: DeleteArgs[];

beforeEach(() => {
  db = new FakeDb();
  h.db = db;
  h.audits = [];
  calls = [];
  failOn = null;
  db.seed("test_requests", [row("a"), row("b")]);
  db.hooks.rpc = (rec, d) => {
    if (rec.fn !== "delete_test_request_lines") return { error: { code: "42883", message: `no fake for ${rec.fn}` } };
    const args = rec.args as DeleteArgs;
    calls.push(args);
    if (failOn) return { error: failOn };
    const hit = d.rows("test_requests").filter((r) => args.p_test_request_ids.includes(r.id as string) && r.deleted_at === null);
    for (const r of hit) Object.assign(r, { deleted_at: args.p_deleted_at });
    return { data: hit.map((r) => r.id as string), error: null };
  };
});

describe("a visit deleted after the pre-check: the RPC's P0083 reads like the pre-check's refusal (0221)", () => {
  it("the pre-check's own message is the exported constant", async () => {
    db.tables.test_requests = [row("a", { visits: { patient_id: "p1", deleted_at: "2026-10-02T01:00:00.000Z" } })];
    const out = await deleteTestRequestsForVisit(SESSION, "v1", ["a"], "typo");
    expect(out).toEqual({ ok: false, error: VISIT_ALREADY_DELETED_ERROR });
    expect(VISIT_ALREADY_DELETED_ERROR).toBe("Visit is already deleted.");
    expect(calls).toHaveLength(0);
  });

  it("P0083 from the RPC: the same message, one call (not retried), nothing deleted or audited", async () => {
    failOn = { code: "P0083", message: "Visit is already deleted." };
    const out = await deleteTestRequestsForVisit(SESSION, "v1", ["a", "b"], "typo");
    expect(out).toEqual({ ok: false, error: VISIT_ALREADY_DELETED_ERROR });
    expect(calls).toHaveLength(1);
    expect(db.rows("test_requests").map((r) => r.deleted_at)).toEqual([null, null]);
    expect(h.audits).toHaveLength(0);
  });

  it("the message does not depend on the RPC's wording (the code decides)", async () => {
    failOn = { code: "P0083", message: "something else entirely" };
    const out = await deleteTestRequestsForVisit(SESSION, "v1", ["a"], "typo");
    expect(out).toEqual({ ok: false, error: VISIT_ALREADY_DELETED_ERROR });
  });

  it("any other error still goes through the shared translator", async () => {
    failOn = { code: "P0042", message: "visit has recorded payments" };
    const out = await deleteTestRequestsForVisit(SESSION, "v1", ["a"], "typo");
    expect(out).toEqual({ ok: false, error: translatePgError(failOn) });
    expect(calls).toHaveLength(1);
  });

  it("a lost lock race (40P01) is retried once, then P0083 is not retried", async () => {
    let n = 0;
    const base = db.hooks.rpc!;
    db.hooks.rpc = (rec, d) => {
      n += 1;
      if (n === 1) return { error: { code: "40P01", message: "deadlock detected" } };
      failOn = { code: "P0083", message: "Visit is already deleted." };
      return base(rec, d);
    };
    const out = await deleteTestRequestsForVisit(SESSION, "v1", ["a"], "typo");
    expect(out).toEqual({ ok: false, error: VISIT_ALREADY_DELETED_ERROR });
    expect(n).toBe(2);
  });

  it("success path unchanged: the rows are deleted and one audit row is written per line", async () => {
    const out = await deleteTestRequestsForVisit(SESSION, "v1", ["a", "b"], "typo");
    expect(out).toEqual({ ok: true, deletedIds: ["a", "b"] });
    expect(h.audits.map((a) => [a.action, a.resource_id])).toEqual([
      ["test_request.deleted", "a"],
      ["test_request.deleted", "b"],
    ]);
  });
});

describe("delete_test_request_lines (0221) re-checks the visit's deleted_at under the visit lock", () => {
  const SQL221 = readFileSync(join(process.cwd(), "supabase/migrations/0221_delete_restore_visit_deleted_recheck.sql"), "utf8");
  const fn221 = SQL221.slice(
    SQL221.indexOf("create or replace function public.delete_test_request_lines("),
    SQL221.indexOf("comment on function public.delete_test_request_lines("),
  );

  it("reads deleted_at in the visit's FOR UPDATE select and refuses with P0083 right after the P0072 re-check, before any line is locked or written", () => {
    expect(fn221.length).toBeGreaterThan(100);
    const lock = fn221.indexOf("select v.patient_id, v.deleted_at into v_now, v_deleted");
    const forUpdate = fn221.indexOf("from public.visits v where v.id = p_visit_id for update;");
    const moved = fn221.indexOf("errcode = 'P0072'");
    const refuse = fn221.search(/if v_deleted is not null then\s+raise exception '[^']+' using errcode = 'P0083';/);
    const lines = fn221.search(/order by t\.id\s+for no key update/);
    const write = fn221.indexOf("update public.test_requests");
    expect(lock).toBeGreaterThan(-1);
    expect(forUpdate).toBeGreaterThan(lock);
    expect(moved).toBeGreaterThan(forUpdate);
    expect(refuse).toBeGreaterThan(moved);
    expect(lines).toBeGreaterThan(refuse);
    expect(write).toBeGreaterThan(lines);
  });

  it("keeps 0216's UPDATE and ACL", () => {
    expect(fn221).toMatch(/where id = any \(p_test_request_ids\)\s+and visit_id = p_visit_id\s+and deleted_at is null/);
    expect(fn221).toContain("security definer");
    expect(fn221).toContain("set search_path = pg_catalog, public, pg_temp");
    expect(SQL221).toMatch(/revoke all on function public\.delete_test_request_lines\(uuid, uuid\[\], uuid, text, timestamptz\) from public, anon, authenticated;/);
    expect(SQL221).toMatch(/grant execute on function public\.delete_test_request_lines\(uuid, uuid\[\], uuid, text, timestamptz\) to service_role;/);
  });
});
