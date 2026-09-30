import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8", "user-agent": "ua" }),
}));
const fx = vi.hoisted(() => ({
  notified: [] as Array<{ testRequestIds?: string[]; testRequestId?: string }>,
  alerts: [] as Array<[string, number]>,
  audits: [] as Array<Record<string, unknown>>,
  reported: [] as Array<{ scope: string }>,
  notifyThrows: false,
}));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/notifications/notify-released", () => ({
  notifyResultReleased: async (a: { testRequestId: string }) => {
    if (fx.notifyThrows) throw new Error("boom");
    fx.notified.push(a);
  },
}));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({
  notifyResultsReleasedBulk: async (a: { testRequestIds: string[] }) => void fx.notified.push(a),
}));
vi.mock("@/lib/notifications/release-staff-alert", () => ({
  scheduleReleaseStaffAlert: (v: string, n: number) => void fx.alerts.push([v, n]),
}));
vi.mock("@/lib/observability/report-error", () => ({
  reportError: async (a: { scope: string }) => void fx.reported.push(a),
}));

import { RELEASE_BLOCKED_CONSENT, RELEASE_REFUSAL_PATIENT_INACTIVE } from "@/lib/visits/release-messages";
import { REPORT_REFUSAL } from "@/lib/queue/report-release-scope";
import { FAKE_RELEASED_AT, makeFakeReleaseDb, type FakeLink, type FakeTestRow } from "./fake-release-db";
import {
  COULDNT_CONFIRM_RELEASE,
  OUTSIDE_SECTIONS_REASON,
  RACED_REASON,
  notifyReleased,
  releaseVisitSelection,
} from "./release-reports";

const session = { user_id: "u1", role: "medtech" } as never;
function run(rows: FakeTestRow[], links: FakeLink[], selectedIds: string[], prep?: (f: ReturnType<typeof makeFakeReleaseDb>) => void, bulkBatchId?: string) {
  const fake = makeFakeReleaseDb({ rows, links });
  prep?.(fake);
  // Started a microtask later so a test can arm failures/overrides on `fake` after run() returns.
  const out = Promise.resolve().then(() =>
    releaseVisitSelection({
      supabase: fake.client,
      session,
      visitId: "v1",
      selectedIds,
      medium: "email",
      auditMeta: { source: "queue" },
      bulkBatchId,
    }),
  );
  return { fake, out };
}
const report = (result: string, ...ids: string[]): FakeLink[] => ids.map((id) => ({ testRequestId: id, resultId: result }));
const refusal = (id: string, code: string, count = 0) => ({ id, code, report_id: null, count });

beforeEach(() => {
  fx.notified.length = 0;
  fx.alerts.length = 0;
  fx.audits.length = 0;
  fx.reported.length = 0;
  fx.notifyThrows = false;
});

