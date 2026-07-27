import { describe, expect, it } from "vitest";
import {
  type DiscountTypeLite,
  discountOptionsFor,
  lineDiscount,
} from "./discounts";

const senior: DiscountTypeLite = {
  code: "senior_pwd_20",
  label: "Senior / PWD 20%",
  kind: "percent",
  percent: 20,
  amount_php: null,
  is_statutory: true,
};

const pct10: DiscountTypeLite = {
  code: "pct_10",
  label: "10% off",
  kind: "percent",
  percent: 10,
  amount_php: null,
  is_statutory: false,
};

const fixed50: DiscountTypeLite = {
  code: "promo_50",
  label: "₱50 off promo",
  kind: "fixed",
  percent: null,
  amount_php: 50,
  is_statutory: false,
};

const custom: DiscountTypeLite = {
  code: "custom",
  label: "Custom amount (₱)",
  kind: "custom",
  percent: null,
  amount_php: null,
  is_statutory: false,
};

describe("lineDiscount", () => {
  it("returns 0 when no discount type is selected", () => {
    expect(lineDiscount({ discountType: null, base: 500 })).toBe(0);
  });

  it("computes a percent discount rounded to two decimals", () => {
    expect(lineDiscount({ discountType: pct10, base: 333.33 })).toBe(33.33);
  });

  it("computes the statutory senior 20% for an eligible line", () => {
    expect(
      lineDiscount({ discountType: senior, base: 500, seniorPwdEligible: true }),
    ).toBe(100);
  });

  it("gives 0 senior discount to an ineligible service (e.g. lab package)", () => {
    expect(
      lineDiscount({ discountType: senior, base: 500, seniorPwdEligible: false }),
    ).toBe(0);
  });

  it("does NOT gate non-statutory discounts on senior eligibility", () => {
    expect(
      lineDiscount({ discountType: pct10, base: 500, seniorPwdEligible: false }),
    ).toBe(50);
  });

  it("applies a fixed peso discount", () => {
    expect(lineDiscount({ discountType: fixed50, base: 500 })).toBe(50);
  });

  it("caps a fixed peso discount at the base price", () => {
    expect(lineDiscount({ discountType: fixed50, base: 30 })).toBe(30);
  });

  it("parses the counter-typed custom amount", () => {
    expect(
      lineDiscount({ discountType: custom, base: 500, customRaw: "75.5" }),
    ).toBe(75.5);
  });

  it("caps the custom amount at the base price", () => {
    expect(
      lineDiscount({ discountType: custom, base: 100, customRaw: "250" }),
    ).toBe(100);
  });

  it("treats a blank / non-numeric / negative custom amount as 0", () => {
    expect(lineDiscount({ discountType: custom, base: 100, customRaw: "" })).toBe(0);
    expect(lineDiscount({ discountType: custom, base: 100, customRaw: "abc" })).toBe(0);
    expect(lineDiscount({ discountType: custom, base: 100, customRaw: "-5" })).toBe(0);
  });

  it("never returns a negative discount for a percent row", () => {
    expect(lineDiscount({ discountType: pct10, base: 0 })).toBe(0);
  });

  it("defaults senior eligibility to true when not passed", () => {
    expect(lineDiscount({ discountType: senior, base: 200 })).toBe(40);
  });
});

describe("discountOptionsFor", () => {
  const all = [senior, pct10, fixed50, custom];

  it("keeps every option for a senior-eligible line", () => {
    expect(discountOptionsFor(all, true)).toEqual(all);
  });

  it("drops statutory options for an ineligible line", () => {
    expect(discountOptionsFor(all, false)).toEqual([pct10, fixed50, custom]);
  });
});
