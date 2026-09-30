import { describe, expect, it } from "vitest";
import {
  MESSAGE_BULK_BUTTONS,
  bucketMessageUndo,
  bulkMessagePlan,
  groupMessagesForWrite,
  notAllowedReason,
  planMessageUndo,
} from "./bulk-status";

describe("bulkMessagePlan", () => {
  it("offers each target only the rows the matrix allows, in selection order", () => {
    const plan = bulkMessagePlan([
      { key: "a", status: "new" },
      { key: "b", status: "booked" },
      { key: "c", status: "closed" },
      { key: "d", status: "replied" },
      { key: "e", status: "bogus" },
    ]);
    expect(plan).toEqual({ replied: ["a"], closed: ["a", "b", "d"], new: ["b", "c", "d"] });
  });

  it("buttons are Mark replied, Mark closed, Reopen", () => {
    expect(MESSAGE_BULK_BUTTONS.map((b) => [b.to, b.label])).toEqual([
      ["replied", "Mark replied"],
      ["closed", "Mark closed"],
      ["new", "Reopen"],
    ]);
  });
});

describe("notAllowedReason", () => {
  it("names both statuses in plain words", () => {
    expect(notAllowedReason("booked", "replied")).toBe("a Booked message can't be moved to Replied");
  });
});

describe("groupMessagesForWrite", () => {
  it("groups by the exact (status, handled_by, handled_at) the write will predicate on", () => {
    const groups = groupMessagesForWrite([
      { id: "1", from: "new", handled_by: null, handled_at: null },
      { id: "2", from: "new", handled_by: null, handled_at: null },
      { id: "3", from: "replied", handled_by: "u1", handled_at: "2026-09-30T01:00:00+00:00" },
      { id: "4", from: "replied", handled_by: "u1", handled_at: "2026-09-30T02:00:00+00:00" },
    ]);
    expect(groups).toEqual([
      { from: "new", handledBy: null, handledAt: null, ids: ["1", "2"] },
      { from: "replied", handledBy: "u1", handledAt: "2026-09-30T01:00:00+00:00", ids: ["3"] },
      { from: "replied", handledBy: "u1", handledAt: "2026-09-30T02:00:00+00:00", ids: ["4"] },
    ]);
  });
});

const STAMP = "2026-09-30T03:00:00.000Z";
const row = (id: string, m: Record<string, unknown>, action = "contact_message.status_changed") => ({
  resource_id: id,
  action,
  metadata: { bulk_batch_id: "b", ...m },
});

describe("planMessageUndo", () => {
  it("reads current/restore/previous handler and the stamp from each bulk audit row", () => {
    expect(
      planMessageUndo([
        row("1", { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }),
        row("2", { from: "booked", to: "new", previous_handled_by: "u9", previous_handled_at: "2026-09-29T00:00:00+00:00", handled_at: STAMP }),
      ]),
    ).toEqual([
      { id: "1", current: "closed", restoreTo: "new", previousHandledBy: null, previousHandledAt: null, stamp: STAMP },
      { id: "2", current: "new", restoreTo: "booked", previousHandledBy: "u9", previousHandledAt: "2026-09-29T00:00:00+00:00", stamp: STAMP },
    ]);
  });

  it("skips rows that cannot be reversed exactly", () => {
    expect(
      planMessageUndo([
        row("1", { from: "new", to: "closed", previous_handled_by: null, handled_at: STAMP }), // no previous_handled_at key
        row("2", { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null }), // no stamp
        row("3", { from: "closed", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }),
        row("4", { from: "new", to: "booked", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }),
        row("5", { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }, "contact_message.notes_updated"),
        { resource_id: null, action: "contact_message.status_changed", metadata: {} },
      ]),
    ).toEqual([]);
  });

  it("keeps the first row per message", () => {
    const plan = planMessageUndo([
      row("1", { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }),
      row("1", { from: "replied", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP }),
    ]);
    expect(plan.map((e) => e.restoreTo)).toEqual(["new"]);
  });
});

describe("bucketMessageUndo", () => {
  it("one write per exact (current, restoreTo, previous handler, stamp)", () => {
    const e = (id: string, restoreTo: "new" | "replied", by: string | null) => ({
      id, current: "closed" as const, restoreTo, previousHandledBy: by, previousHandledAt: by ? "2026-09-29T00:00:00+00:00" : null, stamp: STAMP,
    });
    expect(bucketMessageUndo([e("1", "new", null), e("2", "new", null), e("3", "replied", "u1")]).map((b) => b.ids)).toEqual([
      ["1", "2"],
      ["3"],
    ]);
  });
});
