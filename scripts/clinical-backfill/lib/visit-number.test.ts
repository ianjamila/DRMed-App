import { describe, it, expect } from "vitest";
import { buildVisitNumber } from "./visit-number";

describe("buildVisitNumber", () => {
  it("prefixes the control number", () => {
    const used = new Set<string>();
    expect(buildVisitNumber("LAB SERVICE", "12345", 7, used)).toBe("H-12345");
  });
  it("synthesizes when control_no is blank", () => {
    const used = new Set<string>();
    expect(buildVisitNumber("DOCTOR CONSULTATION", "", 42, used)).toBe("H-DOCTOR CONSULTATION-42".replace(/\s+/g, "_"));
  });
  it("suffixes on collision and records each issued number", () => {
    const used = new Set<string>(["H-12345"]);
    expect(buildVisitNumber("LAB SERVICE", "12345", 7, used)).toBe("H-12345-2");
    expect(used.has("H-12345-2")).toBe(true);
    // next collision bumps again
    expect(buildVisitNumber("LAB SERVICE", "12345", 8, used)).toBe("H-12345-3");
  });
});
