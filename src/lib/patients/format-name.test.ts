import { describe, expect, it } from "vitest";
import { formatPatientName } from "./format-name";

describe("formatPatientName", () => {
  it("formats Last, First Middle when all parts are present", () => {
    expect(
      formatPatientName({ first_name: "Juan", middle_name: "Santos", last_name: "Dela Cruz" }),
    ).toBe("Dela Cruz, Juan Santos");
  });

  it("omits the middle name when absent (null or blank)", () => {
    expect(formatPatientName({ first_name: "Juan", middle_name: null, last_name: "Dela Cruz" })).toBe(
      "Dela Cruz, Juan",
    );
    expect(formatPatientName({ first_name: "Juan", middle_name: "  ", last_name: "Dela Cruz" })).toBe(
      "Dela Cruz, Juan",
    );
  });

  it("trims surrounding whitespace on each part", () => {
    expect(
      formatPatientName({ first_name: " Juan ", middle_name: " Santos ", last_name: " Dela Cruz " }),
    ).toBe("Dela Cruz, Juan Santos");
  });

  it("falls back gracefully when only one name component exists", () => {
    expect(formatPatientName({ last_name: "Dela Cruz", first_name: null })).toBe("Dela Cruz");
    expect(formatPatientName({ first_name: "Juan", last_name: null })).toBe("Juan");
    expect(formatPatientName({ first_name: "Juan", middle_name: "Santos", last_name: "" })).toBe(
      "Juan Santos",
    );
  });

  it("returns an empty string when no name is on file", () => {
    expect(formatPatientName({ first_name: null, middle_name: null, last_name: null })).toBe("");
    expect(formatPatientName({ first_name: "  ", last_name: "  " })).toBe("");
  });
});
