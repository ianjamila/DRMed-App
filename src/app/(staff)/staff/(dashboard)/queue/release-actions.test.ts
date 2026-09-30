import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "1.2.3.4", "user-agent": "ua" }),
}));
const fx = vi.hoisted(() => ({
  role: "medtech" as string,
  db: null as unknown,
  gateRequired: false,
  consent: new Map<string, boolean>(),
  revalidate: [] as Array<[string, string | undefined]>,
  audits: [] as Array<Record<string, unknown>>,
  notifyOne: [] as unknown[],
  notifyBulk: [] as Array<{ testRequestIds: string[] }>,
  alerts: [] as Array<[string, number]>,
}));
vi.mock("next/cache", () => ({
  revalidatePath: (p: string, t?: string) => void fx.revalidate.push([p, t]),
}));
vi.mock("@/lib/auth/require-staff", () => ({
  requireActiveStaff: async () => ({ user_id: "u1", role: fx.role }),
}));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdminStaff: async () => ({ user_id: "u1", role: "admin" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => fx.db }));
vi.mock("@/lib/consent/gate", () => ({
  isConsentGateRequired: async () => fx.gateRequired,
  getConsentCurrentByPatient: async () => fx.consent,
}));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/notifications/notify-released", () => ({
  notifyResultReleased: async (a: unknown) => void fx.notifyOne.push(a),
}));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({
  notifyResultsReleasedBulk: async (a: { testRequestIds: string[] }) => void fx.notifyBulk.push(a),
}));
vi.mock("@/lib/notifications/release-staff-alert", () => ({
  scheduleReleaseStaffAlert: (v: string, n: number) => void fx.alerts.push([v, n]),
}));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));

import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";
import { RELEASE_REFUSAL } from "@/lib/queue/release-eligibility";
import { REPORT_REFUSAL } from "@/lib/queue/report-release-scope";
import {
  COULDNT_CHECK_REPORT,
  REPORT_CHANGED_REASON,
  TOO_MANY_AFTER_EXPANSION,
  UNVERIFIED_WARNING,
} from "@/lib/actions/visits/release-reports";
import { makeFakeReleaseDb, type FakeLink, type FakeTestRow } from "@/lib/actions/visits/fake-release-db";

const { releaseTestsAction } = await import("./actions");

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C, D, E] = [u(1), u(2), u(3), u(4), u(5)];
const BAD_INPUT = "Could not read the selection — refresh the queue and try again.";

function setup(rows: FakeTestRow[], links: FakeLink[] = []) {
  const fake = makeFakeReleaseDb({ rows, links });
  fx.db = fake.client;
  return fake;
}
const statusOf = (fake: ReturnType<typeof setup>, id: string) => fake.rows.find((r) => r.id === id)!.status;
const updates = (fake: ReturnType<typeof setup>) => fake.calls.filter((c) => c.table === "test_requests" && c.op === "update");
const report = (result: string, ...ids: string[]): FakeLink[] => ids.map((id) => ({ testRequestId: id, resultId: result }));

beforeEach(() => {
  fx.role = "medtech";
  fx.gateRequired = false;
  fx.consent = new Map();
  fx.revalidate.length = 0;
  fx.audits.length = 0;
  fx.notifyOne.length = 0;
  fx.notifyBulk.length = 0;
  fx.alerts.length = 0;
});

/** Every id sent lands in exactly one of changedIds / skipped. */
function expectPartition(ids: string[], res: Awaited<ReturnType<typeof releaseTestsAction>>) {
  if (!res.ok) throw new Error(res.error);
  const changed = res.changedIds;
  const skipped = res.skipped.map((s) => s.id);
  expect([...changed, ...skipped].sort()).toEqual([...ids].sort());
  expect(new Set([...changed, ...skipped]).size).toBe(ids.length);
}

