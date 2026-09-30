import { describe, expect, it } from "vitest";
import { withoutDatedCallbacks } from "./callback-dedupe";

const g = (key: string) => ({ key });

describe("withoutDatedCallbacks", () => {
  it("drops a pending callback that a dated section also loaded", () => {
    const out = withoutDatedCallbacks([g("a"), g("b"), g("c")], [[g("b")], [g("c"), g("x")]]);
    expect(out.pending.map((x) => x.key)).toEqual(["a"]);
    expect(out.moved.map((x) => x.key)).toEqual(["b", "c"]);
  });
  it("keeps everything when no dated section has it", () => {
    const out = withoutDatedCallbacks([g("a")], [[], []]);
    expect(out.pending.map((x) => x.key)).toEqual(["a"]);
    expect(out.moved).toEqual([]);
  });
});
