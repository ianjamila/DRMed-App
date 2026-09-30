import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// updateMessageStatusManyAction end to end against the in-memory fake
// client: the real zod parsing, matrix check and guarded writes run; only the
// session, audit writer, headers and cache are stubbed. A predicate dropped
// from a write changes the rows these tests read back.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "9.9.9.9", "user-agent": "vitest" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const h = vi.hoisted(() => ({
  session: { user_id: "11111111-1111-4111-8111-111111111111", role: "reception" } as { user_id: string; role: string },
  db: null as unknown,
  audit: vi.fn(async (entry: Record<string, unknown>) => void entry),
}));
vi.mock("@/lib/auth/require-staff", () => ({ requireActiveStaff: async () => h.session }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as FakeDb).client() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/audit/log", () => ({ audit: h.audit }));

import { revalidatePath } from "next/cache";
import { updateMessageStatusManyAction } from "./actions";
import { FakeDb, type Row } from "@/lib/testing/fake-db";
import { MESSAGE_CHANGED_REASON, MESSAGE_GONE_REASON, MESSAGE_WRITE_FAILED_REASON } from "@/lib/contact-messages/bulk-status";

const ME = h.session.user_id;
const OTHER = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const msg = (n: number, over: Row = {}): Row => ({
  id: id(n), status: "new", handled_by: null, handled_at: null, kind: "general", ...over,
});
let db: FakeDb;
const audits = () => h.audit.mock.calls.map((c) => c[0] as Record<string, unknown>);
const meta = (a: Record<string, unknown>) => a.metadata as Record<string, unknown>;

beforeEach(() => {
  db = new FakeDb();
  h.db = db;
  h.session = { user_id: ME, role: "reception" };
  h.audit.mockClear();
  vi.mocked(revalidatePath).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("updateMessageStatusManyAction", () => {
  it("refuses a role outside reception/admin before reading anything", async () => {
    h.session = { user_id: ME, role: "medtech" };
    const r = await updateMessageStatusManyAction({ entries: [], to: "closed" });
    expect(r).toEqual({ ok: false, error: "Only reception or admin can manage website messages." });
    expect(db.calls).toEqual([]);
  });

  it("refuses an empty, oversize or malformed batch", async () => {
    for (const input of [
      { entries: [], to: "closed" },
      { entries: Array.from({ length: 101 }, (_, i) => ({ id: id(i + 1), from: "new" })), to: "closed" },
      { entries: [{ id: id(1), from: "new" }], to: "booked" },
      { entries: [{ id: "not-a-uuid", from: "new" }], to: "closed" },
    ]) {
      const r = await updateMessageStatusManyAction(input);
      expect(r.ok).toBe(false);
    }
    expect(db.updates("contact_messages")).toEqual([]);
  });

  it("moves every eligible message, stamps handled_by/at, audits each with the batch and prior handler", async () => {
    db.seed("contact_messages", [
      msg(1),
      msg(2, { status: "replied", handled_by: OTHER, handled_at: "2026-09-29T01:00:00+00:00" }),
    ]);
    const r = await updateMessageStatusManyAction({
      entries: [{ id: id(1), from: "new" }, { id: id(2), from: "replied" }],
      to: "closed",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.changedIds.sort()).toEqual([id(1), id(2)]);
    expect(r.skipped).toEqual([]);
    expect(r.batchId).toMatch(/^[0-9a-f-]{36}$/);
    for (const n of [1, 2]) {
      expect(db.row("contact_messages", id(n))).toMatchObject({ status: "closed", handled_by: ME });
    }
    const stamp = db.row("contact_messages", id(1)).handled_at;
    expect(db.row("contact_messages", id(2)).handled_at).toBe(stamp);
    const a2 = audits().find((a) => a.resource_id === id(2))!;
    expect(a2.action).toBe("contact_message.status_changed");
    expect(meta(a2)).toMatchObject({
      from: "replied", to: "closed", previous_handled_by: OTHER, previous_handled_at: "2026-09-29T01:00:00+00:00",
      handled_at: stamp, bulk_batch_id: r.batchId, bulk_batch_size: 2,
    });
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["/staff/messages", `/staff/messages/${id(1)}`, `/staff/messages/${id(2)}`, "/staff"]),
    );
  });

  it("skips a message whose status changed since selection — never overwrites it", async () => {
    db.seed("contact_messages", [msg(1, { status: "booked" }), msg(2)]);
    const r = await updateMessageStatusManyAction({
      entries: [{ id: id(1), from: "new" }, { id: id(2), from: "new" }],
      to: "replied",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.changedIds).toEqual([id(2)]);
    expect(r.skipped).toEqual([{ id: id(1), reason: MESSAGE_CHANGED_REASON }]);
    expect(db.row("contact_messages", id(1)).status).toBe("booked");
    expect(audits().map((a) => a.resource_id)).toEqual([id(2)]);
  });

  it("a race between the read and the write (handler changed) is skipped by the write's own predicate", async () => {
    db.seed("contact_messages", [msg(1), msg(2)]);
    db.hooks.beforeWrite = (call, d) => {
      if (call.table !== "contact_messages") return;
      const r = d.row("contact_messages", id(1));
      r.handled_by = OTHER; // someone else touched it in between
      r.handled_at = "2026-09-30T00:00:00+00:00";
    };
    const r = await updateMessageStatusManyAction({
      entries: [{ id: id(1), from: "new" }, { id: id(2), from: "new" }],
      to: "closed",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.changedIds).toEqual([id(2)]);
    expect(r.skipped).toEqual([{ id: id(1), reason: MESSAGE_CHANGED_REASON }]);
    expect(db.row("contact_messages", id(1))).toMatchObject({ status: "new", handled_by: OTHER });
  });

  it("names a message the matrix does not allow, and a missing one", async () => {
    db.seed("contact_messages", [msg(1, { status: "booked" })]);
    const r = await updateMessageStatusManyAction({
      entries: [{ id: id(1), from: "booked" }, { id: id(3), from: "new" }],
      to: "replied",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.changedIds).toEqual([]);
    expect(r.skipped).toEqual([
      { id: id(1), reason: "a Booked message can't be moved to Replied" },
      { id: id(3), reason: MESSAGE_GONE_REASON },
    ]);
    expect(r.batchId).toBeUndefined();
  });

  // Each race flips exactly ONE column of message 1 between the server's read
  // and its write; message 2 shares the write group and must still commit.
  // Dropping that one predicate from the write lets message 1 be overwritten.
  const races: Array<[string, Row]> = [
    ["status", { status: "booked" }],
    ["handled_at", { handled_at: "2026-09-30T00:00:00+00:00" }],
    ["handled_by", { handled_by: OTHER }],
  ];
  it.each(races)("a write-time change of only %s is skipped by that predicate, its group-mate still commits", async (_col, flip) => {
    db.seed("contact_messages", [msg(1), msg(2)]);
    db.hooks.beforeWrite = (call, d) => {
      if (call.table === "contact_messages") Object.assign(d.row("contact_messages", id(1)), flip);
    };
    const r = await updateMessageStatusManyAction({
      entries: [{ id: id(1), from: "new" }, { id: id(2), from: "new" }],
      to: "closed",
    });
    if (!r.ok) throw new Error(r.error);
    expect(db.updates("contact_messages")).toHaveLength(1); // one group: only the predicates can tell them apart
    expect(r.changedIds).toEqual([id(2)]);
    expect(r.skipped).toEqual([{ id: id(1), reason: MESSAGE_CHANGED_REASON }]);
    expect(db.row("contact_messages", id(1))).toMatchObject({ handled_by: null, handled_at: null, ...flip });
    expect(db.row("contact_messages", id(1)).status).not.toBe("closed");
    expect(db.row("contact_messages", id(1)).handled_by).not.toBe(ME);
    expect(db.row("contact_messages", id(2))).toMatchObject({ status: "closed", handled_by: ME });
    expect(audits().map((a) => a.resource_id)).toEqual([id(2)]);
  });

  it("one group's write error is skipped and named; the other group still commits and is audited", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    db.seed("contact_messages", [
      msg(1, { handled_by: OTHER, handled_at: "2026-09-29T01:00:00+00:00" }),
      msg(2),
    ]);
    db.hooks.beforeWrite = (call) =>
      call.table === "contact_messages" && call.filters.some(([n, a]) => n === "eq" && a[0] === "handled_by")
        ? { code: "XX000", message: "boom" }
        : undefined;
    const r = await updateMessageStatusManyAction({
      entries: [{ id: id(1), from: "new" }, { id: id(2), from: "new" }],
      to: "closed",
    });
    if (!r.ok) throw new Error(r.error);
    expect(db.updates("contact_messages")).toHaveLength(2);
    expect(r.changedIds).toEqual([id(2)]);
    expect(r.skipped).toEqual([{ id: id(1), reason: MESSAGE_WRITE_FAILED_REASON }]);
    expect(r.batchId).toBeDefined();
    expect(db.row("contact_messages", id(1))).toMatchObject({ status: "new", handled_by: OTHER });
    expect(db.row("contact_messages", id(2))).toMatchObject({ status: "closed", handled_by: ME });
    expect(audits().map((a) => a.resource_id)).toEqual([id(2)]);
    expect(meta(audits()[0]!)).toMatchObject({ bulk_batch_id: r.batchId, bulk_batch_size: 2 });
    expect(vi.mocked(revalidatePath)).toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith("bulk message status write failed", expect.objectContaining({ ids: [id(1)] }));
    err.mockRestore();
  });

  it("a failed write reports the error when nothing changed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.seed("contact_messages", [msg(1)]);
    db.hooks.beforeWrite = (call) => (call.table === "contact_messages" ? { code: "XX000", message: "boom" } : undefined);
    const r = await updateMessageStatusManyAction({ entries: [{ id: id(1), from: "new" }], to: "closed" });
    expect(r.ok).toBe(false);
    expect(audits()).toEqual([]);
  });
});
