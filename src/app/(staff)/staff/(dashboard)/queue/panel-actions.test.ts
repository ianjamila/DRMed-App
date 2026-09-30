import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bulk bar's three server actions mint ONE batch id per call and hand the
 * same id to the single-test core AND to every panel write, so a mixed
 * selection has one Undo. Everything downstream (cores, panel writes, panel
 * reads) is mocked: what is pinned here is the wiring — which id goes where,
 * what a browser-supplied id does (nothing), and the fail-closed unclaim.
 */

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const h = vi.hoisted(() => ({
  session: { user_id: "staff-1", role: "admin" } as { user_id: string; role: string },
  fetchPanelMembers: vi.fn(),
  claimTestsCore: vi.fn(),
  unclaimTestsCore: vi.fn(),
  deleteTestRequestsManyCore: vi.fn(),
  claimPanelMembers: vi.fn(),
  unclaimPanelMembers: vi.fn(),
  readBenchStartedAt: vi.fn(),
}));

vi.mock("@/lib/auth/require-staff", () => ({ requireActiveStaff: async () => h.session }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/queue/panel-members", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queue/panel-members")>()),
  fetchPanelMembers: h.fetchPanelMembers,
}));
vi.mock("@/lib/actions/queue/bulk-cores", () => ({
  claimTestsCore: h.claimTestsCore,
  unclaimTestsCore: h.unclaimTestsCore,
}));
vi.mock("@/lib/actions/queue/bulk-delete-core", () => ({
  NOT_QUEUE_DELETE_STAFF: "Only reception or admin can delete queue entries.",
  deleteTestRequestsManyCore: h.deleteTestRequestsManyCore,
}));
vi.mock("@/lib/actions/queue/panel-writes", () => ({
  claimPanelMembers: h.claimPanelMembers,
  unclaimPanelMembers: h.unclaimPanelMembers,
  readBenchStartedAt: h.readBenchStartedAt,
}));

import {
  claimPanelAction,
  claimQueueSelectionAction,
  deleteQueueSelectionAction,
  unclaimQueueSelectionAction,
} from "./panel-actions";
import { panelRowKey } from "@/lib/queue/bulk-queue";

const VISIT = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const VISIT_B = "33333333-3333-4333-8333-333333333333";
const SINGLE = "44444444-4444-4444-8444-444444444444";
const SINGLE_2 = "55555555-5555-4555-8555-555555555555";
const HOLDER = "66666666-6666-4666-8666-666666666666";
const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = panelRowKey(VISIT, GROUP);
const KEY_B = panelRowKey(VISIT_B, GROUP);

function member(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    status: "requested",
    assignedTo: null,
    section: "chemistry",
    parentId: null,
    visitPaymentStatus: "paid",
    visitHmoProviderId: null,
    hasOpenHmoClaim: false,
    resultId: null,
    hasPdf: false,
    ...over,
  };
}

function panelRead(byKey: Record<string, ReturnType<typeof member>[]>) {
  h.fetchPanelMembers.mockResolvedValue({ ok: true, byKey: new Map(Object.entries(byKey)) });
}

const okCore = (ids: string[]) => async (..._args: unknown[]) => ({
  ok: true as const,
  changedIds: ids,
  skipped: [],
  batchId: (_args.at(-1) as { batchId: string }).batchId,
});

beforeEach(() => {
  for (const fn of Object.values(h)) if (typeof fn === "function" && "mockReset" in fn) fn.mockReset();
  h.session = { user_id: "staff-1", role: "admin" };
  h.claimPanelMembers.mockResolvedValue({ ok: true });
  h.unclaimPanelMembers.mockResolvedValue({ ok: true });
  h.readBenchStartedAt.mockResolvedValue({ ok: true, startedAtById: new Map() });
  h.claimTestsCore.mockImplementation(okCore([SINGLE]));
  h.unclaimTestsCore.mockImplementation(okCore([SINGLE]));
  h.deleteTestRequestsManyCore.mockImplementation(async (_s: unknown, input: { testRequestIds: string[] }, ctx: { batchId: string }) => ({
    ok: true,
    changedIds: input.testRequestIds,
    skipped: [],
    batchId: ctx.batchId,
  }));
});

