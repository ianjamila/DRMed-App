import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "9.9.9.9", "user-agent": "vitest" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const h = vi.hoisted(() => ({ audit: vi.fn(async (e: Record<string, unknown>) => void e) }));
vi.mock("@/lib/audit/log", () => ({ audit: h.audit }));

import { FakeDb, type Row } from "@/lib/testing/fake-db";
import { reclaimPanelMembers, restorePanelMembers } from "./panel-writes";
import type { StaffSession } from "@/lib/auth/require-staff";

const session = { user_id: "admin-1", role: "admin" } as unknown as StaffSession;
let db: FakeDb;
const P0082 = { code: "P0082", message: "Someone claimed or changed part of this report since — nothing was put back." };

function tr(id: string, over: Row = {}): Row {
  return {
    id, visit_id: "visit-1", status: "requested", assigned_to: null, started_at: null,
    deleted_at: null, deleted_by: null, delete_reason: null, parent_id: null,
    services: { name: `Svc ${id}`, code: `C-${id}` }, visits: { patient_id: "patient-1", deleted_at: null },
    ...over,
  };
}

beforeEach(() => {
  db = new FakeDb();
  h.audit.mockClear();
});

describe("reclaimPanelMembers", () => {
  it("calls reclaim_panel_members once with parallel arrays and audits one reassigned row per member", async () => {
    db.seed("test_requests", [tr("m1"), tr("m2")]);
    db.hooks.rpc = (rec) => {
      expect(rec.fn).toBe("reclaim_panel_members");
      return { data: 2, error: null };
    };
    const r = await reclaimPanelMembers(session, db.client() as never, {
      members: [
        { id: "m1", holder: "tech-a", startedAt: "2026-09-30T01:00:00.000Z" },
        { id: "m2", holder: "tech-b", startedAt: null },
      ],
      visitIdOf: () => "visit-1",
      auditExtra: { via: "bulk_undo", undo_of_batch: "b", bulk_batch_id: "u", panel_key: "k" },
    });
    expect(r).toEqual({ ok: true });
    expect(db.rpcCalls).toEqual([
      { fn: "reclaim_panel_members", args: {
        p_test_request_ids: ["m1", "m2"], p_holders: ["tech-a", "tech-b"],
        p_started_at: ["2026-09-30T01:00:00.000Z", null],
      } },
    ]);
    const rows = h.audit.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(rows.map((a) => [a.action, a.resource_id, (a.metadata as Row).to])).toEqual([
      ["test_request.reassigned", "m1", "tech-a"],
      ["test_request.reassigned", "m2", "tech-b"],
    ]);
  });

  it("a P0082 refusal changes nothing and is translated", async () => {
    db.hooks.rpc = () => ({ data: null, error: P0082 });
    const r = await reclaimPanelMembers(session, db.client() as never, {
      members: [{ id: "m1", holder: "tech-a", startedAt: null }],
      visitIdOf: () => "visit-1",
    });
    expect(r).toEqual({ ok: false, error: P0082.message });
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("retries once on a lost lifecycle race (P0072), never on P0082", async () => {
    let n = 0;
    db.hooks.rpc = () => (++n === 1 ? { data: null, error: { code: "P0072", message: "moved" } } : { data: 1, error: null });
    expect(await reclaimPanelMembers(session, db.client() as never, {
      members: [{ id: "m1", holder: "tech-a", startedAt: null }], visitIdOf: () => "visit-1",
    })).toEqual({ ok: true });
    expect(n).toBe(2);

    n = 0;
    db.hooks.rpc = () => (++n, { data: null, error: P0082 });
    await reclaimPanelMembers(session, db.client() as never, {
      members: [{ id: "m1", holder: "tech-a", startedAt: null }], visitIdOf: () => "visit-1",
    });
    expect(n).toBe(1);
  });
});

describe("restorePanelMembers", () => {
  const T = "2026-09-30T01:00:00.000Z";
  it("calls restore_panel_members once and audits one restored row per member with its prior delete info", async () => {
    db.seed("test_requests", [
      tr("m1", { deleted_at: "2026-09-30T01:00:00+00:00", delete_reason: "dup" }),
      tr("m2", { deleted_at: "2026-09-30T01:00:00+00:00", delete_reason: "dup" }),
    ]);
    db.hooks.rpc = (rec) => {
      expect(rec.fn).toBe("restore_panel_members");
      return { data: 2, error: null };
    };
    const r = await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1",
      members: [{ id: "m1", deletedAt: T }, { id: "m2", deletedAt: T }],
      reason: "Undo of a bulk delete",
      auditExtra: { via: "bulk_undo", undo_of_batch: "b", bulk_batch_id: "u", panel_key: "k" },
    });
    expect(r).toEqual({ ok: true, restoredIds: ["m1", "m2"] });
    expect(db.rpcCalls[0]!.args).toEqual({ p_visit_id: "visit-1", p_test_request_ids: ["m1", "m2"], p_deleted_at: [T, T] });
    const rows = h.audit.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(rows.map((a) => a.action)).toEqual(["test_request.restored", "test_request.restored"]);
    expect(rows[0]!.patient_id).toBe("patient-1");
    expect(rows[0]!.metadata).toMatchObject({
      visit_id: "visit-1", reason: "Undo of a bulk delete", service_name: "Svc m1", service_code: "C-m1",
      prior_delete_reason: "dup", via: "bulk_undo", panel_key: "k",
    });
  });

  it("a P0082 refusal restores nothing and audits nothing", async () => {
    db.seed("test_requests", [tr("m1", { deleted_at: "2026-09-30T01:00:00+00:00" })]);
    db.hooks.rpc = () => ({ data: null, error: { code: "P0082", message: "Part of this report was already restored or changed — nothing was restored." } });
    const r = await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1", members: [{ id: "m1", deletedAt: T }], reason: "x",
    });
    expect(r).toEqual({ ok: false, error: "Part of this report was already restored or changed — nothing was restored." });
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("exact timestamp pass-through (microseconds)", () => {
  // restore_panel_members matches deleted_at EXACTLY (microseconds) and
  // reclaim_panel_members restores started_at as given: a round trip through
  // Date would truncate to milliseconds and every restore would refuse.
  const MICRO = "2026-09-30T01:00:00.123456+00:00";

  it("restorePanelMembers hands deletedAt to the rpc unchanged", async () => {
    db.seed("test_requests", [tr("m1", { deleted_at: MICRO })]);
    db.hooks.rpc = () => ({ data: 1, error: null });
    await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1", members: [{ id: "m1", deletedAt: MICRO }], reason: "x",
    });
    expect(db.rpcCalls[0]!.args.p_deleted_at).toEqual([MICRO]);
  });

  it("reclaimPanelMembers hands startedAt to the rpc unchanged", async () => {
    db.hooks.rpc = () => ({ data: 1, error: null });
    await reclaimPanelMembers(session, db.client() as never, {
      members: [{ id: "m1", holder: "tech-a", startedAt: MICRO }], visitIdOf: () => "visit-1",
    });
    expect(db.rpcCalls[0]!.args.p_started_at).toEqual([MICRO]);
  });
});

