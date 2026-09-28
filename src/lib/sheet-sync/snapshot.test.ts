import { describe, expect, it } from "vitest";
import { checkSnapshot } from "./snapshot";

describe("checkSnapshot", () => {
  it("passes without history and on growth", () => {
    expect(checkSnapshot(100, undefined).suspect).toBe(false);
    expect(checkSnapshot(120, 100).suspect).toBe(false);
  });
  it("allows a shrink of exactly 5% and flags anything more", () => {
    expect(checkSnapshot(95, 100).suspect).toBe(false);
    expect(checkSnapshot(94, 100)).toEqual({ suspect: true, previous: 100, current: 94, shrinkPct: 6 });
  });
});
