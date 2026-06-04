import { describe, it, expect } from "vitest";
import { normalizeName, parseTransactionName, matchKey } from "./names";

describe("normalizeName", () => {
  it("lowercases, strips accents, collapses spaces/punct", () => {
    expect(normalizeName("  Peñā,  José  ")).toBe("pena jose");
    expect(normalizeName("O'Brian-Smith")).toBe("obrian smith");
  });
  it("returns empty string for blank", () => {
    expect(normalizeName("   ")).toBe("");
  });
});

describe("parseTransactionName", () => {
  it("parses 'Last, First Middle'", () => {
    expect(parseTransactionName("Quinto, Lee Angelo")).toEqual({ last: "Quinto", first: "Lee Angelo" });
  });
  it("parses 'First Last' (no comma) as last token = surname", () => {
    expect(parseTransactionName("Lee Angelo Quinto")).toEqual({ last: "Quinto", first: "Lee Angelo" });
  });
  it("handles a single token", () => {
    expect(parseTransactionName("Cher")).toEqual({ last: "Cher", first: "" });
  });
  it("trims surrounding whitespace", () => {
    expect(parseTransactionName("  Gabuat, Princess ")).toEqual({ last: "Gabuat", first: "Princess" });
  });
});

describe("matchKey", () => {
  it("keys on normalized last + first given token only", () => {
    expect(matchKey("Quinto", "Lee Angelo")).toBe("quinto|lee");
    expect(matchKey("Quinto", "Lee")).toBe("quinto|lee");
  });
  it("is empty when last name is blank", () => {
    expect(matchKey("", "Lee")).toBe("");
  });
});
