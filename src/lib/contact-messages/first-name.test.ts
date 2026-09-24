import { describe, expect, it } from "vitest";
import { firstNameOf } from "./first-name";

describe("firstNameOf", () => {
  it("returns the first token of a normal name", () => {
    expect(firstNameOf("Juan dela Cruz")).toBe("Juan");
  });

  it("collapses repeated internal whitespace", () => {
    expect(firstNameOf("  Maria    Santos ")).toBe("Maria");
  });

  it("returns the whole name when it is a single token", () => {
    expect(firstNameOf("Cher")).toBe("Cher");
  });

  it("falls back to a safe greeting for blank input", () => {
    expect(firstNameOf("")).toBe("there");
    expect(firstNameOf("   ")).toBe("there");
    expect(firstNameOf(null)).toBe("there");
    expect(firstNameOf(undefined)).toBe("there");
  });
});