describe("audit shape and retry pins", () => {
  const T = "2026-09-30T01:00:00.000Z";
  const extra = { via: "bulk_undo", undo_of_batch: "b", bulk_batch_id: "u", panel_key: "k" };

  it("reclaim audit metadata carries the visit, from/to, grouped and the batch extras", async () => {
    db.hooks.rpc = () => ({ data: 1, error: null });
    await reclaimPanelMembers(session, db.client() as never, {
      members: [{ id: "m1", holder: "tech-a", startedAt: null }],
      visitIdOf: () => "visit-1",
      auditExtra: extra,
    });
    const meta = (h.audit.mock.calls[0]![0] as Record<string, unknown>).metadata;
    expect(meta).toMatchObject({ visit_id: "visit-1", from: null, to: "tech-a", grouped: true, ...extra });
  });

  it("restore audit metadata marks a multi-member restore bulk and keeps prior_deleted_at", async () => {
    db.seed("test_requests", [
      tr("m1", { deleted_at: "2026-09-30T01:00:00+00:00" }),
      tr("m2", { deleted_at: "2026-09-30T01:00:00+00:00" }),
    ]);
    db.hooks.rpc = () => ({ data: 2, error: null });
    await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1", members: [{ id: "m1", deletedAt: T }, { id: "m2", deletedAt: T }], reason: "x",
    });
    for (const c of h.audit.mock.calls) {
      expect((c[0] as Record<string, unknown>).metadata).toMatchObject({
        bulk: true, prior_deleted_at: "2026-09-30T01:00:00+00:00",
      });
    }
    // A single member is not "bulk".
    h.audit.mockClear();
    await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1", members: [{ id: "m1", deletedAt: T }], reason: "x",
    });
    expect((h.audit.mock.calls[0]![0] as Record<string, unknown>).metadata).toMatchObject({ bulk: false });
  });

  it("restore retries once on a lost lifecycle race (P0072), never on P0082", async () => {
    db.seed("test_requests", [tr("m1", { deleted_at: T })]);
    let n = 0;
    db.hooks.rpc = () => (++n === 1 ? { data: null, error: { code: "P0072", message: "moved" } } : { data: 1, error: null });
    const ok = await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1", members: [{ id: "m1", deletedAt: T }], reason: "x",
    });
    expect(ok).toEqual({ ok: true, restoredIds: ["m1"] });
    expect(n).toBe(2);

    n = 0;
    db.hooks.rpc = () => (++n, { data: null, error: P0082 });
    const refused = await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1", members: [{ id: "m1", deletedAt: T }], reason: "x",
    });
    expect(refused.ok).toBe(false);
    expect(n).toBe(1);
  });

  it("the restore pre-read only sees members on a live visit", async () => {
    db.seed("test_requests", [tr("m1", { deleted_at: T })]);
    db.hooks.rpc = () => ({ data: 1, error: null });
    await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1", members: [{ id: "m1", deletedAt: T }], reason: "x",
    });
    const [read] = db.selects("test_requests");
    expect(read!.filters).toContainEqual(["is", ["visits.deleted_at", null]]);
    expect(read!.filters).toContainEqual(["eq", ["visit_id", "visit-1"]]);
  });

  it("a failed pre-read is logged and does not block the restore (audit rows get null enrichment)", async () => {
    db.seed("test_requests", [tr("m1", { deleted_at: T })]);
    db.hooks.readError = () => ({ code: "XX000", message: "boom" });
    db.hooks.rpc = () => ({ data: 1, error: null });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await restorePanelMembers(session, db.client() as never, {
      visitId: "visit-1", members: [{ id: "m1", deletedAt: T }], reason: "x",
    });
    expect(r).toEqual({ ok: true, restoredIds: ["m1"] });
    expect(db.rpcCalls).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(
      "restorePanelMembers pre-read failed",
      { visitId: "visit-1", error: { code: "XX000", message: "boom" } },
    );
    const a = h.audit.mock.calls[0]![0] as Record<string, unknown>;
    expect(a.patient_id).toBeNull();
    expect(a.metadata).toMatchObject({
      service_name: null, service_code: null, prior_delete_reason: null, prior_deleted_at: T,
    });
    spy.mockRestore();
  });
});
