import { describe, expect, it } from "vitest";
import { stillCommittedRows, groupIdsByDeletedAt, partiallyRestoredIds } from "./partial-panel";

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

describe("groupIdsByDeletedAt", () => {
  it("groups ids that share the exact same deleted_at string into one bucket", () => {
    const groups = groupIdsByDeletedAt([
      { id: "a", deleted_at: "2026-09-28T00:00:00+00:00" },
      { id: "b", deleted_at: "2026-09-27T00:00:00+00:00" },
      { id: "c", deleted_at: "2026-09-28T00:00:00+00:00" },
    ]);
    expect([...groups.entries()]).toEqual([
      ["2026-09-28T00:00:00+00:00", ["a", "c"]],
      ["2026-09-27T00:00:00+00:00", ["b"]],
    ]);
  });

  it("a restore-and-re-delete between the read and the write lands in its OWN bucket, not the stale one", () => {
    // This is the shape finding 3 closes: id "a" was read as deleted at T1,
    // but re-delete had already moved it to T2 by write time — reading it
    // again would show T2. Grouping by the value actually read means the
    // predicated write for T1 never touches it.
    const groups = groupIdsByDeletedAt([
      { id: "a", deleted_at: "T2" },
      { id: "b", deleted_at: "T1" },
    ]);
    expect(groups.get("T1")).toEqual(["b"]);
    expect(groups.get("T2")).toEqual(["a"]);
  });
});

describe("partiallyRestoredIds", () => {
  it("returns the restored subset when some but not all of a panel came back", () => {
    expect(partiallyRestoredIds(["a", "b", "c"], new Set(["a", "c"]))).toEqual(["a", "c"]);
  });

  it("returns null when nothing came back — the whole-panel refusal already covers it", () => {
    expect(partiallyRestoredIds(["a", "b"], new Set())).toBeNull();
  });

  it("returns null when everything came back — a clean, fully-restored panel", () => {
    expect(partiallyRestoredIds(["a", "b"], new Set(["a", "b"]))).toBeNull();
  });
});
