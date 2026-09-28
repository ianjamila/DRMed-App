import { describe, expect, it } from "vitest";
import { stillCommittedRows } from "./partial-panel";

describe("stillCommittedRows", () => {
  const row = (id: string, status: string, assigned_to: string | null, started_at: string | null) => ({
    id,
    status,
    assigned_to,
    started_at,
  });

  it("keeps only rows still exactly in the state a compensation attempt should have reverted", () => {
    const fresh = [
      row("a", "in_progress", "u1", "2026-09-28T00:00:00Z"), // compensation failed — still claimed
      row("b", "requested", null, null), // compensation succeeded
      row("c", "in_progress", "u1", "2026-09-28T00:00:00Z"), // compensation failed — still claimed
    ];
    const isCommitted = (r: (typeof fresh)[number]) =>
      r.status === "in_progress" && r.assigned_to === "u1" && r.started_at === "2026-09-28T00:00:00Z";
    expect(stillCommittedRows(fresh, isCommitted).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("returns nothing when every row was put back", () => {
    const fresh = [row("a", "requested", null, null), row("b", "requested", null, null)];
    const isCommitted = (r: (typeof fresh)[number]) => r.status === "in_progress";
    expect(stillCommittedRows(fresh, isCommitted)).toEqual([]);
  });

  it("a row claimed by someone else entirely is not 'still committed' to THIS call", () => {
    const fresh = [row("a", "in_progress", "someone-else", "2026-09-28T00:00:00Z")];
    const isCommitted = (r: (typeof fresh)[number]) => r.status === "in_progress" && r.assigned_to === "u1";
    expect(stillCommittedRows(fresh, isCommitted)).toEqual([]);
  });
});
