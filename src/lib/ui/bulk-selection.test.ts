import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  addEntries,
  canAdd,
  keysByKind,
  recordsOf,
  removeKeys,
  selectAllState,
  toggleEntry,
  type SelectionEntry,
} from "./bulk-selection";

const e = (rowKey: string, kinds: string[] = ["confirmed"], weight = 1): SelectionEntry => ({
  rowKey,
  kinds,
  weight,
});
const limits = { rows: 3, records: 5 };

describe("addEntries", () => {
  it("adds in order and reports nothing refused under the caps", () => {
    const { next, refused } = addEntries(EMPTY_SELECTION, [e("a"), e("b")], limits);
    expect([...next.keys()]).toEqual(["a", "b"]);
    expect(refused).toEqual([]);
  });

  it("stops at the row cap and refuses everything from that entry on", () => {
    const { next, refused } = addEntries(EMPTY_SELECTION, [e("a"), e("b"), e("c"), e("d"), e("e")], limits);
    expect([...next.keys()]).toEqual(["a", "b", "c"]);
    expect(refused).toEqual(["d", "e"]);
  });

  it("stops at the record cap without splitting a heavy row", () => {
    const { next, refused } = addEntries(EMPTY_SELECTION, [e("a", ["x"], 2), e("b", ["x"], 3), e("c", ["x"], 1)], limits);
    // a(2) + b(3) = 5 fits; c(1) would make 6 → refused, and a/b stay whole.
    expect([...next.keys()]).toEqual(["a", "b"]);
    expect(refused).toEqual(["c"]);
    expect(recordsOf(next)).toBe(5);
  });

  it("skips keys already selected and returns the same reference when nothing changes", () => {
    const { next: first } = addEntries(EMPTY_SELECTION, [e("a")], limits);
    const { next: again, refused } = addEntries(first, [e("a")], limits);
    expect(again).toBe(first);
    expect(refused).toEqual([]);
  });
});

describe("removeKeys / toggleEntry", () => {
  it("removes only the given keys and keeps the rest", () => {
    const { next } = addEntries(EMPTY_SELECTION, [e("a"), e("b"), e("c")], limits);
    const after = removeKeys(next, ["b", "zzz"]);
    expect([...after.keys()]).toEqual(["a", "c"]);
  });

  it("returns the same reference when no key was present", () => {
    const { next } = addEntries(EMPTY_SELECTION, [e("a")], limits);
    expect(removeKeys(next, ["nope"])).toBe(next);
  });

  it("toggle adds when absent and removes when present", () => {
    const on = toggleEntry(EMPTY_SELECTION, e("a"), limits);
    expect(on.has("a")).toBe(true);
    const off = toggleEntry(on, e("a"), limits);
    expect(off.has("a")).toBe(false);
  });

  it("toggle is a no-op past the cap", () => {
    const { next } = addEntries(EMPTY_SELECTION, [e("a"), e("b"), e("c")], limits);
    expect(toggleEntry(next, e("d"), limits)).toBe(next);
    expect(canAdd(next, e("d"), limits)).toBe(false);
    expect(canAdd(next, e("a"), limits)).toBe(true); // already in — always allowed
  });
});

describe("keysByKind / selectAllState", () => {
  it("groups keys under every kind they carry", () => {
    const { next } = addEntries(EMPTY_SELECTION, [e("a", ["claimable"]), e("b", ["unclaimable", "deletable"])], limits);
    expect(keysByKind(next)).toEqual({ claimable: ["a"], unclaimable: ["b"], deletable: ["b"] });
  });

  it("reports none / some / all for a table's entries", () => {
    const entries = [e("a"), e("b")];
    expect(selectAllState(entries, EMPTY_SELECTION)).toBe("none");
    const { next: one } = addEntries(EMPTY_SELECTION, [e("a")], limits);
    expect(selectAllState(entries, one)).toBe("some");
    const { next: both } = addEntries(one, [e("b")], limits);
    expect(selectAllState(entries, both)).toBe("all");
    expect(selectAllState([], both)).toBe("none");
  });
});
