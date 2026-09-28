import { describe, expect, it } from "vitest";
import { parseUpdatedFilter, updatedSinceIso } from "./updated-filter";

describe("parseUpdatedFilter", () => {
  it.each([
    ["7d", "7d"],
    ["mine", "mine"],
    ["x", null],
    [undefined, null],
    [["7d"], "7d"],
  ])("%s → %s", (i, o) => {
    expect(parseUpdatedFilter(i as never)).toBe(o);
  });
});
describe("updatedSinceIso", () => {
  it("is exactly 7×24h before now", () => {
    expect(updatedSinceIso(Date.parse("2026-09-25T00:00:00Z"))).toBe("2026-09-18T00:00:00.000Z");
  });
});
