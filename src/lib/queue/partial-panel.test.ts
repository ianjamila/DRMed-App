import { describe, expect, it } from "vitest";
import { groupIdsByDeletedAt } from "./partial-panel";

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
