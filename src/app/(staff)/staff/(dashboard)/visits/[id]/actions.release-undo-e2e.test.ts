import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// End to end, nothing between the two actions mocked except auth, the
// clock and the patient notice: release (queue or visit page) -> the
// database's own audit rows (0205, modelled by fake-release-db) -> the REAL
// loadOwnBatchRows over those rows -> undoReleaseBatchAction -> undo_visit_release.

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "1.2.3.4", "user-agent": "ua" }),
}));
const fx = vi.hoisted(() => ({
  user: "u1" as string,
  role: "medtech" as string,
  release: null as unknown,
  auditDb: null as unknown,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: fx.user, role: fx.role, actual_role: fx.role, view_as: null }),
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: async () => ({ user_id: fx.user, role: "admin" }) }));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: async () => ({ ok: true }) }));
vi.mock("@/lib/consent/gate", () => ({ isConsentGateRequired: async () => false, getConsentCurrentByPatient: async () => new Map() }));
vi.mock("@/lib/audit/log", () => ({ audit: async () => {} }));
vi.mock("@/lib/notifications/notify-released", () => ({ notifyResultReleased: async () => ({ status: "sent", channels: ["email"], reason: null }) }));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({ notifyResultsReleasedBulk: async () => ({ status: "sent", channels: ["email"], reason: null }) }));
vi.mock("@/lib/notifications/release-staff-alert", () => ({ scheduleReleaseStaffAlert: () => {} }));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({ deleteVisitAction: async () => ({ ok: true }) }));
// Staff client = the release model (+ live visits); admin client = audit_log only.
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fx.release }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (fx.auditDb as FakeDb).client() }));

import { FakeDb } from "@/lib/testing/fake-db";
import { makeFakeReleaseDb, type FakeLink, type FakeTestRow } from "@/lib/actions/visits/fake-release-db";
import { RELEASED_SEPARATELY_REASON } from "@/lib/actions/visits/release-undo-refusal";
import { CHANGED_SINCE_REASON, UNDO_ALREADY, UNDO_EXPIRED } from "@/lib/ui/bulk-undo";

const { undoReleaseBatchAction, releaseSelectedAction } = await import("./actions");
const { releaseTestsAction } = await import("../../queue/actions");

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, X] = [u(1), u(2), u(4)];
const T0 = Date.parse("2026-10-01T02:00:00.000Z");
let mirrored = 0;
let fake: ReturnType<typeof makeFakeReleaseDb>;

function world(rows: FakeTestRow[], links: FakeLink[] = []) {
  fake = makeFakeReleaseDb({ rows, links, actorRole: () => fx.role });
  const inner = fake.client as { from: (t: string) => Record<string, unknown>; rpc: unknown };
  fx.release = {
    rpc: inner.rpc,
    from(table: string) {
      if (table === "visits") {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is"]) q[m] = () => q;
        q.maybeSingle = async () => ({ data: { deleted_at: null }, error: null });
        return q;
      }
      return inner.from(table);
    },
  };
  fx.auditDb = new FakeDb();
  mirrored = 0;
}
/** Copy the database's new audit rows into audit_log, stamped "now" (the faked clock). */
function mirror() {
  const fresh = fake.dbAudits.slice(mirrored);
  mirrored = fake.dbAudits.length;
  (fx.auditDb as FakeDb).seed(
    "audit_log",
    fresh.map((a, i) => ({ id: `al-${mirrored}-${i}`, ...a, created_at: new Date(Date.now()).toISOString() })),
  );
}
const status = (id: string) => fake.rows.find((r) => r.id === id)!.status;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  fx.user = "u1";
  fx.role = "medtech";
});
afterEach(() => vi.useRealTimers());

