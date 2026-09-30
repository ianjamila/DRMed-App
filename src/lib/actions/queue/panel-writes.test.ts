import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The all-or-nothing chemistry-panel writes, against a chainable fake Supabase
 * client. What is pinned here is the AUDIT each write leaves, because the bulk
 * Undo (planQueueUndo) rebuilds its reversal from those rows alone:
 *
 *   claim   -> started_at (the exact value the claim wrote, read back)
 *   unclaim -> previous_assignee + previous_started_at
 *
 * and, when the write belongs to a bulk batch, bulk_batch_id / bulk_batch_size
 * / panel_key on EVERY per-member row. Without a batch each write keeps the
 * shape the panel page and the row buttons rely on.
 */

// Something in the import graph (the supabase server client type's module,
// pulled in by a value import) is server-only; neutralise it like the sibling
// journal-entry tests do.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "1.2.3.4", "user-agent": "vitest" }),
}));

const auditMock = vi.hoisted(() => vi.fn(async (entry: Record<string, unknown>) => void entry));
vi.mock("@/lib/audit/log", () => ({ audit: auditMock }));

import { claimPanelMembers, readBenchStartedAt, unclaimPanelMembers, type PanelBatchAudit } from "./panel-writes";
import type { StaffSession } from "@/lib/auth/require-staff";

type Err = { code?: string; message?: string } | null;

const fx = vi.hoisted(() => ({
  rpcError: null as { code?: string; message?: string } | null,
  readBackError: null as { code?: string; message?: string } | null,
  // What the post-claim read-back returns (null = omit a member).
  readBack: [] as Array<{ id: string; started_at: string | null }>,
  members: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  readBackFilters: [] as Array<[string, unknown[]]>,
}));

function makeBuilder(select: string) {
  const isReadBack = select.startsWith("id, started_at");
  const filters: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  const chain = (name: string) => (...args: unknown[]) => {
    filters.push([name, args]);
    return builder;
  };
  builder.in = chain("in");
  builder.eq = chain("eq");
  builder.is = chain("is");
  builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve()
      .then(() => {
        if (isReadBack) {
          fx.readBackFilters = filters;
          return fx.readBackError
            ? { data: null, error: fx.readBackError }
            : { data: fx.readBack, error: null };
        }
        return { data: fx.members, error: null };
      })
      .then(resolve, reject);
  return builder;
}

const supabase = {
  from: () => ({ select: (cols: string) => makeBuilder(cols) }),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    fx.rpcCalls.push({ fn, args });
    return { data: null, error: fx.rpcError as Err };
  },
} as unknown as Parameters<typeof claimPanelMembers>[1];

const session = { user_id: "staff-1", role: "admin" } as unknown as StaffSession;

const IDS = ["t1", "t2", "t3"];
const batch: PanelBatchAudit = {
  batchId: "batch-1",
  batchSize: 4,
  panelKey: "panel:v1:g1",
  visitId: "v1",
};
const member = (id: string) => ({
  id,
  status: "requested",
  deleted_at: null,
  services: { section: "chemistry", name: `Test ${id}` },
  visits: { deleted_at: null, payment_status: "paid", hmo_provider_id: null },
});

const auditCalls = () => auditMock.mock.calls.map((c) => c[0] as Record<string, unknown>);

beforeEach(() => {
  auditMock.mockClear();
  fx.rpcError = null;
  fx.readBackError = null;
  fx.rpcCalls = [];
  fx.readBackFilters = [];
  fx.members = IDS.map(member);
  fx.readBack = IDS.map((id) => ({ id, started_at: `2026-09-30T01:00:0${IDS.indexOf(id)}.000000+00:00` }));
});

describe("claimPanelMembers with a batch", () => {
  it("reads the members' started_at back, held by the caller and in progress", async () => {
    const r = await claimPanelMembers(session, supabase, IDS, { report_group_id: "g1" }, batch);
    expect(r).toEqual({ ok: true });
    expect(fx.rpcCalls).toEqual([{ fn: "claim_panel_members", args: { p_test_request_ids: IDS } }]);
    expect(fx.readBackFilters).toEqual([
      ["in", ["id", IDS]],
      ["eq", ["assigned_to", "staff-1"]],
      ["eq", ["status", "in_progress"]],
      // a line deleted (or on a deleted visit) since reads as missing — Undo refuses it
      ["is", ["deleted_at", null]],
      ["is", ["visits.deleted_at", null]],
    ]);
  });

  it("writes one claimed row per member, keyed by resource_id, and no grouped null row", async () => {
    await claimPanelMembers(session, supabase, IDS, { report_group_id: "g1" }, batch);
    const rows = auditCalls();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.action === "test_request.claimed")).toBe(true);
    expect(rows.some((r) => r.resource_id === null)).toBe(false);
    for (const [i, id] of IDS.entries()) {
      const row = rows[i]!;
      expect(row).toMatchObject({
        actor_id: "staff-1",
        actor_type: "staff",
        resource_type: "test_request",
        resource_id: id,
      });
      expect(row.metadata).toEqual({
        visit_id: "v1",
        started_at: `2026-09-30T01:00:0${i}.000000+00:00`,
        panel_key: "panel:v1:g1",
        bulk_batch_id: "batch-1",
        bulk_batch_size: 4,
        grouped: true,
        report_group_id: "g1",
      });
    }
  });

  it("a caller's own audit extras cannot override the batch identity", async () => {
    await claimPanelMembers(
      session,
      supabase,
      IDS,
      { bulk_batch_id: "forged", panel_key: "forged", bulk_batch_size: 999 },
      batch,
    );
    for (const row of auditCalls()) {
      expect(row.metadata).toMatchObject({ bulk_batch_id: "batch-1", panel_key: "panel:v1:g1", bulk_batch_size: 4 });
    }
  });

  it("a failed read-back still writes every member's row, with started_at null and outcome_unverified", async () => {
    fx.readBackError = { message: "boom" };
    const r = await claimPanelMembers(session, supabase, IDS, { report_group_id: "g1" }, batch);
    expect(r).toEqual({ ok: true });
    const rows = auditCalls();
    expect(rows.map((x) => x.resource_id)).toEqual(IDS);
    for (const row of rows) {
      expect(row.metadata).toMatchObject({
        started_at: null,
        outcome_unverified: true,
        bulk_batch_id: "batch-1",
        panel_key: "panel:v1:g1",
      });
    }
  });

  it("a member missing from the read-back is written unverified; the others keep their started_at", async () => {
    fx.readBack = [{ id: "t1", started_at: "2026-09-30T01:00:00.000000+00:00" }];
    await claimPanelMembers(session, supabase, IDS, {}, batch);
    const byId = new Map(auditCalls().map((r) => [r.resource_id as string, r.metadata as Record<string, unknown>]));
    expect(byId.get("t1")).toMatchObject({ started_at: "2026-09-30T01:00:00.000000+00:00" });
    expect(byId.get("t1")).not.toHaveProperty("outcome_unverified");
    expect(byId.get("t2")).toMatchObject({ started_at: null, outcome_unverified: true });
    expect(byId.get("t3")).toMatchObject({ started_at: null, outcome_unverified: true });
  });

  it("an RPC refusal writes no audit rows and never reads back", async () => {
    fx.rpcError = { code: "P0077", message: "panel changed" };
    const r = await claimPanelMembers(session, supabase, IDS, {}, batch);
    expect(r.ok).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
    expect(fx.readBackFilters).toEqual([]);
  });
});

