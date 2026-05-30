import { describe, it, expect } from "vitest";
import {
  patientSearchTokens,
  patientSearchOrClauses,
  matchesAllTokens,
  PATIENT_SEARCH_FIELDS,
} from "./search";

describe("patientSearchTokens", () => {
  it("splits on whitespace and commas, dropping empties", () => {
    expect(patientSearchTokens("jamila, ian")).toEqual(["jamila", "ian"]);
    expect(patientSearchTokens("  jamila   ian ")).toEqual(["jamila", "ian"]);
    expect(patientSearchTokens("a,,b")).toEqual(["a", "b"]);
  });

  it("returns [] for blank input", () => {
    expect(patientSearchTokens("")).toEqual([]);
    expect(patientSearchTokens("   ")).toEqual([]);
    expect(patientSearchTokens(",")).toEqual([]);
  });

  it("keeps single tokens (and hyphenated DRM-IDs) intact", () => {
    expect(patientSearchTokens("jamila")).toEqual(["jamila"]);
    expect(patientSearchTokens("DRM-2024-001")).toEqual(["DRM-2024-001"]);
  });
});

describe("patientSearchOrClauses", () => {
  it("returns [] for a blank query (caller leaves it unfiltered)", () => {
    expect(patientSearchOrClauses("")).toEqual([]);
    expect(patientSearchOrClauses("   ")).toEqual([]);
  });

  it("emits one clause per token — so chaining ANDs them", () => {
    const clauses = patientSearchOrClauses("jamila, ian");
    expect(clauses).toHaveLength(2);
    expect(clauses[0]).toContain("%jamila%");
    expect(clauses[1]).toContain("%ian%");
  });

  it("matches every configured field within a clause", () => {
    const [clause] = patientSearchOrClauses("jamila");
    for (const field of PATIENT_SEARCH_FIELDS) {
      expect(clause).toContain(`${field}.ilike.%jamila%`);
    }
  });

  it("escapes ILIKE wildcards so they can't act as wildcards", () => {
    expect(patientSearchOrClauses("50%")[0]).toContain("%50\\%%");
    expect(patientSearchOrClauses("a_b")[0]).toContain("%a\\_b%");
    expect(patientSearchOrClauses("c\\d")[0]).toContain("%c\\\\d%");
  });

  it("honours a custom field list", () => {
    const [clause] = patientSearchOrClauses("ian", ["first_name", "last_name"]);
    expect(clause).toBe("first_name.ilike.%ian%,last_name.ilike.%ian%");
  });
});

describe("matchesAllTokens", () => {
  it("matches when every token appears, in any order", () => {
    expect(matchesAllTokens("Ian Jamila", "jamila, ian")).toBe(true);
    expect(matchesAllTokens("Ian Jamila", "ian jamila")).toBe(true);
    expect(matchesAllTokens("Ian Jamila", "jamila")).toBe(true);
  });

  it("fails when any token is missing", () => {
    expect(matchesAllTokens("Ian Jamila", "jamila ricardo")).toBe(false);
  });

  it("is case-insensitive and matches a blank query vacuously", () => {
    expect(matchesAllTokens("IAN jamila", "Jamila IAN")).toBe(true);
    expect(matchesAllTokens("anything", "")).toBe(true);
  });
});