describe("releaseVisitSelection", () => {
  it("calls release_visit_results once with the deduped selection, the medium and the acting staff id", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b", "a"]);
    await out;
    expect(fake.rpcCalls).toEqual([
      {
        name: "release_visit_results",
        args: { p_visit_id: "v1", p_test_request_ids: ["a", "b"], p_medium: "email", p_actor: "u1" },
      },
    ]);
  });

  it("an empty selection makes no call and returns an empty outcome", async () => {
    const { fake, out } = run([{ id: "a" }], [], []);
    expect(await out).toEqual({ changedIds: [], alsoReleasedIds: [], skipped: [], warnings: [], announced: [] });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("splits selected rows from pulled-in report members and announces both, one alert with the total", async () => {
    const { out } = run([{ id: "a" }, { id: "b" }, { id: "c" }], report("r1", "a", "b"), ["a", "c"]);
    const o = await out;
    expect(o.changedIds).toEqual(["a", "c"]);
    expect(o.alsoReleasedIds).toEqual(["b"]);
    expect(o.announced.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    expect(o.announced.find((r) => r.id === "a")).toEqual({ id: "a", name: "A" });
    expect(o.skipped).toEqual([]);
    expect(o.warnings).toEqual([]);
    expect(fx.notified).toHaveLength(1);
    expect(fx.notified[0].testRequestIds?.slice().sort()).toEqual(["a", "b", "c"]);
    expect(fx.alerts).toEqual([["v1", 3]]);
  });

  it("a single released row gets the single-result notice", async () => {
    const { out } = run([{ id: "a" }], [], ["a"]);
    await out;
    expect(fx.notified).toEqual([{ testRequestId: "a", visitId: "v1", releaseMedium: "email" }]);
    expect(fx.alerts).toEqual([["v1", 1]]);
  });

  it("audits every released row (pulled-in ones too) with the exact metadata, ip and user agent, and nothing else", async () => {
    const { out } = run([{ id: "a" }, { id: "b" }, { id: "c", status: "result_uploaded" }], report("r1", "a", "b"), ["a", "c"]);
    await out;
    expect(fx.audits.map((a) => a.resource_id)).toEqual(["a", "b"]);
    for (const a of fx.audits) {
      expect(a).toEqual({
        actor_id: "u1",
        actor_type: "staff",
        action: "test_request.released",
        resource_type: "test_request",
        resource_id: a.resource_id,
        metadata: { visit_id: "v1", release_medium: "email", bulk: true, selection: true, source: "queue", released_at: FAKE_RELEASED_AT },
        ip_address: "1.2.3.4",
        user_agent: "ua",
      });
    }
  });

  it("each audit row carries the exact released_at string the RPC returned, unchanged (never through a JS Date)", async () => {
    const stamp = "2026-09-30T07:00:00.987654+00:00";
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b"]);
    fake.overrideNextRpc("release_visit_results", {
      released: [
        { id: "a", name: "A", report_id: null, selected: true, released_at: stamp },
        { id: "b", name: "B", report_id: null, selected: true, released_at: "2026-09-30T07:00:01.000001+00:00" },
      ],
      refused: [],
    });
    await out;
    const at = (id: string) => (fx.audits.find((a) => a.resource_id === id)!.metadata as { released_at: string }).released_at;
    expect(at("a")).toBe(stamp);
    expect(at("b")).toBe("2026-09-30T07:00:01.000001+00:00");
  });

  it("stamps bulk_batch_id on every released row's audit (report-mates too) and passes it to the notice", async () => {
    const { out } = run([{ id: "a" }, { id: "b" }, { id: "c" }], report("r1", "a", "b"), ["a", "c"], undefined, "batch-1");
    await out;
    expect(fx.audits.map((a) => a.resource_id)).toEqual(["a", "b", "c"]);
    for (const a of fx.audits) expect(a.metadata).toMatchObject({ bulk_batch_id: "batch-1", source: "queue" });
    expect(fx.notified).toEqual([expect.objectContaining({ bulkBatchId: "batch-1" })]);
  });

  it("without a bulkBatchId the audit rows carry no bulk_batch_id", async () => {
    const { out } = run([{ id: "a" }], [], ["a"]);
    await out;
    expect(fx.audits[0].metadata).not.toHaveProperty("bulk_batch_id");
  });

  it.each([
    ["not_ready", RACED_REASON, 0],
    ["outside_sections", OUTSIDE_SECTIONS_REASON, 0],
    ["report_outside_sections", REPORT_REFUSAL.outside_sections, 0],
    ["report_package_header", REPORT_REFUSAL.package_header, 0],
    ["report_other_visit", REPORT_REFUSAL.other_visit, 0],
    ["report_doctor_member", REPORT_REFUSAL.doctorMember, 0],
    ["report_deleted_member", REPORT_REFUSAL.deletedMember, 0],
    ["report_not_finished", REPORT_REFUSAL.notFinished(2), 2],
    ["something_new", RACED_REASON, 0],
  ])("maps refusal code %s to its wording; nothing is released, notified or audited", async (code, reason, count) => {
    const { fake, out } = run([{ id: "a" }], [], ["a"]);
    fake.overrideNextRpc("release_visit_results", { released: [], refused: [refusal("a", code, count)] });
    const o = await out;
    expect(o).toEqual({ changedIds: [], alsoReleasedIds: [], skipped: [{ id: "a", reason }], warnings: [], announced: [] });
    expect(fx.notified).toHaveLength(0);
    expect(fx.alerts).toHaveLength(0);
    expect(fx.audits).toHaveLength(0);
  });

  it("report_not_finished pluralises through REPORT_REFUSAL (1 test vs 2 tests)", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b"]);
    fake.overrideNextRpc("release_visit_results", {
      released: [],
      refused: [refusal("a", "report_not_finished", 1), refusal("b", "report_not_finished", 3)],
    });
    const o = await out;
    expect(o.skipped).toEqual([
      { id: "a", reason: REPORT_REFUSAL.notFinished(1) },
      { id: "b", reason: REPORT_REFUSAL.notFinished(3) },
    ]);
  });

  it("a selected id the result lists nowhere is skipped as raced (never silently dropped)", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b"]);
    fake.overrideNextRpc("release_visit_results", {
      released: [{ id: "a", name: "A", report_id: null, selected: true, released_at: FAKE_RELEASED_AT }],
      refused: [],
    });
    const o = await out;
    expect(o.changedIds).toEqual(["a"]);
    expect(o.skipped).toEqual([{ id: "b", reason: RACED_REASON }]);
  });

  it("a refused report and a plain row in one call: only the plain row is announced", async () => {
    const { fake, out } = run(
      [{ id: "a" }, { id: "b", status: "result_uploaded" }, { id: "c" }],
      report("r1", "a", "b"),
      ["a", "c"],
    );
    const o = await out;
    expect(o.changedIds).toEqual(["c"]);
    expect(o.skipped).toEqual([{ id: "a", reason: REPORT_REFUSAL.notFinished(1) }]);
    expect(fx.alerts).toEqual([["v1", 1]]);
    expect(fx.audits.map((a) => a.resource_id)).toEqual(["c"]);
    expect(fake.rows.find((r) => r.id === "a")!.status).toBe("ready_for_release");
  });

  it("P0058 skips every selected id with the inactive-patient message", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b"]);
    fake.failNextRpc("release_visit_results", { code: "P0058", message: "raw" });
    const o = await out;
    expect(o.skipped).toEqual([
      { id: "a", reason: RELEASE_REFUSAL_PATIENT_INACTIVE },
      { id: "b", reason: RELEASE_REFUSAL_PATIENT_INACTIVE },
    ]);
    expect(o.changedIds).toEqual([]);
    expect(fx.alerts).toHaveLength(0);
  });

  it("P0081 passes its message through to every selected id", async () => {
    const { fake, out } = run([{ id: "a" }], [], ["a"]);
    fake.failNextRpc("release_visit_results", { code: "P0081", message: "Choose how the result was released." });
    expect((await out).skipped).toEqual([{ id: "a", reason: "Choose how the result was released." }]);
  });

  it("a payment/consent gate refusal (23514) is translated; nothing is announced", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], report("r1", "a", "b"), ["a"]);
    fake.failNextRpc("release_visit_results", { code: "23514", message: "consent required" });
    const o = await out;
    expect(o).toEqual({
      changedIds: [],
      alsoReleasedIds: [],
      skipped: [{ id: "a", reason: RELEASE_BLOCKED_CONSENT }],
      warnings: [],
      announced: [],
    });
    expect(fx.notified).toHaveLength(0);
    expect(fx.alerts).toHaveLength(0);
    expect(fx.audits).toHaveLength(0);
  });

  it("40001 is retried once: the second call's result is used", async () => {
    const { fake, out } = run([{ id: "a" }], [], ["a"]);
    fake.failNextRpc("release_visit_results", { code: "40001", message: "changed" });
    const o = await out;
    expect(fake.rpcCalls).toHaveLength(2);
    expect(o.changedIds).toEqual(["a"]);
    expect(o.skipped).toEqual([]);
  });

  it("40001 twice is shown to the user, not retried a third time", async () => {
    const { fake, out } = run([{ id: "a" }], [], ["a"]);
    fake.failNextRpc("release_visit_results", { code: "40001", message: "first" });
    fake.failNextRpc("release_visit_results", { code: "40001", message: "second" });
    const o = await out;
    expect(fake.rpcCalls).toHaveLength(2);
    expect(o.changedIds).toEqual([]);
    expect(o.skipped).toHaveLength(1);
  });

  it.each([
    ["not an object", "nope"],
    ["released row without released_at", { released: [{ id: "a", name: "A", report_id: null, selected: true }], refused: [] }],
    ["released row with a non-string released_at", { released: [{ id: "a", name: "A", report_id: null, selected: true, released_at: 1759215600000 }], refused: [] }],
    ["missing refused", { released: [] }],
    ["released row without a name", { released: [{ id: "a", report_id: null, selected: true }], refused: [] }],
    ["refused row with a non-numeric count", { released: [], refused: [{ id: "a", code: "not_ready", report_id: null, count: "x" }] }],
  ])("malformed data (%s): reported, every id skipped with the confirm message, nothing announced", async (_n, data) => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b"]);
    fake.overrideNextRpc("release_visit_results", data);
    const o = await out;
    expect(o).toEqual({
      changedIds: [],
      alsoReleasedIds: [],
      skipped: [
        { id: "a", reason: COULDNT_CONFIRM_RELEASE },
        { id: "b", reason: COULDNT_CONFIRM_RELEASE },
      ],
      warnings: [],
      announced: [],
    });
    expect(fx.reported).toHaveLength(1);
    expect(fx.notified).toHaveLength(0);
    expect(fx.alerts).toHaveLength(0);
    expect(fx.audits).toHaveLength(0);
  });
});

describe("notifyReleased", () => {
  it("passes bulkBatchId to the single and the bulk notice", async () => {
    await notifyReleased("v1", [{ id: "a", name: "A" }], "email", "b1");
    await notifyReleased("v1", [{ id: "a", name: "A" }, { id: "b", name: "B" }], "email", "b2");
    expect(fx.notified).toEqual([
      expect.objectContaining({ testRequestId: "a", bulkBatchId: "b1" }),
      expect.objectContaining({ testRequestIds: ["a", "b"], bulkBatchId: "b2" }),
    ]);
  });

  it("never throws: a failing notice is reported instead", async () => {
    fx.notifyThrows = true;
    await expect(notifyReleased("v1", [{ id: "a", name: "A" }], "email")).resolves.toBeUndefined();
    expect(fx.reported.map((r) => r.scope)).toEqual(["notify/result-released-selection"]);
  });

  it("sends nothing for an empty list", async () => {
    await notifyReleased("v1", [], "email");
    expect(fx.notified).toHaveLength(0);
  });
});