describe("release -> Undo, end to end", () => {
  it("Queue: report-mates in the batch come back together, across two visits", async () => {
    world(
      [
        { id: A, visitId: "v1" }, { id: B, visitId: "v1" }, // report r1
        { id: X, visitId: "v2" },
      ],
      [{ testRequestId: A, resultId: "r1" }, { testRequestId: B, resultId: "r1" }],
    );
    const rel = await releaseTestsAction({ testRequestIds: [A, X], medium: "email" });
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    expect(rel.alsoReleasedIds).toEqual([B]);
    mirror();
    vi.setSystemTime(T0 + 5 * 60_000);
    const res = await undoReleaseBatchAction({ batchId: rel.batchId });
    expect(res).toEqual({ ok: true, restoredIds: [A, B, X], notRestored: [] });
    expect([A, B, X].map(status)).toEqual(["ready_for_release", "ready_for_release", "ready_for_release"]);
  });

  it("a mate released OUTSIDE the batch refuses the whole report with the released-separately reason", async () => {
    world(
      [{ id: A }, { id: B, status: "released", releasedAt: "2026-10-01T01:00:00.000001+00:00" }, { id: X }],
      [{ testRequestId: A, resultId: "r1" }, { testRequestId: B, resultId: "r1" }],
    );
    const rel = await releaseSelectedAction("v1", [A, X], "email");
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    mirror();
    const res = await undoReleaseBatchAction({ batchId: rel.batchId });
    expect(res).toEqual({ ok: true, restoredIds: [X], notRestored: [{ id: A, reason: RELEASED_SEPARATELY_REASON }] });
    expect([status(A), status(B)]).toEqual(["released", "released"]);
  });

  it("a mate changed since INSIDE the batch keeps the generic reason", async () => {
    world([{ id: A }, { id: B }], [{ testRequestId: A, resultId: "r1" }, { testRequestId: B, resultId: "r1" }]);
    const rel = await releaseSelectedAction("v1", [A, B], "email");
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    mirror();
    // Someone else touched B after the batch (any newer audit row outside it).
    vi.setSystemTime(T0 + 60_000);
    (fx.auditDb as FakeDb).seed("audit_log", [{
      id: "foreign", actor_id: "u2", actor_type: "staff", action: "result.amended", resource_type: "test_request",
      resource_id: B, metadata: {}, created_at: new Date(Date.now()).toISOString(),
    }]);
    const res = await undoReleaseBatchAction({ batchId: rel.batchId });
    if (!res.ok) throw new Error(res.error);
    expect(res.restoredIds).toEqual([]);
    expect(res.notRestored.map((n) => [n.id, n.reason]).sort()).toEqual([[A, CHANGED_SINCE_REASON], [B, CHANGED_SINCE_REASON]].sort());
  });

  it("expired after 10 minutes", async () => {
    world([{ id: X }]);
    const rel = await releaseTestsAction({ testRequestIds: [X], medium: "physical" });
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    mirror();
    vi.setSystemTime(T0 + 10 * 60_000 + 1);
    expect(await undoReleaseBatchAction({ batchId: rel.batchId })).toEqual({ ok: false, error: UNDO_EXPIRED });
    expect(status(X)).toBe("released");
  });

  it("another actor cannot undo it (reads as expired — the batch is never disclosed)", async () => {
    world([{ id: X }]);
    const rel = await releaseTestsAction({ testRequestIds: [X], medium: "email" });
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    mirror();
    fx.user = "u2";
    expect(await undoReleaseBatchAction({ batchId: rel.batchId })).toEqual({ ok: false, error: UNDO_EXPIRED });
    expect(status(X)).toBe("released");
  });

  it("already undone: the second Undo refuses and writes nothing", async () => {
    world([{ id: X }]);
    const rel = await releaseTestsAction({ testRequestIds: [X], medium: "email" });
    if (!rel.ok || !rel.batchId) throw new Error("release failed");
    mirror();
    expect((await undoReleaseBatchAction({ batchId: rel.batchId })).ok).toBe(true);
    mirror();
    const calls = fake.rpcCalls.length;
    expect(await undoReleaseBatchAction({ batchId: rel.batchId })).toEqual({ ok: false, error: UNDO_ALREADY });
    expect(fake.rpcCalls.length).toBe(calls);
  });
});
