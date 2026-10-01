import { beforeEach, describe, expect, it, vi } from "vitest";

// deleteVisitAction's `visit.deleted` audit row records where a SAMPLE-visit
// delete came from. Only "queue" / "queue_bulk" are written: a forged value
// must never become arbitrary audit metadata.

vi.mock("server-only", () => ({}));
const fx = vi.hoisted(() => ({ audits: [] as Array<{ metadata: Record<string, unknown> }> }));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: "u1", role: "admin" }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from() {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "update"]) q[m] = () => q;
      q.maybeSingle = async () => ({
        data: { id: "v1", visit_number: "7", patient_id: "p1", total_php: 100, payment_status: "unpaid", deleted_at: null, test_requests: [] },
        error: null,
      });
      q.then = (res: (v: unknown) => unknown) => res({ error: null });
      return q;
    },
  }),
}));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: { metadata: Record<string, unknown> }) => void fx.audits.push(e) }));
vi.mock("@/lib/server/action-helpers", () => ({ ipAndAgent: async () => ({ ip: null, ua: null }) }));
vi.mock("@/lib/patients/require-active", () => ({ assertVisitPatientActive: async () => ({ ok: true }) }));
vi.mock("@/lib/actions/queue/bulk-delete-core", () => ({
  deleteTestRequestsForVisit: async () => {},
  NOT_QUEUE_DELETE_STAFF: "no",
  parseQueueDeleteReason: (r: string) => ({ ok: true, reason: r }),
}));
vi.mock("@/lib/actions/visits/queue-restore-core", () => ({
  revalidateQueueSurfaces: () => {},
  restoreTestRequestsForVisit: async () => {},
}));

const { deleteVisitAction } = await import("./queue-deletion");

beforeEach(() => {
  fx.audits.length = 0;
});

describe("deleteVisitAction audit source marker", () => {
  it.each(["queue", "queue_bulk"])("records source %s", async (source) => {
    expect(await deleteVisitAction("v1", "demo", source)).toEqual({ ok: true, count: 1 });
    expect(fx.audits[0].metadata.source).toBe(source);
  });

  it("writes no source for a plain delete or a forged value", async () => {
    await deleteVisitAction("v1", "demo");
    await deleteVisitAction("v1", "demo", "<script>");
    expect(fx.audits).toHaveLength(2);
    for (const a of fx.audits) expect(a.metadata).not.toHaveProperty("source");
  });
});
