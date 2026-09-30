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

import { makeFakeReleaseDb, type FakeTestRow } from "@/lib/actions/visits/fake-release-db";
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
    const written = fake.calls.find((c) => c.table === "test_requests" && c.op === "update");
    expect(written?.patch?.release_medium).toBe("other");
    const lineAudits = audits.filter((a) => a.action === "test_request.released");
    expect(lineAudits).toHaveLength(3);
    for (const a of lineAudits) {
      expect(a.metadata).toMatchObject({ source: "finalise_consolidated", result_id: "r1", release_medium: "other" });
    }
  });

  it("a ONE-test report awaiting sign-off reads as sign-off, not a raced release", async () => {
    const { fake, summary, outcome } = await finaliseRelease([{ id: "a", status: "result_uploaded" }], undefined, ["a"]);
    expect(summary).toEqual({ releaseDeferred: true, deferredReason: "signoff", releaseNote: null });
    expect(outcome).toBeNull();
    expect(fake.calls.some((c) => c.op === "update")).toBe(false);
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
    expect(fake.calls.some((c) => c.table === "test_requests" && c.op === "update")).toBe(false);
    expect(summary).toEqual({ releaseDeferred: true, deferredReason: "signoff", releaseNote: null });
    expect(fx.notified).toHaveLength(0);
    expect(fx.alerts).toHaveLength(0);
  });

  it("the payment gate defers the whole report as payment, no notice", async () => {
    const { fake, summary } = await finaliseRelease(ids.map((id) => ({ id })), (f) =>
      f.failNext("test_requests", "update-error", {
        code: "23514",
        message: "visit payment_status must be paid before release",
      }),
    );
    expect(released(fake)).toEqual([]);
    expect(summary.deferredReason).toBe("payment");
    expect(fx.notified).toHaveLength(0);
  });

  it("a race that releases part of the report is reported, and the patient is not told", async () => {
    const { summary } = await finaliseRelease(ids.map((id) => ({ id })), (f) => f.failNext("test_requests", "update-partial"));
    expect(summary.releaseDeferred).toBe(true);
    expect(summary.deferredReason).toBe("other");
    expect(summary.releaseNote).toBeTruthy();
    expect(fx.notified).toHaveLength(0);
    expect(fx.alerts).toHaveLength(0);
  });
});