describe("releaseTestsAction — gates and input", () => {
  it("refuses a forged reception call before any read", async () => {
    const fake = setup([{ id: A }]);
    fx.role = "reception";
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toEqual({ ok: false, error: RELEASE_REFUSAL.reception });
    expect(fake.calls).toHaveLength(0);
    expect(fx.revalidate).toHaveLength(0);
  });

  it.each([
    ["no ids", { testRequestIds: [], medium: "email" }],
    ["a non-uuid", { testRequestIds: ["nope"], medium: "email" }],
    ["a bad medium", { testRequestIds: [A], medium: "carrier-pigeon" }],
    ["501 ids", { testRequestIds: Array.from({ length: 501 }, (_, i) => u(i + 1)), medium: "email" }],
    ["not an object", "x"],
  ])("rejects %s with the input error and no reads", async (_n, input) => {
    const fake = setup([{ id: A }]);
    expect(await releaseTestsAction(input)).toEqual({ ok: false, error: BAD_INPUT });
    expect(fake.calls).toHaveLength(0);
  });

  it("pins the selected-rows read: own deleted_at and the id list", async () => {
    const fake = setup([{ id: A }]);
    await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    const read = fake.calls.find((c) => c.table === "test_requests" && c.op === "select")!;
    expect(read.filters).toContainEqual({ op: "is", column: "deleted_at", value: null });
    expect(read.filters).toContainEqual({ op: "in", column: "id", value: [A] });
    expect(read.select).toMatch(/visits[^)]*deleted_at/);
  });
});

describe("releaseTestsAction — eligibility and the per-visit write", () => {
  it("two paid visits: one write per visit, both released, one alert per visit", async () => {
    const fake = setup([{ id: A, visitId: "v1" }, { id: B, visitId: "v2" }]);
    const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [A, B], skipped: [], alsoReleasedIds: [], warnings: [] });
    expect(updates(fake)).toHaveLength(2);
    expect(updates(fake).map((c) => c.filters.find((f) => f.column === "visit_id")!.value).sort()).toEqual(["v1", "v2"]);
    expect(fx.audits.map((a) => (a.metadata as { source: string }).source)).toEqual(["queue", "queue"]);
    expect(fx.alerts.sort()).toEqual([["v1", 1], ["v2", 1]]);
    expect(fx.revalidate).toEqual([
      ["/(staff)/staff/(dashboard)/queue", "layout"],
      ["/staff", undefined],
      ["/staff/visits/v1", undefined],
      ["/staff/visits/v2", undefined],
    ]);
  });

  it("skips an unpaid row with the unpaid message; waived and HMO rows release", async () => {
    setup([
      { id: A, paymentStatus: "unpaid" },
      { id: B, paymentStatus: "waived" },
      { id: C, paymentStatus: "unpaid", hmoProviderId: "hmo1" },
    ]);
    const res = await releaseTestsAction({ testRequestIds: [A, B, C], medium: "physical" });
    expect(res).toMatchObject({ ok: true, changedIds: [B, C], skipped: [{ id: A, reason: RELEASE_BLOCKED_UNPAID }] });
  });

  it("skips a deleted visit and an inactive patient with their own reasons", async () => {
    setup([{ id: A, visitDeleted: true }, { id: B, patientActive: false }, { id: C }]);
    const res = await releaseTestsAction({ testRequestIds: [A, B, C], medium: "email" });
    expect(res).toMatchObject({
      ok: true,
      changedIds: [C],
      skipped: [
        { id: A, reason: RELEASE_REFUSAL.visitDeleted },
        { id: B, reason: RELEASE_REFUSAL.patientInactive },
      ],
    });
  });

  it("reads a queue-deleted or missing line as gone", async () => {
    setup([{ id: A, deleted: true }]);
    const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
    expect(res).toMatchObject({
      ok: true,
      changedIds: [],
      skipped: [
        { id: A, reason: "Deleted from the queue or no longer exists." },
        { id: B, reason: "Deleted from the queue or no longer exists." },
      ],
    });
    expect(fx.revalidate).toHaveLength(0);
  });

  it("with the consent gate on, skips a patient without consent and releases one with it", async () => {
    const fake = setup([{ id: A, patientId: "p1" }, { id: B, patientId: "p2" }]);
    fx.gateRequired = true;
    fx.consent = new Map([["p2", true]]);
    const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [B], skipped: [{ id: A, reason: RELEASE_REFUSAL.consent }] });
    expect(statusOf(fake, A)).toBe("ready_for_release");
  });

  it("a DB consent refusal on the write skips that visit's ids with the consent text", async () => {
    const fake = setup([{ id: A, visitId: "v1" }, { id: B, visitId: "v2" }]);
    fake.failNext("test_requests", "update-error", { code: "23514", message: "consent required" });
    const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
    // The first visit's write failed, the second went through.
    expect(res).toMatchObject({ ok: true, changedIds: [B], skipped: [{ id: A, reason: RELEASE_BLOCKED_CONSENT }] });
    expect(fx.alerts).toEqual([["v2", 1]]);
  });
});

