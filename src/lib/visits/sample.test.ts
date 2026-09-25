import { describe, expect, it } from "vitest";
import { canMarkSample, parseSampleFilter } from "./sample";

describe("canMarkSample", () => {
  it("lets reception and admin mark a sample visit (owner decision 2026-09-25)", () => {
    expect(canMarkSample("reception")).toBe(true);
    expect(canMarkSample("admin")).toBe(true);
  });

  it("refuses every other staff role, although RLS would let them update the visit", () => {
    for (const role of ["medtech", "pathologist", "xray_technician", ""]) {
      expect(canMarkSample(role)).toBe(false);
    }
  });
});

describe("parseSampleFilter", () => {
  it("is on only for sample=1", () => {
    expect(parseSampleFilter("1")).toBe(true);
    expect(parseSampleFilter(["1", "0"])).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes"]) {
      expect(parseSampleFilter(v)).toBe(false);
    }
  });
});
