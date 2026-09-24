import { describe, expect, it } from "vitest";
import {
  isTokenSuperset, linkKeyOf, looseKeyOf, nameNormOf, phone10, sha1Hex, sourceKeyOf, tokensOf,
} from "./names";

describe("name keys", () => {
  const juan = { first: "Juan", middle: "Santos", last: "Dela Cruz" };
  it("nameNorm is surname | given names, normalised", () => {
    expect(nameNormOf(juan)).toBe("dela cruz|juan santos");
    expect(nameNormOf({ first: "JUAN", middle: null, last: "de la Cruz" })).toBe("de la cruz|juan");
    expect(nameNormOf({ first: "José", middle: null, last: "O'Brien" })).toBe("obrien|jose");
  });
  it("looseKey is surname | first given token", () => {
    expect(looseKeyOf(juan)).toBe("dela cruz|juan");
    expect(looseKeyOf({ first: "Ma. Luisa", middle: null, last: "Reyes" })).toBe("reyes|ma");
  });
  it("linkKey joins nameNorm and dob with #", () => {
    expect(linkKeyOf("dela cruz|juan santos", "1990-02-03")).toBe("dela cruz|juan santos#1990-02-03");
    expect(linkKeyOf("dela cruz|juan santos", null)).toBe("dela cruz|juan santos#");
  });
  it("token superset: a patient with a middle name covers a line typed without it", () => {
    expect(isTokenSuperset(tokensOf(juan), tokensOf({ first: "Juan", middle: null, last: "Dela Cruz" }))).toBe(true);
    expect(isTokenSuperset(tokensOf({ first: "Juan", middle: null, last: "Dela Cruz" }), tokensOf(juan))).toBe(false);
  });
});

describe("phone10", () => {
  it("keeps the last 10 digits, like patients.phone_normalized (0105)", () => {
    expect(phone10("0909 553 4228")).toBe("9095534228");
    expect(phone10(9095534228)).toBe("9095534228");
    expect(phone10("+63 909 553 4228")).toBe("9095534228");
    expect(phone10("12345")).toBeNull();
    expect(phone10("")).toBeNull();
    expect(phone10(undefined)).toBeNull();
  });
});

describe("hashes", () => {
  it("sha1Hex is stable hex", () => {
    expect(sha1Hex("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });
  it("sourceKey changes when any identity part changes", () => {
    const a = sourceKeyOf("dela cruz|juan", "9095534228", "1990-02-03", "2025-01-02");
    expect(sourceKeyOf("dela cruz|juan", "9095534228", "1990-02-03", "2025-01-02")).toBe(a);
    expect(sourceKeyOf("dela cruz|juan", null, "1990-02-03", "2025-01-02")).not.toBe(a);
  });
});
