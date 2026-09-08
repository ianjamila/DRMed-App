import { describe, expect, it } from "vitest";
import { hasStatutoryDiscountLine, isStatutoryDiscountCode } from "./statutory";

const statutoryCodes = new Set(["senior_pwd_20"]);

describe("isStatutoryDiscountCode", () => {
  it("is true for a code in the statutory set", () => {
    expect(isStatutoryDiscountCode("senior_pwd_20", statutoryCodes)).toBe(true);
  });

  it("is false for a non-statutory code", () => {
    expect(isStatutoryDiscountCode("pct_10", statutoryCodes)).toBe(false);
  });

  it("is false for null", () => {
    expect(isStatutoryDiscountCode(null, statutoryCodes)).toBe(false);
  });

  it("is false for undefined", () => {
    expect(isStatutoryDiscountCode(undefined, statutoryCodes)).toBe(false);
  });
});

describe("hasStatutoryDiscountLine", () => {
  it("is true when a line carries a statutory code", () => {
    expect(
      hasStatutoryDiscountLine(
        [{ discountKind: "pct_10" }, { discountKind: "senior_pwd_20" }],
        statutoryCodes,
      ),
    ).toBe(true);
  });

  it("is false when no line carries a statutory code", () => {
    expect(
      hasStatutoryDiscountLine(
        [{ discountKind: "pct_10" }, { discountKind: "promo_50" }],
        statutoryCodes,
      ),
    ).toBe(false);
  });

  it("is false when lines have a null discount code", () => {
    expect(
      hasStatutoryDiscountLine([{ discountKind: null }], statutoryCodes),
    ).toBe(false);
  });

  it("is false for an empty line list", () => {
    expect(hasStatutoryDiscountLine([], statutoryCodes)).toBe(false);
  });

  it("picks up a future statutory code without changes here", () => {
    const withNewRow = new Set(["senior_pwd_20", "solo_parent_10"]);
    expect(
      hasStatutoryDiscountLine([{ discountKind: "solo_parent_10" }], withNewRow),
    ).toBe(true);
  });
});
