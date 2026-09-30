// finalise-consolidated step 9 (releaseFinalisedReport) end to end over the
// fake release DB. The action around it renders a PDF and commits values; the
// release half is exercised here on its own, through the function it calls.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "ua" }) }));
const fx = vi.hoisted(() => ({
  notified: [] as Array<{ testRequestIds?: string[]; testRequestId?: string; releaseMedium?: string }>,
  alerts: [] as Array<[string, number]>,
}));
const audits = vi.hoisted(() => [] as Array<{ action: string; metadata: Record<string, unknown> }>);
vi.mock("@/lib/audit/log", () => ({
  audit: async (a: { action: string; metadata: Record<string, unknown> }) => void audits.push(a),
}));
vi.mock("@/lib/notifications/notify-released", () => ({
  notifyResultReleased: async (a: { testRequestId: string }) => void fx.notified.push(a),
}));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({
  notifyResultsReleasedBulk: async (a: { testRequestIds: string[] }) => void fx.notified.push(a),
}));
vi.mock("@/lib/notifications/release-staff-alert", () => ({
  scheduleReleaseStaffAlert: (v: string, n: number) => void fx.alerts.push([v, n]),
}));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));

import { FAKE_RELEASED_AT, makeFakeReleaseDb, type FakeTestRow } from "@/lib/actions/visits/fake-release-db";
import { releaseFinalisedReport } from "./finalise-release";

const session = { user_id: "u1", role: "medtech" } as never;
const ids = ["a", "b", "c"];

async function finaliseRelease(
  rows: FakeTestRow[],
  prep?: (fake: ReturnType<typeof makeFakeReleaseDb>) => void,
  members: string[] = ids,
) {
  const fake = makeFakeReleaseDb({ rows, links: members.map((id) => ({ testRequestId: id, resultId: "r1" })) });
  prep?.(fake);
  const { outcome, ...summary } = await releaseFinalisedReport({
    supabase: fake.client,
    session,
    visitId: "v1",
    resultId: "r1",
    testRequestIds: members,
  });
  return { fake, outcome, summary };
}
const released = (fake: ReturnType<typeof makeFakeReleaseDb>) =>
  fake.rows.filter((r) => r.status === "released").map((r) => r.id);

beforeEach(() => {
  audits.length = 0;
  fx.notified.length = 0;
  fx.alerts.length = 0;
});

