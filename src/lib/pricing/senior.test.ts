import { describe, expect, it } from "vitest";
import {
  SENIOR_PWD_RATE,
  isSeniorPwdEligible,
  seniorPwdDiscount,
  seniorPwdPrice,
} from "./senior";

describe("isSeniorPwdEligible", () => {
  it("treats an explicit true as eligible", () => {
    expect(isSeniorPwdEligible({ senior_pwd_eligible: true })).toBe(true);
  });

  it("treats an explicit false as ineligible", () => {
    expect(isSeniorPwdEligible({ senior_pwd_eligible: false })).toBe(false);
  });

  it("defaults to eligible when the flag is null", () => {
    expect(isSeniorPwdEligible({ senior_pwd_eligible: null })).toBe(true);
  });

  it("defaults to eligible when the flag is absent", () => {
    expect(isSeniorPwdEligible({})).toBe(true);
  });
});

describe("seniorPwdDiscount", () => {
  it("applies the statutory 20%", () => {
    expect(seniorPwdDiscount({ base: 500, eligible: true })).toBe(100);
  });

  it("rounds the 20% to two decimals", () => {
    expect(seniorPwdDiscount({ base: 333.33, eligible: true })).toBe(66.67);
  });

  it("returns 0 for an ineligible service", () => {
    expect(seniorPwdDiscount({ base: 500, eligible: false })).toBe(0);
  });

  it("never returns a negative discount", () => {
    expect(seniorPwdDiscount({ base: -100, eligible: true })).toBe(0);
  });
});

describe("seniorPwdPrice", () => {
  it("returns the 20%-off price when eligible", () => {
    expect(seniorPwdPrice({ base: 500, eligible: true })).toBe(400);
  });

  it("returns null when ineligible so callers can show 'Not applicable'", () => {
    expect(seniorPwdPrice({ base: 500, eligible: false })).toBeNull();
  });

  it("never returns a negative price", () => {
    expect(seniorPwdPrice({ base: 0, eligible: true })).toBe(0);
  });
});

describe("SENIOR_PWD_RATE", () => {
  it("is the statutory 20%", () => {
    expect(SENIOR_PWD_RATE).toBe(0.2);
  });
});