describe("releaseTestsAction — combined reports", () => {
  it("pulls in an unselected ready sibling and notifies both", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [A], alsoReleasedIds: [B], skipped: [], warnings: [] });
    expect(statusOf(fake, B)).toBe("released");
    expect(fx.notifyBulk).toHaveLength(1);
    expect(fx.notifyBulk[0].testRequestIds.sort()).toEqual([A, B]);
    expect(fx.alerts).toEqual([["v1", 2]]);
  });

  it("refuses a mixed report (sibling awaiting sign-off) and never writes", async () => {
    const fake = setup([{ id: A }, { id: B, status: "result_uploaded" }], report("r1", A, B));
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: REPORT_REFUSAL.notFinished(1) }] });
    expect(updates(fake)).toHaveLength(0);
    expect(fx.notifyOne.length + fx.notifyBulk.length).toBe(0);
    expect(fx.alerts).toHaveLength(0);
  });

  it("refuses a report with a deleted unreleased sibling", async () => {
    const fake = setup([{ id: A }, { id: B, deleted: true }], report("r1", A, B));
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: REPORT_REFUSAL.deletedMember }] });
    expect(updates(fake)).toHaveLength(0);
  });

  it("releases a report whose only other member is already released", async () => {
    setup([{ id: A }, { id: B, status: "released" }], report("r1", A, B));
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [A], alsoReleasedIds: [], warnings: [] });
    expect(fx.notifyOne).toHaveLength(1);
  });

  it("one refused report does not block a plain row or a good report", async () => {
    const fake = setup(
      [{ id: A }, { id: B, status: "result_uploaded" }, { id: C }, { id: D }, { id: E }],
      [...report("r1", A, B), ...report("r2", C, D)],
    );
    const res = await releaseTestsAction({ testRequestIds: [A, C, E], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [C, E], alsoReleasedIds: [D], skipped: [{ id: A }] });
    expect(statusOf(fake, A)).toBe("ready_for_release");
    expectPartition([A, C, E], res);
  });

  it("race: the write releases only part of the report -> no notice, no alert, and a note", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    fake.failNext("test_requests", "update-partial");
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [A], warnings: [REPORT_CHANGED_REASON] });
    expect(fx.notifyOne.length + fx.notifyBulk.length).toBe(0);
    expect(fx.alerts).toHaveLength(0);
  });

  it("race where the selected row is the one left behind: it is skipped with the note", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    fake.failNext("test_requests", "update-partial");
    const res = await releaseTestsAction({ testRequestIds: [B], medium: "email" });
    // rows are read in seed order, so the partial write releases A (pulled in), not B.
    expect(res).toMatchObject({
      ok: true,
      changedIds: [],
      alsoReleasedIds: [A],
      skipped: [{ id: B, reason: REPORT_CHANGED_REASON }],
    });
    expect(fx.notifyOne.length + fx.notifyBulk.length).toBe(0);
    expectPartition([B], res);
  });

  it("refuses when whole-report expansion exceeds 500 tests", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `m${i}` }));
    const fake = setup([{ id: A }, ...many], report("r1", A, ...many.map((m) => m.id)));
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: TOO_MANY_AFTER_EXPANSION }] });
    expect(updates(fake)).toHaveLength(0);
  });

  it("partitions every id exactly once across a mixed selection", async () => {
    setup(
      [{ id: A }, { id: B, paymentStatus: "unpaid" }, { id: C, deleted: true }, { id: D }, { id: E, status: "requested" }],
      [],
    );
    const ids = [A, B, C, D, E, u(9)];
    const res = await releaseTestsAction({ testRequestIds: ids, medium: "email" });
    expectPartition(ids, res);
  });
});

