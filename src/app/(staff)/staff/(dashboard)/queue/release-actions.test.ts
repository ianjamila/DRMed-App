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
  notifyOneResult: undefined as unknown,
  notifyBulkResult: undefined as unknown,
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
  notifyResultReleased: async (a: unknown) => {
    fx.notifyOne.push(a);
    return fx.notifyOneResult;
  },
}));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({
  notifyResultsReleasedBulk: async (a: { testRequestIds: string[] }) => {
    fx.notifyBulk.push(a);
    return fx.notifyBulkResult;
  },
}));
vi.mock("@/lib/notifications/release-staff-alert", () => ({
  scheduleReleaseStaffAlert: (v: string, n: number) => void fx.alerts.push([v, n]),
}));
vi.mock("@/lib/observability/report-error", () => ({ reportError: async () => {} }));

import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";
import { RELEASE_REFUSAL } from "@/lib/queue/release-eligibility";
import { REPORT_REFUSAL } from "@/lib/queue/report-release-scope";
import { COULDNT_CONFIRM_RELEASE, RACED_REASON } from "@/lib/actions/visits/release-reports";
import { RELEASE_REFUSAL_PATIENT_INACTIVE } from "@/lib/visits/release-messages";
import { FAKE_RELEASED_AT, makeFakeReleaseDb, type FakeLink, type FakeTestRow } from "@/lib/actions/visits/fake-release-db";

const { releaseTestsAction } = await import("./actions");

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C, D, E] = [u(1), u(2), u(3), u(4), u(5)];
const UUID_RE = /^[0-9a-f-]{36}$/;
const BAD_INPUT = "Could not read the selection — refresh the queue and try again.";

