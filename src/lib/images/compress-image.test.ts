import { describe, it, expect } from "vitest";
import { fitWithin } from "./compress-image";

describe("fitWithin", () => {
  it("leaves small images untouched", () => {
    expect(fitWithin(1200, 900, 2200)).toEqual({ width: 1200, height: 900 });
  });
  it("scales a landscape image to the max long edge", () => {
    expect(fitWithin(4400, 2200, 2200)).toEqual({ width: 2200, height: 1100 });
  });
  it("scales a portrait image to the max long edge", () => {
    expect(fitWithin(3000, 6000, 2200)).toEqual({ width: 1100, height: 2200 });
  });
});
