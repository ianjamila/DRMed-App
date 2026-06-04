import { describe, it, expect } from "vitest";
import { normSurname, resolveSurname } from "./physician-map";

describe("normSurname", () => {
  it("uppercases, strips dots, collapses spaces", () => {
    expect(normSurname("  r. vicencio ")).toBe("RVICENCIO");
    expect(normSurname("A. VICENCIO")).toBe("AVICENCIO");
    expect(normSurname("Gayo")).toBe("GAYO");
  });
});

describe("resolveSurname", () => {
  it("maps clean surnames to a physician full_name", () => {
    expect(resolveSurname("GAYO")).toBe("Dr. Katherine Gayo");
    expect(resolveSurname("R.VICENCIO")).toBe("Dr. Robert Vicencio");
    expect(resolveSurname("A. VICENCIO")).toBe("Dr. Aurora Vicencio");
    expect(resolveSurname("N. MARIANO")).toBe("Dr. Nadia Mariano");
    expect(resolveSurname("F. DANTES")).toBe("Dr. Ferdinand Dantes");
    expect(resolveSurname("A. DANTES")).toBe("Dr. Angelle Dantes");
  });
  it("returns null for off-roster and ambiguous bare DANTES", () => {
    expect(resolveSurname("JOSON")).toBeNull();
    expect(resolveSurname("SEVILLEJA")).toBeNull();
    expect(resolveSurname("DANTES")).toBeNull(); // ambiguous → Other
    expect(resolveSurname("")).toBeNull();
  });
});
