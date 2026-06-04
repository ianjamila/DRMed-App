import { describe, it, expect } from "vitest";
import { normaliseHmoProvider, isHmoRow } from "./hmo";

describe("normaliseHmoProvider", () => {
  it("canonicalises known providers", () => {
    expect(normaliseHmoProvider("maxicare")).toBe("Maxicare");
    expect(normaliseHmoProvider("MED ASIA")).toBe("Med Asia");
    expect(normaliseHmoProvider("icare")).toBe("iCare");
  });
  it("title-cases unknowns and handles blank", () => {
    expect(normaliseHmoProvider("some new hmo")).toBe("Some New Hmo");
    expect(normaliseHmoProvider("")).toBe("(unknown HMO)");
  });
});

describe("isHmoRow", () => {
  it("is true when flag says yes, provider present, or mop is HMO", () => {
    expect(isHmoRow({ hmo_flag: "YES", hmo_provider: "", mop: "" })).toBe(true);
    expect(isHmoRow({ hmo_flag: "", hmo_provider: "Maxicare", mop: "" })).toBe(true);
    expect(isHmoRow({ hmo_flag: "", hmo_provider: "", mop: "HMO" })).toBe(true);
    expect(isHmoRow({ hmo_flag: "no", hmo_provider: "", mop: "CASH" })).toBe(false);
  });
});
