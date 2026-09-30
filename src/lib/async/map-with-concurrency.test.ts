import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./map-with-concurrency";

describe("mapWithConcurrency", () => {
  it("keeps input order whatever order the work finishes in", async () => {
    const out = await mapWithConcurrency([30, 5, 15, 1], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 2;
    });
    expect(out).toEqual([60, 10, 30, 2]);
  });
  it("never runs more than `limit` at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
    });
    expect(peak).toBe(4);
  });
  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async (x: number) => x)).toEqual([]);
  });
});