describe("claimQueueSelectionAction", () => {
  it("uses ONE batch id for the single-test core and every panel write, and returns it", async () => {
    panelRead({ [KEY]: [member(M1), member(M2)] });
    const r = await claimQueueSelectionAction({
      testRequestIds: [SINGLE],
      panels: [{ visitId: VISIT, groupId: GROUP }],
    });

    expect(h.claimTestsCore).toHaveBeenCalledTimes(1);
    const [, , ids, ctx] = h.claimTestsCore.mock.calls[0]!;
    expect(ids).toEqual([SINGLE]);
    expect(ctx.batchSize).toBe(2); // one single + one panel = two selected rows
    expect(ctx.batchId).toMatch(/^[0-9a-f-]{36}$/);

    expect(h.claimPanelMembers).toHaveBeenCalledTimes(1);
    const args = h.claimPanelMembers.mock.calls[0]!;
    expect(args[2]).toEqual([M1, M2]);
    expect(args[3]).toEqual({ visit_id: VISIT, report_group_id: GROUP });
    expect(args[4]).toEqual({ batchId: ctx.batchId, batchSize: 2, panelKey: KEY, visitId: VISIT });

    expect(r).toEqual({ ok: true, changedIds: [SINGLE, M1, M2], skipped: [], batchId: ctx.batchId });
  });

  it("ignores a batch id the browser sends", async () => {
    panelRead({ [KEY]: [member(M1)] });
    await claimQueueSelectionAction({
      testRequestIds: [SINGLE],
      panels: [{ visitId: VISIT, groupId: GROUP }],
      batchId: "forged",
      bulk_batch_id: "forged",
      panelKey: "forged",
    });
    expect(h.claimTestsCore.mock.calls[0]![3].batchId).not.toBe("forged");
    expect(h.claimPanelMembers.mock.calls[0]![4].batchId).toBe(h.claimTestsCore.mock.calls[0]![3].batchId);
    expect(h.claimPanelMembers.mock.calls[0]![4].panelKey).toBe(KEY);
  });

  it("mints a fresh id for every call", async () => {
    panelRead({ [KEY]: [member(M1)] });
    await claimQueueSelectionAction({ testRequestIds: [], panels: [{ visitId: VISIT, groupId: GROUP }] });
    await claimQueueSelectionAction({ testRequestIds: [], panels: [{ visitId: VISIT, groupId: GROUP }] });
    expect(h.claimPanelMembers.mock.calls[0]![4].batchId).not.toBe(h.claimPanelMembers.mock.calls[1]![4].batchId);
  });

  it("a panels-only selection never calls the single-test core, and still returns the batch id", async () => {
    panelRead({ [KEY]: [member(M1)] });
    const r = await claimQueueSelectionAction({ testRequestIds: [], panels: [{ visitId: VISIT, groupId: GROUP }] });
    expect(h.claimTestsCore).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, changedIds: [M1], batchId: h.claimPanelMembers.mock.calls[0]![4].batchId });
  });

  it("returns no batch id when nothing changed — there is nothing to undo", async () => {
    panelRead({ [KEY]: [member(M1)] });
    h.claimTestsCore.mockResolvedValue({ ok: true, changedIds: [], skipped: [{ id: SINGLE, reason: "taken" }], batchId: "x" });
    h.claimPanelMembers.mockResolvedValue({ ok: false, error: "changed" });
    const r = await claimQueueSelectionAction({
      testRequestIds: [SINGLE],
      panels: [{ visitId: VISIT, groupId: GROUP }],
    });
    expect(r).toEqual({
      ok: true,
      changedIds: [],
      skipped: [
        { id: SINGLE, reason: "taken" },
        { id: KEY, reason: "changed" },
      ],
    });
  });

  it("a refused single-test call refuses the whole selection before any panel is claimed", async () => {
    panelRead({ [KEY]: [member(M1)] });
    h.claimTestsCore.mockResolvedValue({ ok: false, error: "Only lab staff can claim or unclaim tests from the queue." });
    const r = await claimQueueSelectionAction({
      testRequestIds: [SINGLE],
      panels: [{ visitId: VISIT, groupId: GROUP }],
    });
    expect(r).toEqual({ ok: false, error: "Only lab staff can claim or unclaim tests from the queue." });
    expect(h.claimPanelMembers).not.toHaveBeenCalled();
  });

  it("dedupes the single ids before the core and counts the batch by unique rows", async () => {
    panelRead({});
    await claimQueueSelectionAction({ testRequestIds: [SINGLE, SINGLE, SINGLE_2], panels: [] });
    const [, , ids, ctx] = h.claimTestsCore.mock.calls[0]!;
    expect(ids).toEqual([SINGLE, SINGLE_2]);
    expect(ctx.batchSize).toBe(2);
  });
});

