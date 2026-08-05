import { describe, it, expect } from "vitest";
import {
  CASH_DENOMINATIONS,
  DENOMINATION_KEYS,
  BILL_DENOMINATIONS,
  COIN_DENOMINATIONS,
  denominationsTotal,
  mergeDenominations,
  parseDenominations,
  formatDenominationSummary,
  type DenominationCounts,
} from "./cash-denominations";

describe("CASH_DENOMINATIONS", () => {
  it("carries the 11 client-locked slugs, bills descending then coins descending", () => {
    expect(CASH_DENOMINATIONS.map((d) => d.key)).toEqual([
      "bill_1000",
      "bill_500",
      "bill_200",
      "bill_100",
      "bill_50",
      "bill_20",
      "coin_20",
      "coin_10",
      "coin_5",
      "coin_1",
      "coin_0.25",
    ]);
    expect(DENOMINATION_KEYS).toHaveLength(11);
  });

  it("keeps the ₱20 bill and the ₱20 coin as separate rows (separate physical piles)", () => {
    const twenties = CASH_DENOMINATIONS.filter((d) => d.value_php === 20);
    expect(twenties.map((d) => d.form)).toEqual(["bill", "coin"]);
    // Same short label, distinct full labels — the summary string must not be ambiguous.
    expect(twenties.map((d) => d.label)).toEqual(["₱20", "₱20"]);
    expect(new Set(twenties.map((d) => d.full_label)).size).toBe(2);
  });

  it("splits into bills and coins covering every row exactly once", () => {
    expect(BILL_DENOMINATIONS).toHaveLength(6);
    expect(COIN_DENOMINATIONS).toHaveLength(5);
    expect(BILL_DENOMINATIONS.length + COIN_DENOMINATIONS.length).toBe(CASH_DENOMINATIONS.length);
  });
});

describe("denominationsTotal", () => {
  it("sums a mixed till", () => {
    expect(
      denominationsTotal({ bill_1000: 3, bill_500: 2, bill_100: 7, coin_20: 4, coin_1: 10 }),
    ).toBe(4790);
  });

  it("treats omitted and zero keys alike", () => {
    expect(denominationsTotal({})).toBe(0);
    expect(denominationsTotal({ bill_100: 0, coin_5: 0 })).toBe(0);
    expect(denominationsTotal({ bill_50: 2 })).toBe(denominationsTotal({ bill_50: 2, coin_10: 0 }));
  });

  it("counts 25-centavo coins exactly (the float-drift case)", () => {
    // 3 × 0.25 is 0.7500000000000001 in naive float arithmetic.
    expect(denominationsTotal({ "coin_0.25": 3 })).toBe(0.75);
    // A realistic coin jar: 0.25 × 41 = 10.25, and adding a peso must stay exact.
    expect(denominationsTotal({ "coin_0.25": 41, coin_1: 1 })).toBe(11.25);
    // Large pile — naive summation drifts well before this.
    expect(denominationsTotal({ "coin_0.25": 1000 })).toBe(250);
  });

  it("adds the two ₱20 piles independently", () => {
    expect(denominationsTotal({ bill_20: 3, coin_20: 2 })).toBe(100);
  });
});

describe("mergeDenominations", () => {
  it("sums key-wise across shifts", () => {
    const a: DenominationCounts = { bill_1000: 2, coin_20: 1 };
    const b: DenominationCounts = { bill_1000: 1, bill_50: 4 };
    expect(mergeDenominations(a, b)).toEqual({ bill_1000: 3, bill_50: 4, coin_20: 1 });
  });

  it("keeps the total consistent with merging", () => {
    const a: DenominationCounts = { bill_500: 1, "coin_0.25": 2 };
    const b: DenominationCounts = { bill_500: 2, "coin_0.25": 2 };
    expect(denominationsTotal(mergeDenominations(a, b)!)).toBe(
      denominationsTotal(a) + denominationsTotal(b),
    );
  });

  it("passes through when one side is null and stays null when both are", () => {
    expect(mergeDenominations(null, { bill_100: 1 })).toEqual({ bill_100: 1 });
    expect(mergeDenominations({ bill_100: 1 }, null)).toEqual({ bill_100: 1 });
    expect(mergeDenominations(null, null)).toBeNull();
  });

  it("does not mutate its inputs", () => {
    const a: DenominationCounts = { bill_100: 1 };
    const b: DenominationCounts = { bill_100: 2 };
    mergeDenominations(a, b);
    expect(a).toEqual({ bill_100: 1 });
    expect(b).toEqual({ bill_100: 2 });
  });
});

describe("parseDenominations", () => {
  it("accepts a well-formed count and drops zero entries", () => {
    expect(parseDenominations({ bill_1000: 2, bill_500: 0 })).toEqual({ bill_1000: 2 });
  });

  it("returns null for NULL / undefined (historical closes)", () => {
    expect(parseDenominations(null)).toBeNull();
    expect(parseDenominations(undefined)).toBeNull();
  });

  it("rejects unknown keys, negatives, non-integers and non-objects", () => {
    expect(parseDenominations({ bill_1000: 1, bill_5000: 1 })).toBeNull();
    expect(parseDenominations({ "coin_0.05": 4 })).toBeNull();
    expect(parseDenominations({ bill_100: -1 })).toBeNull();
    expect(parseDenominations({ bill_100: 1.5 })).toBeNull();
    expect(parseDenominations({ bill_100: "3" })).toBeNull();
    expect(parseDenominations([])).toBeNull();
    expect(parseDenominations("{}")).toBeNull();
    expect(parseDenominations(7)).toBeNull();
  });

  it("accepts an empty object as an all-zero count", () => {
    expect(parseDenominations({})).toEqual({});
  });
});

describe("formatDenominationSummary", () => {
  it("lists non-zero piles in table order with unambiguous labels", () => {
    expect(
      formatDenominationSummary({ bill_1000: 3, bill_20: 1, coin_20: 4, "coin_0.25": 8 }),
    ).toBe("₱1,000 bills ×3 · ₱20 bills ×1 · ₱20 coins ×4 · 25¢ coins ×8");
  });

  it("skips zero counts and renders an empty string for nothing to show", () => {
    expect(formatDenominationSummary({ bill_100: 2, bill_50: 0 })).toBe("₱100 bills ×2");
    expect(formatDenominationSummary({})).toBe("");
    expect(formatDenominationSummary(null)).toBe("");
  });
});
