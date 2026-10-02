import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The report page's own Claim (claimConsolidated) mints a one-panel Undo batch,
 * exactly as the queue row's panel Claim does, so the notice the page then
 * renders has something to undo. Runs the real claimPanelMembers and the real
 * undoBulkQueueAction against the in-memory fake client; only the edges
 * (session, audit writer, headers/cache) are stubbed. The audit stub writes
 * into the fake's audit_log so Undo reads back what the claim wrote.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "9.9.9.9", "user-agent": "vitest" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const h = vi.hoisted(() => ({
  session: { user_id: "user-admin", role: "admin" } as { user_id: string; role: string },
  db: null as unknown,
  audit: vi.fn(async (entry: Record<string, unknown>) => {
    const d = h.db as { seed: (t: string, rows: Record<string, unknown>[]) => void };
    h.seq += 1;
    d.seed("audit_log", [
      {
        id: `a-${String(h.seq).padStart(5, "0")}`,
        actor_id: entry.actor_id,
        resource_type: entry.resource_type,
        resource_id: entry.resource_id,
        action: entry.action,
        metadata: entry.metadata,
        created_at: new Date().toISOString(),
      },
    ]);
  }),
  seq: 0,
}));

vi.mock("@/lib/auth/require-staff", () => ({ requireActiveStaff: async () => h.session }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as FakeDb).client() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/audit/log", () => ({ audit: h.audit }));
vi.mock("@/lib/patients/require-active", () => ({
  assertVisitPatientActive: async () => ({ ok: true }),
}));

import { revalidatePath } from "next/cache";
import { claimConsolidated } from "./actions";
import { undoBulkQueueAction } from "../../../actions";
import { FakeDb, type Row } from "@/lib/testing/fake-db";
import { panelRowKey } from "@/lib/queue/bulk-queue";

const VISIT = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = panelRowKey(VISIT, GROUP);
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

let db: FakeDb;
const auditRows = () => h.audit.mock.calls.map((c) => c[0] as Record<string, unknown>);
const meta = (a: Record<string, unknown>) => a.metadata as Record<string, unknown>;

function tr(id: string): Row {
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
    visits: { id: VISIT, deleted_at: null, payment_status: "paid", hmo_provider_id: null, patient_id: "patient-1" },
  };
}

/** claim_panel_members (0191): every member requested + live, or nothing changes. */
function installRpcs(dbx: FakeDb) {
  dbx.hooks.rpc = (rec, d) => {
    const ids = rec.args.p_test_request_ids as string[];
    const rows = ids.map((id) => d.row("test_requests", id));
    if (rec.fn === "claim_panel_members") {
      if (!rows.every((r) => r.status === "requested" && r.deleted_at === null)) {
        return { error: { code: "P0077", message: "Some tests in this report were already claimed or changed status." } };
      }
      for (const r of rows) {
        Object.assign(r, { status: "in_progress", assigned_to: h.session.user_id, started_at: new Date().toISOString() });
      }
      return { error: null };
    }
    if (rec.fn === "unclaim_panel_members") {
      const holders = rec.args.p_holders as string[];
      if (!rows.every((r, i) => r.status === "in_progress" && r.assigned_to === holders[i] && r.deleted_at === null)) {
        return { error: { code: "P0077", message: "Some tests in this report were already claimed or changed status." } };
      }
      for (const r of rows) Object.assign(r, { status: "requested", assigned_to: null, started_at: null });
      return { error: null };
    }
    throw new Error(`unexpected rpc ${rec.fn}`);
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = new FakeDb();
  h.db = db;
  h.seq = 0;
  h.session = { user_id: "user-admin", role: "admin" };
  h.audit.mockClear();
  vi.mocked(revalidatePath).mockClear();
  db.seed("test_requests", [tr(M1), tr(M2)]);
  installRpcs(db);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("claimConsolidated (the report page's Claim)", () => {
  it("returns a batch id minted here and audits every member under a one-panel batch", async () => {
    const r = await claimConsolidated({ visitId: VISIT, groupId: GROUP, testRequestIds: [M1, M2] });
    expect(r.ok).toBe(true);
    const batchId = (r as { ok: true; batchId?: string }).batchId;
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/i);

    const rows = auditRows();
    expect(rows.map((a) => [a.action, a.resource_id])).toEqual([
      ["test_request.claimed", M1],
      ["test_request.claimed", M2],
    ]);
    for (const a of rows) {
      expect(meta(a)).toMatchObject({
        bulk_batch_id: batchId,
        bulk_batch_size: 1,
        panel_key: KEY,
        visit_id: VISIT,
        report_group_id: GROUP,
        grouped: true,
        started_at: new Date(NOW).toISOString(),
      });
    }
    expect(vi.mocked(revalidatePath).mock.calls.map((c) => c[0])).toContain("/staff/queue");
  });

  it("ignores a batch id the browser sends and mints a fresh one per call", async () => {
    const a = await claimConsolidated({ visitId: VISIT, groupId: GROUP, testRequestIds: [M1], batchId: "evil" });
    db.seed("test_requests", [tr("cccccccc-cccc-4ccc-8ccc-cccccccccccc")]);
    const b = await claimConsolidated({
      visitId: VISIT,
      groupId: GROUP,
      testRequestIds: ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
    });
    expect(a).toMatchObject({ ok: true });
    expect((a as { batchId?: string }).batchId).not.toBe("evil");
    expect((a as { batchId?: string }).batchId).not.toBe((b as { batchId?: string }).batchId);
  });

  it.each([
    ["no visitId", { groupId: GROUP, testRequestIds: [M1] }],
    ["no groupId", { visitId: VISIT, testRequestIds: [M1] }],
    ["a malformed visitId", { visitId: "nope", groupId: GROUP, testRequestIds: [M1] }],
    ["a malformed groupId", { visitId: VISIT, groupId: "nope", testRequestIds: [M1] }],
    ["no test ids", { visitId: VISIT, groupId: GROUP, testRequestIds: [] }],
  ])("refuses %s on the parse-error path, writing nothing", async (_name, input) => {
    const r = await claimConsolidated(input);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toEqual(expect.any(String));
    expect(db.rpcCalls).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("returns no batch id and writes no audit when the claim is refused", async () => {
    db.row("test_requests", M2).status = "in_progress";
    const r = await claimConsolidated({ visitId: VISIT, groupId: GROUP, testRequestIds: [M1, M2] });
    expect(r).toEqual({ ok: false, error: "Some tests in this report were already claimed or changed status." });
    expect(h.audit).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("round trip: undoBulkQueueAction({ batchId }) puts the whole panel back through unclaim_panel_members", async () => {
    const claim = await claimConsolidated({ visitId: VISIT, groupId: GROUP, testRequestIds: [M1, M2] });
    const batchId = (claim as { ok: true; batchId: string }).batchId;
    for (const id of [M1, M2]) {
      expect(db.row("test_requests", id)).toMatchObject({ status: "in_progress", assigned_to: "user-admin" });
    }

    const undo = await undoBulkQueueAction({ batchId });
    expect(undo).toMatchObject({ ok: true, restoredIds: [KEY], restoredTestCount: 2, notRestored: [] });
    expect(db.rpcCalls.map((c) => c.fn)).toEqual(["claim_panel_members", "unclaim_panel_members"]);
    for (const id of [M1, M2]) {
      expect(db.row("test_requests", id)).toMatchObject({ status: "requested", assigned_to: null, started_at: null });
    }
  });
});