describe("unclaimQueueSelectionAction", () => {
  const held = (id: string) => member(id, { status: "in_progress", assignedTo: HOLDER });
  const seen = (ids: string[]) => ids.map((id) => ({ id, holder: HOLDER }));

  it("shares one batch id, pre-reads started_at once for all panels, and hands it to each panel", async () => {
    panelRead({ [KEY]: [held(M1), held(M2)] });
    h.readBenchStartedAt.mockResolvedValue({
      ok: true,
      startedAtById: new Map([
        [M1, "2026-09-30T00:00:01+00:00"],
        [M2, "2026-09-30T00:00:02+00:00"],
      ]),
    });
    const r = await unclaimQueueSelectionAction({
      items: [{ testRequestId: SINGLE, assignedTo: HOLDER }],
      panels: [{ visitId: VISIT, groupId: GROUP, members: seen([M1, M2]) }],
      reason: "  wrong bench ",
    });

    expect(h.readBenchStartedAt).toHaveBeenCalledTimes(1);
    expect(h.readBenchStartedAt.mock.calls[0]![1]).toEqual([M1, M2]);

    const [, , input, ctx] = h.unclaimTestsCore.mock.calls[0]!;
    expect(input).toEqual({ items: [{ testRequestId: SINGLE, assignedTo: HOLDER }], reason: "wrong bench" });
    expect(ctx.batchSize).toBe(2);

    const call = h.unclaimPanelMembers.mock.calls[0]![2];
    expect(call.batch).toEqual({ batchId: ctx.batchId, batchSize: 2, panelKey: KEY, visitId: VISIT });
    expect(call.startedAtOf(M1)).toBe("2026-09-30T00:00:01+00:00");
    expect(call.startedAtOf(M2)).toBe("2026-09-30T00:00:02+00:00");
    expect(call.startedAtOf("unknown")).toBeNull();
    expect(call.members).toEqual([
      { id: M1, holder: HOLDER },
      { id: M2, holder: HOLDER },
    ]);
    expect(r).toEqual({ ok: true, changedIds: [SINGLE, M1, M2], skipped: [], batchId: ctx.batchId });
  });

  it("reads started_at once for SEVERAL panels", async () => {
    const M3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    panelRead({ [KEY]: [held(M1)], [KEY_B]: [held(M3)] });
    await unclaimQueueSelectionAction({
      items: [],
      panels: [
        { visitId: VISIT, groupId: GROUP, members: seen([M1]) },
        { visitId: VISIT_B, groupId: GROUP, members: seen([M3]) },
      ],
    });
    expect(h.readBenchStartedAt).toHaveBeenCalledTimes(1);
    expect(h.readBenchStartedAt.mock.calls[0]![1]).toEqual([M1, M3]);
    expect(h.unclaimPanelMembers).toHaveBeenCalledTimes(2);
    expect(h.unclaimPanelMembers.mock.calls[0]![2].batch.batchId).toBe(h.unclaimPanelMembers.mock.calls[1]![2].batch.batchId);
  });

  it("fails closed when the started_at read fails: every panel is skipped, the singles still proceed", async () => {
    panelRead({ [KEY]: [held(M1)] });
    h.readBenchStartedAt.mockResolvedValue({ ok: false });
    const r = await unclaimQueueSelectionAction({
      items: [{ testRequestId: SINGLE, assignedTo: HOLDER }],
      panels: [{ visitId: VISIT, groupId: GROUP, members: seen([M1]) }],
    });
    expect(h.unclaimPanelMembers).not.toHaveBeenCalled();
    expect(h.unclaimTestsCore).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      ok: true,
      changedIds: [SINGLE],
      skipped: [{ id: KEY, reason: "Could not read the report — refresh the queue and try again." }],
      batchId: h.unclaimTestsCore.mock.calls[0]![3].batchId,
    });
  });

  it("ignores a batch id the browser sends", async () => {
    panelRead({ [KEY]: [held(M1)] });
    await unclaimQueueSelectionAction({
      items: [],
      panels: [{ visitId: VISIT, groupId: GROUP, members: seen([M1]), batchId: "forged" }],
      batchId: "forged",
    });
    expect(h.unclaimPanelMembers.mock.calls[0]![2].batch.batchId).not.toBe("forged");
  });
});

