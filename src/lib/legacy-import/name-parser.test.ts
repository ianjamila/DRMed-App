import { describe, expect, it } from "vitest";
import { parseName } from "./name-parser";

describe("parseName", () => {
  it("parses Last, First Middle", () => {
    expect(parseName("Dela Cruz, Juan Santos", null, null, null)).toMatchObject({
      last_name: "Dela Cruz", first_name: "Juan", middle_name: "Santos", unparseable: false,
    });
  });
  it("a bare comma falls back to the dedicated columns", () => {
    expect(parseName(",", "Dela Cruz", "Juan", "Santos")).toMatchObject({
      last_name: "Dela Cruz", first_name: "Juan", middle_name: "Santos", unparseable: false,
    });
  });
  it("a bare comma without fallbacks stays unparseable", () => {
    expect(parseName(",", null, null, null).unparseable).toBe(true);
    expect(parseName(" , ", "", "", "").unparseable).toBe(true);
  });
  it("a blank surname before the comma never borrows the Last Name column", () => {
    expect(parseName(", Juan Santos", "Dela Cruz", "Juan", null).last_name).toBeNull();
    expect(parseName(", Juan", null, null, null).last_name).toBeNull();
  });
  it("falls back to the dedicated columns when Full Name is empty", () => {
    expect(parseName("", "Dela Cruz", "Juan", null)).toMatchObject({ last_name: "Dela Cruz", first_name: "Juan" });
  });
});
