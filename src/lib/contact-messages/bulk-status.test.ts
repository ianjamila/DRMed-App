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

describe("groupMessagesForWrite exactness", () => {
  const base = { id: "1", from: "new" as const, handled_by: null as string | null, handled_at: null as string | null };

  it("keeps rows that differ only in status apart", () => {
    const groups = groupMessagesForWrite([base, { ...base, id: "2", from: "closed" }]);
    expect(groups.map((g) => [g.from, g.ids])).toEqual([["new", ["1"]], ["closed", ["2"]]]);
  });

  it("keeps rows that differ only in handled_by apart", () => {
    const groups = groupMessagesForWrite([
      { ...base, handled_by: "u1" },
      { ...base, id: "2", handled_by: "u2" },
    ]);
    expect(groups.map((g) => [g.handledBy, g.ids])).toEqual([["u1", ["1"]], ["u2", ["2"]]]);
  });

  it("keeps a null handler apart from the string 'null'", () => {
    const groups = groupMessagesForWrite([base, { ...base, id: "2", handled_by: "null" }]);
    expect(groups.map((g) => [g.handledBy, g.ids])).toEqual([[null, ["1"]], ["null", ["2"]]]);
  });
});

describe("planMessageUndo skip guards, one at a time", () => {
  const good = { from: "new", to: "closed", previous_handled_by: null, previous_handled_at: null, handled_at: STAMP };

  it("the control row is planned", () => {
    expect(planMessageUndo([row("1", good)])).toHaveLength(1);
  });

  it("skips an empty-string handled_at stamp", () => {
    expect(planMessageUndo([row("1", { ...good, handled_at: "" })])).toEqual([]);
  });

  it("skips an unknown from status", () => {
    expect(planMessageUndo([row("1", { ...good, from: "bogus" })])).toEqual([]);
  });

  it("skips a non-string, non-null previous_handled_by", () => {
    expect(planMessageUndo([row("1", { ...good, previous_handled_by: 5 })])).toEqual([]);
  });

  it("skips a row with null metadata", () => {
    expect(
      planMessageUndo([{ resource_id: "1", action: "contact_message.status_changed", metadata: null }]),
    ).toEqual([]);
  });

  it("skips a row missing previous_handled_by even when previous_handled_at is present", () => {
    const rest: Record<string, unknown> = { ...good };
    delete rest.previous_handled_by;
    expect(planMessageUndo([row("1", rest)])).toEqual([]);
  });
});

describe("bucketMessageUndo exactness", () => {
  const entry = (id: string, over: Partial<Parameters<typeof bucketMessageUndo>[0][number]> = {}) => ({
    id,
    current: "closed" as const,
    restoreTo: "new" as const,
    previousHandledBy: "u1" as string | null,
    previousHandledAt: "2026-09-29T00:00:00+00:00" as string | null,
    stamp: STAMP,
    ...over,
  });

  it("returns whole buckets (every field, ids, no id)", () => {
    expect(bucketMessageUndo([entry("1"), entry("2")])).toEqual([
      {
        current: "closed",
        restoreTo: "new",
        previousHandledBy: "u1",
        previousHandledAt: "2026-09-29T00:00:00+00:00",
        stamp: STAMP,
        ids: ["1", "2"],
      },
    ]);
  });

  it("splits entries that differ in only the stamp", () => {
    expect(bucketMessageUndo([entry("1"), entry("2", { stamp: "2026-09-30T04:00:00.000Z" })]).map((b) => b.ids)).toEqual([["1"], ["2"]]);
  });

  it("splits entries that differ in only previousHandledAt", () => {
    expect(
      bucketMessageUndo([entry("1"), entry("2", { previousHandledAt: "2026-09-28T00:00:00+00:00" })]).map((b) => b.ids),
    ).toEqual([["1"], ["2"]]);
  });

  it("splits entries that differ in only current", () => {
    expect(bucketMessageUndo([entry("1"), entry("2", { current: "replied" })]).map((b) => b.ids)).toEqual([["1"], ["2"]]);
  });
});
