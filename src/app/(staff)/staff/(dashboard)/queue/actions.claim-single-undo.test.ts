import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * claimTestAction (the single-test Claim button) is a one-test "bulk" batch:
 * it mints a server-side batch id and writes the SAME audit metadata
 * claimTestsCore does (started_at, bulk_batch_id, bulk_batch_size), so the
 * bar's 10-minute Undo (undoBulkQueueAction) accepts it. Run end to end
 * against the in-memory fake client — the real claimTestAction,
 * withLifecycleRetry, loadOwnBatchRows and the Undo's own conditional write all
 * run; only the edges (session, audit writer, headers/cache, patient guard)
 * are stubbed. The audit mock appends into audit_log so the claim's own audit
 * row is what the Undo reads back.
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
  patientActive: vi.fn<(db?: unknown, visitId?: string) => Promise<{ ok: true } | { ok: false; error: string }>>(
    async () => ({ ok: true }),
  ),
}));

vi.mock("@/lib/auth/require-staff", () => ({ requireActiveStaff: async () => h.session }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (h.db as FakeDb).client() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (h.db as FakeDb).client() }));
vi.mock("@/lib/audit/log", () => ({ audit: h.audit }));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: h.patientActive }));

import { claimTestAction, undoBulkQueueAction } from "./actions";
import { FakeDb, type Row } from "@/lib/testing/fake-db";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const OTHER = "user-other";
const ID = "t1";
const VISIT = "visit-1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALREADY = "This test was already claimed or its status changed.";

let db: FakeDb;
let auditSeq = 0;
const meta = (a: Record<string, unknown>) => a.metadata as Record<string, unknown>;
const claimAudits = () =>
  h.audit.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((a) => a.action === "test_request.claimed");

function tr(over: Row = {}): Row {
  return {
    id: ID,
    visit_id: VISIT,
    status: "requested",
    assigned_to: null,
    started_at: null,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
    parent_id: null,
    is_package_header: false,
    services: { section: "chemistry", kind: "lab_test", name: "Svc", code: "C-1" },
    visits: { deleted_at: null, payment_status: "paid", hmo_provider_id: null, patient_id: "patient-1" },
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = new FakeDb();
  h.db = db;
  h.session = { user_id: "user-admin", role: "admin" };
  h.audit.mockReset();
  // Same wiring as production: the audit writer appends a row to audit_log.
  h.audit.mockImplementation(async (entry: Record<string, unknown>) => {
    auditSeq += 1;
    db.seed("audit_log", [
      { id: `a-${String(auditSeq).padStart(5, "0")}`, created_at: new Date().toISOString(), ...entry },
    ]);
  });
  auditSeq = 0;
  h.patientActive.mockReset();
  h.patientActive.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("claimTestAction records a one-test Undo batch", () => {
  it("returns a uuid batchId; the write's started_at equals the audit row's, which carries the batch metadata and no panel_key", async () => {
    db.seed("test_requests", [tr()]);
    const r = await claimTestAction(ID);

    expect(r).toEqual({ ok: true, batchId: expect.stringMatching(UUID) });
    const batchId = (r as { batchId: string }).batchId;

    const writes = db.updates("test_requests");
    expect(writes).toHaveLength(1);
    const startedAt = writes[0]!.patch!.started_at;
    expect(startedAt).toBe(new Date(NOW).toISOString());
    expect(writes[0]!.patch).toEqual({ status: "in_progress", assigned_to: "user-admin", started_at: startedAt });

    const audits = claimAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: "user-admin",
      actor_type: "staff",
      resource_type: "test_request",
      resource_id: ID,
    });
    expect(meta(audits[0]!)).toEqual({
      visit_id: VISIT,
      started_at: startedAt,
      bulk_batch_id: batchId,
      bulk_batch_size: 1,
    });
    expect(meta(audits[0]!)).not.toHaveProperty("panel_key");
  });

  it("predicates status = requested, assigned_to is null and deleted_at is null on the write", async () => {
    db.seed("test_requests", [tr()]);
    await claimTestAction(ID);
    const filters = db.updates("test_requests")[0]!.filters;
    expect(filters).toEqual(
      expect.arrayContaining([
        ["eq", ["id", ID]],
        ["eq", ["status", "requested"]],
        ["is", ["assigned_to", null]],
        ["is", ["deleted_at", null]],
      ]),
    );
  });

  it("refuses a requested row someone else already holds: nothing written, no audit", async () => {
    db.seed("test_requests", [tr({ assigned_to: OTHER })]);
    const r = await claimTestAction(ID);

    expect(r).toEqual({ ok: false, error: ALREADY });
    expect(db.row("test_requests", ID)).toMatchObject({ status: "requested", assigned_to: OTHER, started_at: null });
    expect(claimAudits()).toEqual([]);
  });

  it("round trip: the Undo accepts the claim's own audit row and puts the test back", async () => {
    db.seed("test_requests", [tr()]);
    const claim = await claimTestAction(ID);
    expect(claim.ok).toBe(true);
    expect(db.row("test_requests", ID)).toMatchObject({ status: "in_progress", assigned_to: "user-admin" });

    vi.setSystemTime(NOW + 60_000);
    const undo = await undoBulkQueueAction({ batchId: (claim as { batchId: string }).batchId });

    expect(undo).toEqual({ ok: true, restoredIds: [ID], restoredTestCount: 1, notRestored: [] });
    expect(db.row("test_requests", ID)).toMatchObject({ status: "requested", assigned_to: null, started_at: null });
  });

  it("a lost-race retry (40P01) re-sends the SAME started_at", async () => {
    db.seed("test_requests", [tr()]);
    let failed = false;
    db.hooks.beforeWrite = (call) => {
      if (call.table === "test_requests" && !failed) {
        failed = true;
        // the clock moves on before the retry — a closure that re-evaluates
        // new Date() would send a different value the second time
        vi.setSystemTime(NOW + 5_000);
        return { code: "40P01", message: "deadlock detected" };
      }
    };
    const r = await claimTestAction(ID);

    expect(r).toMatchObject({ ok: true });
    const writes = db.updates("test_requests");
    expect(writes).toHaveLength(2);
    expect(writes[0]!.patch!.started_at).toBe(new Date(NOW).toISOString());
    expect(writes[1]!.patch!.started_at).toBe(writes[0]!.patch!.started_at);
    expect(meta(claimAudits()[0]!).started_at).toBe(writes[0]!.patch!.started_at);
  });
});