describe("deleteQueueSelectionAction", () => {
  it("passes the same batch id to the singles and to each panel, adding the panel key only for panels", async () => {
    panelRead({ [KEY]: [member(M1), member(M2)] });
    const r = await deleteQueueSelectionAction({
      testRequestIds: [SINGLE],
      panels: [{ visitId: VISIT, groupId: GROUP }],
      reason: "duplicate entry",
    });
    expect(h.deleteTestRequestsManyCore).toHaveBeenCalledTimes(2);
    const [, singleInput, singleCtx] = h.deleteTestRequestsManyCore.mock.calls[0]!;
    const [, panelInput, panelCtx] = h.deleteTestRequestsManyCore.mock.calls[1]!;
    expect(singleInput).toEqual({ testRequestIds: [SINGLE], reason: "duplicate entry" });
    expect(singleCtx).toEqual({ batchId: singleCtx.batchId, batchSize: 2 });
    expect(singleCtx).not.toHaveProperty("panelKey");
    expect(panelInput).toEqual({ testRequestIds: [M1, M2], reason: "duplicate entry" });
    expect(panelCtx).toEqual({ batchId: singleCtx.batchId, batchSize: 2, panelKey: KEY });
    expect(r).toEqual({ ok: true, changedIds: [SINGLE, M1, M2], skipped: [], batchId: singleCtx.batchId });
  });

  it("refuses a role that cannot delete before any read, minting nothing", async () => {
    h.session = { user_id: "staff-1", role: "medtech" };
    const r = await deleteQueueSelectionAction({ testRequestIds: [SINGLE], panels: [], reason: "x" });
    expect(r).toEqual({ ok: false, error: "Only reception or admin can delete queue entries." });
    expect(h.fetchPanelMembers).not.toHaveBeenCalled();
    expect(h.deleteTestRequestsManyCore).not.toHaveBeenCalled();
  });
});

describe("claimPanelAction (the row button)", () => {
  it("claims with no batch, so it leaves the single grouped audit row and no Undo", async () => {
    panelRead({ [KEY]: [member(M1)] });
    const r = await claimPanelAction({ visitId: VISIT, groupId: GROUP });
    expect(r).toEqual({ ok: true });
    const args = h.claimPanelMembers.mock.calls[0]!;
    expect(args).toHaveLength(4);
    expect(args[4]).toBeUndefined();
  });
});
