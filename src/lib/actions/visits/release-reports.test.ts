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
  // What the mocked notifiers report back (the real ones return the outcome).
  notice: { status: "sent", channels: ["email"], reason: null } as { status: string; channels: string[]; reason: string | null },
}));
// 0210/0212 outbox fast path: the admin client only answers the flag and the claim,
// and the sender is a recording stub — the legacy notifiers above stay the default.
const outbox = vi.hoisted(() => ({
  enabled: true as unknown,
  enabledError: null as null | { message: string },
  claimData: [{ id: "n1", lease_token: "lease-1", status: "sending" }] as unknown[],
  claimError: null as null | { message: string },
  cancelData: true as unknown,
  cancelError: null as null | { message: string },
  rpcs: [] as Array<{ name: string; args: unknown }>,
  sent: [] as unknown[],
  sendResult: { outcome: { status: "sent", channels: ["email"], reason: null }, finalStatus: "sent" } as unknown,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: unknown) => {
      outbox.rpcs.push({ name, args });
      if (name === "release_notices_enabled") return { data: outbox.enabled, error: outbox.enabledError };
      if (name === "claim_release_notice") return { data: outbox.claimData, error: outbox.claimError };
      if (name === "cancel_release_notice") return { data: outbox.cancelData, error: outbox.cancelError };
      throw new Error("unexpected rpc " + name);
    },
  }),
}));
vi.mock("@/lib/notifications/release-notice-sender", () => ({
  sendReleaseNotice: async (row: unknown) => {
    outbox.sent.push(row);
    return outbox.sendResult;
  },
}));
vi.mock("@/lib/audit/log", () => ({ audit: async (e: Record<string, unknown>) => void fx.audits.push(e) }));
vi.mock("@/lib/notifications/notify-released", () => ({
  notifyResultReleased: async (a: { testRequestId: string }) => {
    if (fx.notifyThrows) throw new Error("boom");
    fx.notified.push(a);
    return fx.notice;
  },
}));
vi.mock("@/lib/notifications/notify-released-bulk", () => ({
  notifyResultsReleasedBulk: async (a: { testRequestIds: string[] }) => {
    fx.notified.push(a);
    return fx.notice;
  },
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
  fx.notice = { status: "sent", channels: ["email"], reason: null };
  outbox.enabled = true;
  outbox.enabledError = null;
  outbox.claimData = [{ id: "n1", lease_token: "lease-1", status: "sending" }];
  outbox.claimError = null;
  outbox.cancelData = true;
  outbox.cancelError = null;
  outbox.rpcs.length = 0;
  outbox.sent.length = 0;
  outbox.sendResult = { outcome: { status: "sent", channels: ["email"], reason: null }, finalStatus: "sent" };
});

describe("releaseVisitSelection", () => {
  it("calls release_visit_results once with the deduped selection, the medium and the acting staff id", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b", "a"]);
    await out;
    expect(fake.rpcCalls).toEqual([
      {
        name: "release_visit_results",
        args: {
          p_visit_id: "v1",
          p_test_request_ids: ["a", "b"],
          p_medium: "email",
          p_actor: "u1",
          p_audit: { metadata: { source: "queue" }, ip: "1.2.3.4", user_agent: "ua" },
        },
      },
    ]);
  });

  it("an empty selection makes no call and returns an empty outcome", async () => {
    const { fake, out } = run([{ id: "a" }], [], []);
    expect(await out).toEqual({ changedIds: [], alsoReleasedIds: [], skipped: [], warnings: [], announced: [], notice: null });
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
    expect(o.notice).toEqual({ status: "sent", channels: ["email"], reason: null });
    expect(fx.notified).toHaveLength(1);
    expect(fx.notified[0].testRequestIds?.slice().sort()).toEqual(["a", "b", "c"]);
    expect(fx.alerts).toEqual([["v1", 3]]);
  });

  it("carries a skipped or failed notice through to the outcome instead of claiming it was sent", async () => {
    fx.notice = { status: "skipped", channels: [], reason: "no email or phone on file" };
    const skipped = await run([{ id: "a" }], [], ["a"]).out;
    expect(skipped.announced).toHaveLength(1);
    expect(skipped.notice).toEqual({ status: "skipped", channels: [], reason: "no email or phone on file" });
    fx.notifyThrows = true;
    const failed = await run([{ id: "a" }], [], ["a"]).out;
    expect(failed.notice).toEqual({ status: "failed", channels: [], reason: "sending failed" });
  });

  it("a single released row gets the single-result notice", async () => {
    const { out } = run([{ id: "a" }], [], ["a"]);
    await out;
    expect(fx.notified).toEqual([{ testRequestId: "a", visitId: "v1", releaseMedium: "email" }]);
    expect(fx.alerts).toEqual([["v1", 1]]);
  });

  it("hands the audit to the database as p_audit (caller extras + first forwarded ip + user agent) and writes no released row itself", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }, { id: "c", status: "result_uploaded" }], report("r1", "a", "b"), ["a", "c"]);
    await out;
    // Exactly one call, the extras exactly as passed (no visit_id / released_at: the SQL adds those).
    expect(fake.rpcCalls).toHaveLength(1);
    expect(fake.rpcCalls[0].args.p_audit).toEqual({ metadata: { source: "queue" }, ip: "1.2.3.4", user_agent: "ua" });
    // The database owns test_request.released now: a TypeScript copy would double-write.
    expect(fx.audits.filter((a) => a.action === "test_request.released")).toEqual([]);
    // What the fake's model of the SQL writes (a, b released; c is not ready).
    expect(fake.dbAudits.map((a) => a.resource_id)).toEqual(["a", "b"]);
    for (const a of fake.dbAudits) {
      expect(a).toMatchObject({
        actor_id: "u1",
        action: "test_request.released",
        metadata: { visit_id: "v1", release_medium: "email", bulk: true, selection: true, source: "queue", released_at: FAKE_RELEASED_AT },
        ip_address: "1.2.3.4",
        user_agent: "ua",
      });
    }
  });

  it("the released_at the RPC returns is not echoed into p_audit (the database stamps and writes it itself)", async () => {
    const stamp = "2026-09-30T07:00:00.987654+00:00";
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b"]);
    fake.overrideNextRpc("release_visit_results", {
      released: [
        { id: "a", name: "A", report_id: null, selected: true, released_at: stamp },
        { id: "b", name: "B", report_id: null, selected: true, released_at: "2026-09-30T07:00:01.000001+00:00" },
      ],
      refused: [],
    });
    const o = await out;
    expect(o.changedIds).toEqual(["a", "b"]);
    expect(fake.rpcCalls[0].args.p_audit).toEqual({ metadata: { source: "queue" }, ip: "1.2.3.4", user_agent: "ua" });
    expect(fx.audits.filter((a) => a.action === "test_request.released")).toEqual([]);
  });

  it("sends bulk_batch_id in p_audit.metadata (the database stamps it on report-mates too) and passes it to the notice", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }, { id: "c" }], report("r1", "a", "b"), ["a", "c"], undefined, "batch-1");
    await out;
    expect(fake.rpcCalls[0].args.p_audit).toEqual({ metadata: { source: "queue", bulk_batch_id: "batch-1" }, ip: "1.2.3.4", user_agent: "ua" });
    expect(fake.dbAudits.map((a) => a.resource_id)).toEqual(["a", "b", "c"]);
    for (const a of fake.dbAudits) expect(a.metadata).toMatchObject({ bulk_batch_id: "batch-1", source: "queue" });
    expect(fx.notified).toEqual([expect.objectContaining({ bulkBatchId: "batch-1" })]);
  });

  it("without a bulkBatchId p_audit.metadata carries no bulk_batch_id", async () => {
    const { fake, out } = run([{ id: "a" }], [], ["a"]);
    await out;
    expect(fake.rpcCalls[0].args.p_audit).toEqual({ metadata: { source: "queue" }, ip: "1.2.3.4", user_agent: "ua" });
    expect(fake.dbAudits[0].metadata).not.toHaveProperty("bulk_batch_id");
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
    expect(o).toEqual({ changedIds: [], alsoReleasedIds: [], skipped: [{ id: "a", reason }], warnings: [], announced: [], notice: null });
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

  describe("a raced release names who and when", () => {
    const sess = (id: string) => ({ user_id: id, role: "medtech" }) as never;
    const raced = (rows: FakeTestRow[], caller: string, staff: Record<string, string> = { maria: "Maria Santos" }) => {
      const fake = makeFakeReleaseDb({ rows, staff });
      const out = releaseVisitSelection({
        supabase: fake.client, session: sess(caller), visitId: "v1", selectedIds: rows.map((r) => r.id),
        medium: "email", auditMeta: { source: "queue" },
      });
      return { fake, out };
    };
    const stamp = "2026-09-30T06:14:00+00:00"; // Sep 30, 2:14 PM Manila (a past date, so it always carries the date)

    it("another staff member released it (RPC refuses not_ready)", async () => {
      const { out } = raced([{ id: "a", status: "released", releasedBy: "maria", releasedAt: stamp }], "u1");
      const o = await out;
      expect(o.skipped).toEqual([{ id: "a", reason: expect.stringMatching(/^Already released by Maria S\. on .+ at 2:14 PM\.$/) }]);
      expect(o.changedIds).toEqual([]);
    });

    it("the caller released it themselves (a double-click or second tab)", async () => {
      const { out } = raced([{ id: "a", status: "released", releasedBy: "u1", releasedAt: stamp }], "u1");
      expect((await out).skipped).toEqual([{ id: "a", reason: expect.stringMatching(/^You already released this on .+ at 2:14 PM\.$/) }]);
    });

    it("an id the result lists nowhere gets the same naming", async () => {
      const { fake, out } = raced([{ id: "a", status: "released", releasedBy: "maria", releasedAt: stamp }], "u1");
      fake.overrideNextRpc("release_visit_results", { released: [], refused: [] });
      expect((await out).skipped[0].reason).toMatch(/^Already released by Maria S\./);
    });

    it("a row that is not released now keeps RACED_REASON", async () => {
      const { fake, out } = raced([{ id: "a", status: "in_progress" }], "u1");
      fake.overrideNextRpc("release_visit_results", { released: [], refused: [refusal("a", "not_ready")] });
      expect((await out).skipped).toEqual([{ id: "a", reason: RACED_REASON }]);
    });

    it("a failed lookup falls back to RACED_REASON and the call still resolves", async () => {
      const { fake, out } = raced([{ id: "a", status: "released", releasedBy: "maria", releasedAt: stamp }], "u1");
      fake.failNext("test_requests", "read");
      const o = await out;
      expect(o.skipped).toEqual([{ id: "a", reason: RACED_REASON }]);
    });

    it("a lookup does not run when nothing raced", async () => {
      const { fake, out } = raced([{ id: "a" }], "u1");
      await out;
      expect(fake.calls).toHaveLength(0);
    });
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
    expect(fake.dbAudits.map((a) => a.resource_id)).toEqual(["c"]);
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
      notice: null,
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
      notice: null,
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
    await expect(notifyReleased("v1", [{ id: "a", name: "A" }], "email")).resolves.toEqual({
      status: "failed",
      channels: [],
      reason: "sending failed",
    });
    expect(fx.reported.map((r) => r.scope)).toEqual(["notify/result-released-selection"]);
  });

  it("returns the notifier's real outcome for one and for many rows", async () => {
    fx.notice = { status: "skipped", channels: [], reason: "no email or phone on file" };
    expect(await notifyReleased("v1", [{ id: "a", name: "A" }], "email")).toEqual(fx.notice);
    fx.notice = { status: "sent", channels: ["email", "sms"], reason: null };
    expect(await notifyReleased("v1", [{ id: "a", name: "A" }, { id: "b", name: "B" }], "email")).toEqual(fx.notice);
  });

  it("sends nothing for an empty list", async () => {
    expect(await notifyReleased("v1", [], "email")).toBeNull();
    expect(fx.notified).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 0210/0212 — the outbox fast path. PR 3 makes release_visit_results return
// notice_id (0214) only while the flag is ON inside the release; absent, the legacy
// sender runs unchanged. A notice_id is the outbox's whatever the flag reads at send
// time: ON -> claim + send, OFF (flipped mid-flight) -> fenced cancel, then legacy.
// ---------------------------------------------------------------------------
describe("outbox fast path", () => {
  const withNotice = (noticeId: unknown) => (f: ReturnType<typeof makeFakeReleaseDb>) =>
    f.overrideNextRpc("release_visit_results", {
      released: [{ id: "a", name: "A", report_id: null, selected: true, released_at: FAKE_RELEASED_AT }],
      refused: [],
      notice_id: noticeId,
    });
  const adminRpcs = () => outbox.rpcs.map((r) => r.name);

  it("without a notice_id (every release today) the legacy sender runs and the outbox is never touched", async () => {
    const o = await run([{ id: "a" }], [], ["a"]).out;
    expect(fx.notified).toHaveLength(1);
    expect(outbox.rpcs).toHaveLength(0);
    expect(outbox.sent).toHaveLength(0);
    expect(o.notice).toEqual({ status: "sent", channels: ["email"], reason: null });
  });

  it("a notice_id but the flag flipped OFF mid-flight: the row is cancelled (fenced), THEN the legacy sender runs", async () => {
    outbox.enabled = false;
    const o = await run([{ id: "a" }], [], ["a"], withNotice("n1")).out;
    expect(outbox.rpcs).toEqual([
      { name: "release_notices_enabled", args: undefined },
      { name: "cancel_release_notice", args: { p_id: "n1", p_reason: "outbox switched off before the send; sent directly" } },
    ]);
    expect(adminRpcs()).not.toContain("claim_release_notice");
    expect(fx.notified).toHaveLength(1);
    expect(outbox.sent).toHaveLength(0);
    expect(o.notice?.status).toBe("sent");
  });

  it("a flag read that ERRORS (or answers anything but true) is OFF too: cancel, then legacy", async () => {
    outbox.enabledError = { message: "boom" };
    await run([{ id: "a" }], [], ["a"], withNotice("n1")).out;
    outbox.enabledError = null;
    outbox.enabled = "true";
    await run([{ id: "a" }], [], ["a"], withNotice("n1")).out;
    expect(adminRpcs().filter((n) => n === "cancel_release_notice")).toHaveLength(2);
    expect(fx.notified).toHaveLength(2);
    expect(outbox.sent).toHaveLength(0);
  });

  it("flag OFF and the cancel finds the row already owned or finished (false): NO legacy send, reads as retrying", async () => {
    outbox.enabled = false;
    outbox.cancelData = false;
    const o = await run([{ id: "a" }], [], ["a"], withNotice("n1")).out;
    expect(fx.notified).toHaveLength(0);
    expect(outbox.sent).toHaveLength(0);
    expect(o.notice).toEqual({ status: "retrying", channels: [], reason: "will retry automatically" });
  });

  it("flag OFF and the cancel itself errors: reported, NO legacy send (the row's state is unknown), operator sees a failure", async () => {
    outbox.enabled = false;
    outbox.cancelError = { message: "boom" };
    const o = await run([{ id: "a" }], [], ["a"], withNotice("n1")).out;
    expect(fx.reported.map((r) => r.scope)).toContain("notify/release-notice:cancel");
    expect(fx.notified).toHaveLength(0);
    expect(o.notice).toEqual({ status: "failed", channels: [], reason: "sending failed" });
  });

  it.each([42, "", null, {}])("an unusable notice_id (%j) is ignored: legacy path, no outbox read", async (bad) => {
    await run([{ id: "a" }], [], ["a"], withNotice(bad)).out;
    expect(fx.notified).toHaveLength(1);
    expect(outbox.rpcs).toHaveLength(0);
  });

  it("a notice_id with the flag ON claims THAT notice (limit 1), sends through the outbox and skips the legacy sender", async () => {
    outbox.sendResult = { outcome: { status: "retrying", channels: [], reason: "will retry automatically" }, finalStatus: "retry" };
    const o = await run([{ id: "a" }], [], ["a"], withNotice("n1")).out;
    expect(outbox.rpcs).toEqual([
      { name: "release_notices_enabled", args: undefined },
      { name: "claim_release_notice", args: { p_id: "n1", p_limit: 1 } },
    ]);
    expect(outbox.sent).toEqual([{ id: "n1", lease_token: "lease-1", status: "sending" }]);
    expect(fx.notified).toHaveLength(0);
    expect(o.notice).toEqual({ status: "retrying", channels: [], reason: "will retry automatically" });
    expect(o.announced).toHaveLength(1);
    expect(fx.alerts).toEqual([["v1", 1]]);
  });

  it("carries a sent outcome from the outbox unchanged", async () => {
    const o = await run([{ id: "a" }], [], ["a"], withNotice("n1")).out;
    expect(o.notice).toEqual({ status: "sent", channels: ["email"], reason: null });
  });

  it("a claim that returns nothing (the row is leased elsewhere / not due) tells the operator it will retry — nothing is sent twice", async () => {
    outbox.claimData = [];
    const o = await run([{ id: "a" }], [], ["a"], withNotice("n1")).out;
    expect(o.notice).toEqual({ status: "retrying", channels: [], reason: "will retry automatically" });
    expect(outbox.sent).toHaveLength(0);
    expect(fx.notified).toHaveLength(0);
  });

  it("a claim that errors is reported and also reads as retrying (the sweeper owns the row)", async () => {
    outbox.claimError = { message: "boom" };
    const o = await run([{ id: "a" }], [], ["a"], withNotice("n1")).out;
    expect(o.notice?.status).toBe("retrying");
    expect(fx.reported.map((r) => r.scope)).toContain("notify/release-notice:claim");
    expect(fx.notified).toHaveLength(0);
  });

  it("notifyReleased passes a notice id through the same gate", async () => {
    expect(await notifyReleased("v1", [{ id: "a", name: "A" }], "email", "batch", "n9")).toEqual({
      status: "sent", channels: ["email"], reason: null,
    });
    expect(outbox.rpcs[1]).toEqual({ name: "claim_release_notice", args: { p_id: "n9", p_limit: 1 } });
    expect(fx.notified).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 0214 — release_visit_results enqueues, undo_visit_release cancels (the fake
// models both; the SQL is proved by supabase/tests/0214_release_notice_enqueue_smoke.sql
// and scripts/report-release-concurrency-proof.ts).
// ---------------------------------------------------------------------------
describe("release-notice enqueue (0214 model)", () => {
  type Fake = ReturnType<typeof makeFakeReleaseDb>;
  type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  const rpcOf = (f: Fake) => (f.client as unknown as { rpc: Rpc }).rpc;
  const on = (f: Fake) => f.setOutboxEnabled(true);
  const undo = (f: Fake, ids: string[]) =>
    rpcOf(f)("undo_visit_release", { p_visit_id: "v1", p_test_request_ids: ids, p_actor: "u1", p_reason: "test" });

  it("flag OFF (the default): no notice row and no notice_id — the legacy path is byte-identical", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b"]);
    const o = await out;
    expect(fake.notices).toHaveLength(0);
    const call = await rpcOf(fake)("release_visit_results", { p_visit_id: "v1", p_test_request_ids: ["a"], p_medium: "email" });
    expect(Object.keys(call.data as object).sort()).toEqual(["refused", "released"]);
    expect(fx.notified).toHaveLength(1);
    expect(outbox.rpcs).toHaveLength(0);
    expect(o.notice?.status).toBe("sent");
  });

  it("flag ON: ONE pending notice per call covering every released id, with the medium, the batch id and the stamp", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }, { id: "c" }], [], ["a", "b", "c"], on, "batch-9");
    await out;
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0]).toMatchObject({
      visit_id: "v1",
      status: "pending",
      test_request_ids: ["a", "b", "c"],
      release_medium: "email",
      bulk_batch_id: "batch-9",
      released_at: FAKE_RELEASED_AT,
      next_attempt_at: FAKE_RELEASED_AT,
      lease_token: null,
      resolved_at: null,
    });
    // the outbox owned the send: claimed that very notice, the legacy sender stayed silent
    expect(outbox.rpcs.at(-1)).toEqual({ name: "claim_release_notice", args: { p_id: fake.notices[0].id, p_limit: 1 } });
    expect(fx.notified).toHaveLength(0);
  });

  it("flag ON: report-mates released with the selection are in the same single notice", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }, { id: "c" }], report("R", "a", "b", "c"), ["a"], on);
    const o = await out;
    expect(o.alsoReleasedIds.sort()).toEqual(["b", "c"]);
    expect(fake.notices).toHaveLength(1);
    expect(fake.notices[0].test_request_ids).toEqual(["a", "b", "c"]);
  });

  it("flag ON but nothing released (refused / not ready): no notice and no notice_id", async () => {
    const { fake, out } = run([{ id: "a", status: "in_progress" }], [], ["a"], on);
    await out;
    expect(fake.notices).toHaveLength(0);
  });

  it("two calls enqueue two notices (one per call), each with its own ids", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a"], on);
    await out;
    await releaseVisitSelection({ supabase: fake.client, session, visitId: "v1", selectedIds: ["b"], medium: "email", auditMeta: {} });
    expect(fake.notices.map((n) => n.test_request_ids)).toEqual([["a"], ["b"]]);
  });

  it("undo cancels a pending notice once EVERY test is un-released, and leaves a partly undone one alone", async () => {
    const { fake, out } = run([{ id: "a" }, { id: "b" }], [], ["a", "b"], on);
    await out;
    await undo(fake, ["a"]);
    expect(fake.notices[0].status).toBe("pending");
    await undo(fake, ["b"]);
    expect(fake.notices[0]).toMatchObject({ status: "cancelled", lease_token: null, skip_reason: "release undone" });
    expect(fake.notices[0].resolved_at).not.toBeNull();
  });

  it("undo cancels a retry notice, never a sending one, and never a terminal one", async () => {
    const { fake, out } = run([{ id: "a" }], [], ["a"], on);
    await out;
    fake.markNoticeSending(fake.notices[0].id);
    await undo(fake, ["a"]);
    expect(fake.notices[0]).toMatchObject({ status: "sending", resolved_at: null });
    expect(fake.notices[0].lease_token).not.toBeNull();

    const r2 = run([{ id: "a" }], [], ["a"], on);
    await r2.out;
    r2.fake.notices[0].status = "retry";
    await undo(r2.fake, ["a"]);
    expect(r2.fake.notices[0].status).toBe("cancelled");

    const r3 = run([{ id: "a" }], [], ["a"], on);
    await r3.out;
    r3.fake.notices[0].status = "sent";
    await undo(r3.fake, ["a"]);
    expect(r3.fake.notices[0].status).toBe("sent");
  });

  it("undo cancels whatever the flag now says", async () => {
    const { fake, out } = run([{ id: "a" }], [], ["a"], on);
    await out;
    fake.setOutboxEnabled(false);
    await undo(fake, ["a"]);
    expect(fake.notices[0].status).toBe("cancelled");
  });

  it("cancel_release_notice is fenced: pending / retry -> true, sending / terminal / unknown -> false", async () => {
    const { fake, out } = run([{ id: "a" }], [], ["a"], on);
    await out;
    const id = fake.notices[0].id;
    const cancel = (nid: string) => rpcOf(fake)("cancel_release_notice", { p_id: nid, p_reason: "r" });
    fake.markNoticeSending(id);
    expect((await cancel(id)).data).toBe(false);
    expect(fake.notices[0].status).toBe("sending");
    fake.notices[0].status = "pending";
    expect((await cancel(id)).data).toBe(true);
    expect(fake.notices[0]).toMatchObject({ status: "cancelled", skip_reason: "r" });
    expect((await cancel(id)).data).toBe(false);
    expect((await cancel("nope")).data).toBe(false);
  });

  it("end to end, the flag flipped OFF between the release and the send: cancelled, then ONE legacy send", async () => {
    const { fake, out } = run([{ id: "a" }], [], ["a"], (f) => {
      on(f);
      // The release (flag ON in its transaction) enqueues; the app's flag read then says OFF.
      f.hooks.beforeRpc = () => {
        outbox.enabled = false;
      };
    });
    const o = await out;
    expect(fake.notices).toHaveLength(1);
    expect(adminRpcsOf()).toEqual(["release_notices_enabled", "cancel_release_notice"]);
    expect(fx.notified).toHaveLength(1);
    expect(o.notice?.status).toBe("sent");
  });
});
const adminRpcsOf = () => outbox.rpcs.map((r) => r.name);
