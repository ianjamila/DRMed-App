import { describe, expect, it } from "vitest";
import { ANSWER_CASES, KNOWN_UNMAPPED } from "./__fixtures__/answers";
import { mapAnswer, normalizeAnswer } from "./referral-mapper";

describe("normalizeAnswer", () => {
  it("uppercases, strips punctuation, folds typos", () => {
    expect(normalizeAnswer("DOCTOR'S REFFERAL ")).toBe("DOCTOR REFERRAL");
    expect(normalizeAnswer("Family / Friends")).toBe("FAMILY FRIENDS");
    expect(normalizeAnswer("RETURNING PX")).toBe("RETURNING PATIENT");
    expect(normalizeAnswer("WALKIN ")).toBe("WALK IN");
    expect(normalizeAnswer("   ")).toBe("");
  });
});

describe("mapAnswer over every live spelling", () => {
  it.each(ANSWER_CASES)("%j → %s", (answer, expected) => {
    expect(mapAnswer(answer, new Map()).id).toBe(expected);
  });
  it("no known spelling lands in 'other' unless it is on the deliberate list", () => {
    for (const [answer] of ANSWER_CASES) {
      const r = mapAnswer(answer, new Map());
      if (r.id === "other") expect(KNOWN_UNMAPPED.has(r.norm)).toBe(true);
    }
  });
  it("marks 'other' results as unmapped so a review item is raised", () => {
    expect(mapAnswer("CUSTOMER LIST", new Map()).unmapped).toBe(true);
    expect(mapAnswer("FACEBOOK", new Map()).unmapped).toBe(false);
    expect(mapAnswer("", new Map()).unmapped).toBe(false);
  });
  it("an admin alias wins over the rules", () => {
    const aliases = new Map([["CUSTOMER LIST", "returning_patient"]]);
    expect(mapAnswer("customer list", aliases)).toEqual({ id: "returning_patient", norm: "CUSTOMER LIST", unmapped: false });
  });
});
