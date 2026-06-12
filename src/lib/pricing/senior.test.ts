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
  it("uses the curated peso amount when the service has one", () => {
    expect(
      seniorPwdDiscount({ base: 500, seniorDiscountPhp: 120, eligible: true }),
    ).toBe(120);
  });

  it("falls back to the statutory 20% when no peso amount is set", () => {
    expect(
      seniorPwdDiscount({ base: 500, seniorDiscountPhp: null, eligible: true }),
    ).toBe(100);
  });

  it("rounds the 20% fallback to two decimals", () => {
    // 333 * 0.2 = 66.6 → already 2dp; use a value that needs rounding.
    expect(
      seniorPwdDiscount({ base: 333.33, seniorDiscountPhp: null, eligible: true }),
    ).toBe(66.67);
  });

  it("caps the discount at the base price", () => {
    expect(
      seniorPwdDiscount({ base: 80, seniorDiscountPhp: 200, eligible: true }),
    ).toBe(80);
  });

  it("returns 0 for an ineligible service even with a peso amount", () => {
    expect(
      seniorPwdDiscount({ base: 500, seniorDiscountPhp: 120, eligible: false }),
    ).toBe(0);
  });

  it("never returns a negative discount", () => {
    expect(
      seniorPwdDiscount({ base: 100, seniorDiscountPhp: -50, eligible: true }),
    ).toBe(0);
  });
});

describe("seniorPwdPrice", () => {
  it("returns base minus the curated discount when eligible", () => {
    expect(
      seniorPwdPrice({ base: 500, seniorDiscountPhp: 120, eligible: true }),
    ).toBe(380);
  });

  it("returns the 20%-off price when eligible without a peso amount", () => {
    expect(
      seniorPwdPrice({ base: 500, seniorDiscountPhp: null, eligible: true }),
    ).toBe(400);
  });

  it("returns null when ineligible so callers can show 'Not applicable'", () => {
    expect(
      seniorPwdPrice({ base: 500, seniorDiscountPhp: 120, eligible: false }),
    ).toBeNull();
  });

  it("never returns a negative price", () => {
    expect(
      seniorPwdPrice({ base: 80, seniorDiscountPhp: 200, eligible: true }),
    ).toBe(0);
  });
});

describe("SENIOR_PWD_RATE", () => {
  it("is the statutory 20%", () => {
    expect(SENIOR_PWD_RATE).toBe(0.2);
  });
});
