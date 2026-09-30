import { describe, expect, it } from "vitest";
import { readyForReleaseHint } from "./ready-for-release";

describe("readyForReleaseHint", () => {
  it("names how many wait on payment", () => {
    expect(readyForReleaseHint(5, 3)).toBe("2 waiting on payment");
    expect(readyForReleaseHint(1, 0)).toBe("1 waiting on payment");
  });
  it("falls back to the plain hint when all are paid or none wait", () => {
    expect(readyForReleaseHint(4, 4)).toBe("All dates — finished, waiting to go to the patient");
    expect(readyForReleaseHint(0, 0)).toBe("All dates — finished, waiting to go to the patient");
  });
  it("never shows a negative count if the two reads disagree", () => {
    expect(readyForReleaseHint(2, 3)).toBe("All dates — finished, waiting to go to the patient");
  });
});
