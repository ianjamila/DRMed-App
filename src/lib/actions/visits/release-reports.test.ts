import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "ua" }),
}));
const fx = vi.hoisted(() => ({
  notified: [] as Array<{ testRequestIds?: string[]; testRequestId?: string }>,
  alerts: [] as Array<[string, number]>,
}));
vi.mock("@/lib/audit/log", () => ({ audit: async () => {} }));
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

import { RELEASE_BLOCKED_CONSENT } from "@/lib/visits/release-messages";
import { makeFakeReleaseDb, type FakeLink, type FakeTestRow } from "./fake-release-db";
import { REPORT_CHANGED_REASON, releaseVisitSelection } from "./release-reports";

const session = { user_id: "u1", role: "medtech" } as never;
function run(rows: FakeTestRow[], links: FakeLink[], selectedIds: string[]) {
  const fake = makeFakeReleaseDb({ rows, links });
  const out = releaseVisitSelection({
    supabase: fake.client,
    session,
    visitId: "v1",
    selectedIds,
    medium: "email",
    auditMeta: { source: "queue" },
  });
  return { fake, out };
}
const report = (result: string, ...ids: string[]): FakeLink[] => ids.map((id) => ({ testRequestId: id, resultId: result }));

beforeEach(() => {
  fx.notified.length = 0;
  fx.alerts.length = 0;
});

describe("releaseVisitSelection", () => {
  it("announces plain rows and complete reports together, one alert with the announced count", async () => {
    const { out } = run(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      report("r1", "a", "b"),
      ["a", "c"],
    );
    const o = await out;
    expect(o.changedIds).toEqual(["a", "c"]);
    expect(o.alsoReleasedIds).toEqual(["b"]);
    expect(o.announced.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    expect(fx.alerts).toEqual([["v1", 3]]);
  });

  it("announced excludes the rows of an incomplete (raced) report but keeps plain rows", async () => {
    const { fake, out } = run(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      report("r1", "a", "b"),
      ["a", "c"],
    );
    fake.failNext("test_requests", "update-partial"); // releases only the first matching row
    const o = await out;
    // Seed order: only a is written. It sits on r1, whose other member b was left behind, so nothing is announced.
    expect(o.changedIds).toEqual(["a"]);
    expect(o.announced).toEqual([]);
    expect(o.warnings).toEqual([REPORT_CHANGED_REASON]);
    expect(o.skipped).toEqual([{ id: "c", reason: "Released by someone else or changed just now." }]);
    expect(fx.notified).toHaveLength(0);
    expect(fx.alerts).toHaveLength(0);
  });

  it("a partial write on plain rows still announces exactly the rows that went out", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b"]);
    fake.failNext("test_requests", "update-partial");
    const o = await out;
    expect(o.changedIds).toEqual(["a"]);
    expect(o.announced.map((r) => r.id)).toEqual(["a"]);
    expect(fx.alerts).toEqual([["v1", 1]]);
    expect(o.skipped).toHaveLength(1);
  });

  it("a releaseRows error skips every selected id with the translated message; nothing announced", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], report("r1", "a", "b"), ["a"]);
    fake.failNext("test_requests", "update-error", { code: "23514", message: "consent required" });
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
  });

  it("makes the membership read include deleted members (no deleted_at pin on it)", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], report("r1", "a", "b"), ["a"]);
    await out;
    const membership = fake.calls.find((c) => c.table === "result_test_requests" && c.filters.some((f) => f.column === "result_id"))!;
    expect(membership.filters.map((f) => f.column)).toEqual(["result_id"]);
    expect(membership.select).toContain("deleted_at");
  });

  it("returns an empty outcome for an empty selection without reading", async () => {
    const { fake, out } = run([], [], []);
    expect(await out).toEqual({ changedIds: [], alsoReleasedIds: [], skipped: [], warnings: [], announced: [] });
    expect(fake.calls).toHaveLength(0);
  });
});
