import { describe, it, expect } from "vitest";
import { classifyDiscount } from "./discount-type";

describe("classifyDiscount (lab)", () => {
  it("senior/PWD wins, then 10%, then 5%", () => {
    expect(classifyDiscount({ senior: true, d10: false, d5: false }, false)).toBe("senior_pwd_20");
    expect(classifyDiscount({ senior: true, d10: true, d5: true }, false)).toBe("senior_pwd_20");
    expect(classifyDiscount({ senior: false, d10: true, d5: false }, false)).toBe("pct_10");
    expect(classifyDiscount({ senior: false, d10: false, d5: true }, false)).toBe("pct_5");
    expect(classifyDiscount({ senior: false, d10: false, d5: false }, false)).toBeNull();
  });
});

describe("classifyDiscount (consult)", () => {
  it("senior/PWD vs other(20%)", () => {
    expect(classifyDiscount({ senior: true, other: false }, true)).toBe("senior_pwd_20");
    expect(classifyDiscount({ senior: false, other: true }, true)).toBe("other_pct_20");
    expect(classifyDiscount({ senior: false, other: false }, true)).toBeNull();
  });
});
