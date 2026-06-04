import { describe, it, expect } from "vitest";
import { classifyDiscount } from "./discount-type";

describe("classifyDiscount (lab)", () => {
  it("senior/PWD wins, then 10%, then 5%", () => {
    expect(classifyDiscount({ senior: 60, d10: 0, d5: 0 }, false)).toBe("senior_pwd_20");
    expect(classifyDiscount({ senior: 0, d10: 30, d5: 0 }, false)).toBe("pct_10");
    expect(classifyDiscount({ senior: 0, d10: 0, d5: 15 }, false)).toBe("pct_5");
    expect(classifyDiscount({ senior: 0, d10: 0, d5: 0 }, false)).toBeNull();
  });
});

describe("classifyDiscount (consult)", () => {
  it("senior/PWD vs other(20%)", () => {
    expect(classifyDiscount({ senior: 100, other: 0 }, true)).toBe("senior_pwd_20");
    expect(classifyDiscount({ senior: 0, other: 100 }, true)).toBe("other_pct_20");
    expect(classifyDiscount({ senior: 0, other: 0 }, true)).toBeNull();
  });
});
