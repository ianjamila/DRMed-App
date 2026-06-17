import { describe, it, expect } from "vitest";
import { nameSimilarity } from "./duplicates";

describe("nameSimilarity", () => {
  it("is 1 for identical normalized names", () => {
    expect(nameSimilarity("John Cruz", "  john   cruz ")).toBe(1);
  });
  it("is high for a one-letter typo", () => {
    expect(nameSimilarity("Jonathan Cruz", "Jonathon Cruz")).toBeGreaterThan(0.85);
  });
  it("is low for unrelated names", () => {
    expect(nameSimilarity("Maria Santos", "John Cruz")).toBeLessThan(0.4);
  });
  it("is 0 when either side is empty", () => {
    expect(nameSimilarity("", "John")).toBe(0);
  });
});