describe("releaseTestsAction — fail closed", () => {
  it("links read error: the visit is skipped and nothing is written", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    fake.failNext("result_test_requests", "read");
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: COULDNT_CHECK_REPORT }] });
    expect(updates(fake)).toHaveLength(0);
    expect(fx.alerts).toHaveLength(0);
  });

  it("membership read error: the visit is skipped and nothing is written", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    fake.failNext("result_test_requests", "membership");
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: COULDNT_CHECK_REPORT }] });
    expect(updates(fake)).toHaveLength(0);
  });

  it("membership read that returns fewer members than the links skips that report only", async () => {
    const fake = setup([{ id: A }, { id: B }, { id: C }], [...report("r1", A, B), ...report("r2", C)]);
    fake.failNext("result_test_requests", "truncate");
    const res = await releaseTestsAction({ testRequestIds: [A, B, C], medium: "email" });
    // truncate drops the last member of every report, so r1 loses B and r2 loses C: both skipped.
    expect(res).toMatchObject({
      ok: true,
      changedIds: [],
      skipped: [{ id: A }, { id: B }, { id: C }],
    });
    expect(updates(fake)).toHaveLength(0);
  });

  it("a failed membership read on one visit does not stop another visit", async () => {
    const fake = setup([{ id: A, visitId: "v1" }, { id: B, visitId: "v2" }], [...report("r1", A), ...report("r2", B)]);
    fake.failNext("result_test_requests", "membership");
    const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [B], skipped: [{ id: A, reason: COULDNT_CHECK_REPORT }] });
  });

  it("post-write read error: the release stands, no notice, verification warning", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    fake.failNext("result_test_requests", "reread");
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [A], alsoReleasedIds: [B], warnings: [UNVERIFIED_WARNING] });
    expect(statusOf(fake, A)).toBe("released");
    expect(fx.notifyOne.length + fx.notifyBulk.length).toBe(0);
    expect(fx.alerts).toHaveLength(0);
  });

  it("post-write read missing a member: same as an error", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    let membershipReads = 0;
    fake.hooks.beforeRead = (_t, membership) => {
      if (membership && ++membershipReads === 2) fake.links.splice(fake.links.findIndex((l) => l.testRequestId === B), 1);
    };
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [A], warnings: [UNVERIFIED_WARNING] });
    expect(fx.notifyOne.length + fx.notifyBulk.length).toBe(0);
  });

  it("plain rows are still announced when the report check is not needed", async () => {
    setup([{ id: A }, { id: B }], []);
    const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [A, B], warnings: [] });
    expect(fx.notifyBulk[0].testRequestIds).toEqual([A, B]);
  });
});

describe("releaseTestsAction — concurrency", () => {
  it("two same-user calls over overlapping ids: each id is changed by exactly one call", async () => {
    const fake = setup([{ id: A }, { id: B }, { id: C }]);
    const [r1, r2] = await Promise.all([
      releaseTestsAction({ testRequestIds: [A, B], medium: "email" }),
      releaseTestsAction({ testRequestIds: [B, C], medium: "email" }),
    ]);
    if (!r1.ok || !r2.ok) throw new Error("expected ok");
    const all = [...r1.changedIds, ...r2.changedIds].sort();
    expect(all).toEqual([A, B, C]);
    expect([r1, r2].flatMap((r) => (r.ok ? r.skipped : [])).map((s) => s.id)).toEqual([B]);
    expect(fake.rows.every((r) => r.status === "released")).toBe(true);
  });

  it("a member flipping to result_uploaded before the membership read refuses the report", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    fake.hooks.beforeRead = (_t, membership) => {
      if (membership) fake.rows.find((r) => r.id === B)!.status = "result_uploaded";
    };
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: REPORT_REFUSAL.notFinished(1) }] });
    expect(updates(fake)).toHaveLength(0);
  });
});