describe("claimPanelMembers without a batch", () => {
  it("keeps the single grouped row the panel page and the row Claim button use", async () => {
    const r = await claimPanelMembers(session, supabase, IDS, { visit_id: "v1", report_group_id: "g1" });
    expect(r).toEqual({ ok: true });
    const rows = auditCalls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "test_request.claimed",
      resource_type: "test_request",
      resource_id: null,
      metadata: { test_request_ids: IDS, grouped: true, visit_id: "v1", report_group_id: "g1" },
    });
    expect(rows[0]!.metadata).not.toHaveProperty("bulk_batch_id");
    // No read-back either: only a batch needs the exact started_at.
    expect(fx.readBackFilters).toEqual([]);
  });
});

describe("unclaimPanelMembers", () => {
  const members = [
    { id: "t1", holder: "staff-9" },
    { id: "t2", holder: "staff-9" },
  ];
  const args = {
    members,
    visitIdOf: () => "v1",
    reason: "wrong bench",
    selfService: false,
  };

  it("with a batch adds the batch identity, panel_key and previous_started_at per member", async () => {
    const startedAt: Record<string, string | null> = {
      t1: "2026-09-30T00:10:00.000000+00:00",
      t2: null,
    };
    const r = await unclaimPanelMembers(session, supabase, {
      ...args,
      batch,
      startedAtOf: (id) => startedAt[id] ?? null,
    });
    expect(r).toEqual({ ok: true });
    const rows = auditCalls();
    expect(rows.map((x) => x.resource_id)).toEqual(["t1", "t2"]);
    expect(rows.every((x) => x.action === "test_request.unclaimed")).toBe(true);
    expect(rows[0]!.metadata).toEqual({
      visit_id: "v1",
      previous_assignee: "staff-9",
      previous_started_at: "2026-09-30T00:10:00.000000+00:00",
      reason: "wrong bench",
      self_service: false,
      grouped: true,
      panel_key: "panel:v1:g1",
      bulk_batch_id: "batch-1",
      bulk_batch_size: 4,
    });
    expect(rows[1]!.metadata).toMatchObject({ previous_assignee: "staff-9", previous_started_at: null });
  });

  it("without a batch keeps the original shape", async () => {
    await unclaimPanelMembers(session, supabase, args);
    const rows = auditCalls();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.metadata).toEqual({
      visit_id: "v1",
      previous_assignee: "staff-9",
      reason: "wrong bench",
      self_service: false,
      grouped: true,
    });
  });

  it("an RPC error writes no audit rows and reports ok:false", async () => {
    fx.rpcError = { code: "P0077", message: "panel changed" };
    const r = await unclaimPanelMembers(session, supabase, { ...args, batch, startedAtOf: () => null });
    expect(r.ok).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("readBenchStartedAt", () => {
  it("returns each member's started_at from one query", async () => {
    fx.readBack = [
      { id: "t1", started_at: "2026-09-30T00:10:00.000000+00:00" },
      { id: "t2", started_at: null },
    ];
    // The fake answers the id/started_at select the same way for any filter chain.
    const r = await readBenchStartedAt(supabase, ["t1", "t2"]);
    expect(r).toEqual({
      ok: true,
      startedAtById: new Map([
        ["t1", "2026-09-30T00:10:00.000000+00:00"],
        ["t2", null],
      ]),
    });
  });

  it("reports ok:false when the read fails, so the caller can fail closed", async () => {
    fx.readBackError = { message: "boom" };
    expect(await readBenchStartedAt(supabase, ["t1"])).toEqual({ ok: false });
  });

  it("does not query at all for an empty list", async () => {
    fx.readBackFilters = [];
    expect(await readBenchStartedAt(supabase, [])).toEqual({ ok: true, startedAtById: new Map() });
    expect(fx.readBackFilters).toEqual([]);
  });
});