describe("finalise-consolidated release (step 9)", () => {
  it("releases the whole ready report, tells the patient once and alerts reception", async () => {
    const { fake, summary } = await finaliseRelease(ids.map((id) => ({ id })));
    expect(released(fake).sort()).toEqual(ids);
    expect(summary).toEqual({ releaseDeferred: false, deferredReason: null, releaseNote: null });
    expect(fx.notified).toHaveLength(1);
    expect(fx.notified[0].testRequestIds?.slice().sort()).toEqual(ids);
    expect(fx.notified[0].releaseMedium).toBe("other");
    expect(fx.alerts).toEqual([["v1", 3]]);
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0]).toEqual({
      name: "release_visit_results",
      args: {
        p_visit_id: "v1",
        p_test_request_ids: ids,
        p_medium: "other",
        p_actor: "u1",
        // The database writes the audit rows (0205): exactly the caller extras
        // (finalise mints no Undo batch), plus the request's ip / user agent.
        p_audit: { metadata: { source: "finalise_consolidated", result_id: "r1" }, ip: null, user_agent: "ua" },
      },
    });
    // The TypeScript side no longer writes the row: a copy would double-write.
    expect(audits.filter((a) => a.action === "test_request.released")).toHaveLength(0);
    // What the database (as modelled by the fake) writes from that argument.
    expect(fake.dbAudits).toHaveLength(3);
    for (const a of fake.dbAudits) {
      expect(a.metadata).toMatchObject({ source: "finalise_consolidated", result_id: "r1", release_medium: "other", released_at: FAKE_RELEASED_AT });
      expect(a.metadata).not.toHaveProperty("bulk_batch_id");
    }
  });

  it("a released row the database returns without released_at is malformed: nothing audited or announced, reads as deferred", async () => {
    const { outcome, summary } = await finaliseRelease(ids.map((id) => ({ id })), (fake) =>
      fake.overrideNextRpc("release_visit_results", {
        released: ids.map((id) => ({ id, name: id, report_id: "r1", selected: true })),
        refused: [],
      }),
    );
    expect(audits.filter((a) => a.action === "test_request.released")).toHaveLength(0);
    expect(fx.notified).toHaveLength(0);
    expect(fx.alerts).toHaveLength(0);
    expect(outcome?.changedIds ?? []).toEqual([]);
    expect(summary.releaseDeferred).toBe(true);
  });

  it("a ONE-test report awaiting sign-off reads as sign-off, not a raced release", async () => {
    const { fake, summary, outcome } = await finaliseRelease([{ id: "a", status: "result_uploaded" }], undefined, ["a"]);
    expect(summary).toEqual({ releaseDeferred: true, deferredReason: "signoff", releaseNote: null });
    expect(outcome).toBeNull();
    expect(fake.rpcCalls).toHaveLength(0);
    expect(fx.notified).toHaveLength(0);
  });

  it("a one-test report that is ready releases and tells the patient", async () => {
    const { fake, summary } = await finaliseRelease([{ id: "a" }], undefined, ["a"]);
    expect(released(fake)).toEqual(["a"]);
    expect(summary.releaseDeferred).toBe(false);
    expect(fx.notified).toEqual([expect.objectContaining({ testRequestId: "a" })]);
  });

  it("releases NOTHING while one member awaits sign-off — no part-report, no notice", async () => {
    const { fake, summary } = await finaliseRelease([{ id: "a" }, { id: "b", status: "result_uploaded" }, { id: "c" }]);
    expect(released(fake)).toEqual([]);
    expect(fake.rpcCalls).toHaveLength(0);
    expect(summary).toEqual({ releaseDeferred: true, deferredReason: "signoff", releaseNote: null });
    expect(fx.notified).toHaveLength(0);
    expect(fx.alerts).toHaveLength(0);
  });

  it("the payment gate defers the whole report as payment, no notice", async () => {
    const { fake, summary } = await finaliseRelease(ids.map((id) => ({ id })), (f) =>
      f.failNextRpc("release_visit_results", {
        code: "23514",
        message: "visit payment_status must be paid before release",
      }),
    );
    expect(released(fake)).toEqual([]);
    expect(summary.deferredReason).toBe("payment");
    expect(fx.notified).toHaveLength(0);
  });

  it("a member goes stale between the sign-off check and the write: the database refuses the whole report, read as sign-off, no notice", async () => {
    const { fake, summary } = await finaliseRelease(ids.map((id) => ({ id })), (f) => {
      f.hooks.beforeRpc = () => {
        f.rows.find((r) => r.id === "b")!.status = "result_uploaded";
      };
    });
    expect(released(fake)).toEqual([]);
    expect(summary).toEqual({ releaseDeferred: true, deferredReason: "signoff", releaseNote: null });
    expect(fx.notified).toHaveLength(0);
    expect(fx.alerts).toHaveLength(0);
  });

  it("a report the database refuses for another reason defers as other, with that wording", async () => {
    const { summary } = await finaliseRelease(ids.map((id) => ({ id })), (f) => {
      f.rows.find((r) => r.id === "c")!.deleted = true;
      f.rows.find((r) => r.id === "c")!.status = "requested";
    });
    expect(summary.releaseDeferred).toBe(true);
    expect(summary.deferredReason).toBe("other");
    expect(summary.releaseNote).toBeTruthy();
    expect(fx.notified).toHaveLength(0);
  });
});