function setup(rows: FakeTestRow[], links: FakeLink[] = [], staff?: Record<string, string>) {
  const fake = makeFakeReleaseDb({ rows, links, staff });
  fx.db = fake.client;
  return fake;
}
const statusOf = (fake: ReturnType<typeof setup>, id: string) => fake.rows.find((r) => r.id === id)!.status;
/** The release_visit_results calls made — the one write path. */
const writes = (fake: ReturnType<typeof setup>) => fake.rpcCalls.filter((c) => c.name === "release_visit_results");
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
  fx.notifyOneResult = undefined;
  fx.notifyBulkResult = undefined;
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
    expect(writes(fake)).toHaveLength(2);
    expect(writes(fake).map((c) => c.args.p_visit_id).sort()).toEqual(["v1", "v2"]);
    expect(writes(fake).every((c) => c.args.p_actor === "u1" && c.args.p_medium === "email")).toBe(true);
    // Each visit's write hands the database the queue's extras + the call's Undo batch id + the request's ip / user agent (0205).
    if (!res.ok) throw new Error(res.error);
    expect(writes(fake).map((c) => c.args.p_audit)).toEqual([
      { metadata: { source: "queue", bulk_batch_id: res.batchId }, ip: "1.2.3.4", user_agent: "ua" },
      { metadata: { source: "queue", bulk_batch_id: res.batchId }, ip: "1.2.3.4", user_agent: "ua" },
    ]);
    expect(fx.audits.filter((a) => a.action === "test_request.released")).toEqual([]);
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
    // Revalidation is unconditional (contract point 9), even when no visit survived.
    expect(fx.revalidate).toHaveLength(2);
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
    fake.failNextRpc("release_visit_results", { code: "23514", message: "consent required" });
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

  it("refuses a mixed report (sibling awaiting sign-off): nothing is released", async () => {
    const fake = setup([{ id: A }, { id: B, status: "result_uploaded" }], report("r1", A, B));
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: REPORT_REFUSAL.notFinished(1) }] });
    expect(statusOf(fake, A)).toBe("ready_for_release");
    expect(fx.notifyOne.length + fx.notifyBulk.length).toBe(0);
    expect(fx.alerts).toHaveLength(0);
  });

  it("refuses a report with a deleted unreleased sibling", async () => {
    const fake = setup([{ id: A }, { id: B, deleted: true }], report("r1", A, B));
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: REPORT_REFUSAL.deletedMember }] });
    expect(statusOf(fake, A)).toBe("ready_for_release");
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

  it("a sibling going stale before the write: the database refuses the whole report, nothing goes out", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    fake.hooks.beforeRpc = () => {
      fake.rows.find((r) => r.id === B)!.status = "result_uploaded";
    };
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: REPORT_REFUSAL.notFinished(1) }] });
    expect(statusOf(fake, A)).toBe("ready_for_release");
    expect(fx.notifyOne.length + fx.notifyBulk.length).toBe(0);
    expect(fx.alerts).toHaveLength(0);
    expectPartition([A], res);
  });

  it("a whole-call refusal from the database (P0081) skips the visit's ids with its message", async () => {
    const fake = setup([{ id: A }]);
    fake.failNextRpc("release_visit_results", { code: "P0081", message: "Too many tests once whole reports are included — select fewer." });
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({
      ok: true,
      changedIds: [],
      skipped: [{ id: A, reason: "Too many tests once whole reports are included — select fewer." }],
    });
    expect(fx.alerts).toHaveLength(0);
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
  it("a database error skips the visit and announces nothing; another visit still goes through", async () => {
    const fake = setup([{ id: A, visitId: "v1" }, { id: B, visitId: "v2" }]);
    fake.failNextRpc("release_visit_results", { code: "XX000", message: "boom" });
    const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [B], skipped: [{ id: A, reason: "boom" }] });
    expect(statusOf(fake, A)).toBe("ready_for_release");
    expect(fx.alerts).toEqual([["v2", 1]]);
  });

  it("P0058 (patient deleted or merged mid-release) reads as the inactive-patient message", async () => {
    const fake = setup([{ id: A }]);
    fake.failNextRpc("release_visit_results", { code: "P0058", message: "patient gone" });
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: RELEASE_REFUSAL_PATIENT_INACTIVE }] });
  });

  it("a serialization failure (40001) is retried once and then succeeds", async () => {
    const fake = setup([{ id: A }]);
    fake.failNextRpc("release_visit_results", { code: "40001", message: "changed" });
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [A], skipped: [] });
    expect(writes(fake)).toHaveLength(2);
  });

  it("a malformed result is never announced: every id skipped with the confirm message", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    fake.overrideNextRpc("release_visit_results", { released: [{ id: A }], refused: [] });
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: COULDNT_CONFIRM_RELEASE }] });
    expect(fx.notifyOne.length + fx.notifyBulk.length).toBe(0);
    expect(fx.alerts).toHaveLength(0);
    expect(fx.audits).toHaveLength(0);
  });

  it("a released row without released_at is malformed: nothing announced or audited, every id skipped", async () => {
    const fake = setup([{ id: A }], []);
    fake.overrideNextRpc("release_visit_results", {
      released: [{ id: A, name: "A", report_id: null, selected: true }],
      refused: [],
    });
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: COULDNT_CONFIRM_RELEASE }] });
    expect(fx.notifyOne.length + fx.notifyBulk.length).toBe(0);
    expect(fx.alerts).toHaveLength(0);
    expect(fx.audits).toHaveLength(0);
  });

  it("one call mints ONE batch id: every visit's p_audit carries it, and it is returned", async () => {
    const fake = setup([
      { id: A, visitId: "v1" },
      { id: B, visitId: "v2" },
    ]);
    const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
    if (!res.ok) throw new Error(res.error);
    expect(res.batchId).toMatch(UUID_RE);
    const metas = writes(fake).map((w) => (w.args.p_audit as { metadata: Record<string, unknown> }).metadata);
    expect(metas).toHaveLength(2);
    expect(metas.every((m) => m.source === "queue" && m.bulk_batch_id === res.batchId)).toBe(true);
    // The database's own audit rows (0205) carry it on every released line, with the exact released_at.
    const released = fake.dbAudits.filter((a) => a.action === "test_request.released");
    expect(released.map((a) => a.metadata.bulk_batch_id)).toEqual([res.batchId, res.batchId]);
    expect(released.every((a) => a.metadata.released_at === FAKE_RELEASED_AT)).toBe(true);
    expect(fx.audits.filter((a) => a.action === "test_request.released")).toEqual([]);
  });

  it("a report-mate pulled in carries the batch id too", async () => {
    const fake = setup([{ id: A }, { id: B }], report("r1", A, B));
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    if (!res.ok) throw new Error(res.error);
    expect(res.alsoReleasedIds).toEqual([B]);
    const ids = fake.dbAudits.filter((a) => a.metadata.bulk_batch_id === res.batchId).map((a) => a.resource_id).sort();
    expect(ids).toEqual([A, B].sort());
    expect((fx.notifyBulk[0] as { bulkBatchId?: string }).bulkBatchId).toBe(res.batchId);
  });

  it("returns no batch id when nothing was released", async () => {
    setup([{ id: A, status: "requested" }]);
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    if (!res.ok) throw new Error(res.error);
    expect(res.changedIds).toEqual([]);
    expect(res.batchId).toBeUndefined();
    expect(res.notifiedCount).toBe(0);
  });

  it("notifiedCount counts only the visits whose notice was SENT", async () => {
    setup([{ id: A, visitId: "v1" }, { id: B, visitId: "v1" }, { id: C, visitId: "v2" }]);
    // v1's bulk notice went out; v2's single notice was skipped (no contact).
    fx.notifyBulkResult = { status: "sent", channels: ["email"], reason: null };
    fx.notifyOneResult = { status: "skipped", channels: [], reason: "no email or phone on file" };
    const res = await releaseTestsAction({ testRequestIds: [A, B, C], medium: "email" });
    if (!res.ok) throw new Error(res.error);
    expect(res.notifiedCount).toBe(2);
    expect(res.noticeRetrying).toBeUndefined();
  });

  it("noticeRetrying is set when any visit's notice is retrying, and never counted as notified", async () => {
    setup([{ id: A }]);
    fx.notifyOneResult = { status: "retrying", channels: [], reason: "will retry automatically" };
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    if (!res.ok) throw new Error(res.error);
    expect(res.notifiedCount).toBe(0);
    expect(res.noticeRetrying).toBe(true);
  });

  it("plain rows are still announced when no report is involved", async () => {
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

  it("a selected test released by someone else just before the write is skipped, naming who and when", async () => {
    const fake = setup([{ id: A }, { id: B }], [], { maria: "Maria Santos" });
    fake.hooks.beforeRpc = () => {
      const row = fake.rows.find((r) => r.id === B)!;
      row.status = "released";
      row.releasedBy = "maria";
      row.releasedAt = "2026-09-30T06:14:00+00:00";
    };
    const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [A], skipped: [{ id: B, reason: expect.stringMatching(/^Already released by Maria S\. on .+ at 2:14 PM\.$/) }] });
    expect(fx.notifyOne).toHaveLength(1);
  });

  it("raced on a row that is no longer released keeps RACED_REASON", async () => {
    const fake = setup([{ id: A }, { id: B }]);
    fake.hooks.beforeRpc = () => {
      fake.rows.find((r) => r.id === B)!.status = "in_progress";
    };
    const res = await releaseTestsAction({ testRequestIds: [A, B], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [A], skipped: [{ id: B, reason: RACED_REASON }] });
  });

  it("a stale click on a line already released (caught by the pre-read) names who and when", async () => {
    setup([{ id: A, status: "released", releasedBy: "u1", releasedAt: "2026-09-30T06:14:00+00:00" }]);
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, changedIds: [], skipped: [{ id: A, reason: expect.stringMatching(/^You already released this on .+ at 2:14 PM\.$/) }] });
  });

  it("a stale click on a released line whose lookup fails keeps the not-ready wording", async () => {
    const fake = setup([{ id: A, status: "released", releasedBy: "maria", releasedAt: "2026-09-30T06:14:00+00:00" }]);
    let reads = 0;
    fake.hooks.beforeRead = () => { if (++reads === 2) fake.failNext("test_requests", "read"); };
    const res = await releaseTestsAction({ testRequestIds: [A], medium: "email" });
    expect(res).toMatchObject({ ok: true, skipped: [{ id: A, reason: RELEASE_REFUSAL.notReady }] });
  });
});
