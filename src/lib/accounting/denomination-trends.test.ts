import { describe, it, expect } from "vitest";
import {
  attributeVariance,
  buildDenominationTrend,
  valueLabel,
  type DailyCount,
} from "./denomination-trends";

describe("valueLabel", () => {
  it("names the form, and says both when a value has two piles", () => {
    expect(valueLabel(1000)).toBe("₱1,000 bills");
    expect(valueLabel(0.25)).toBe("25¢ coins");
    // ₱20 is the one value with a bill AND a coin — it must not silently pick one.
    expect(valueLabel(20)).toBe("₱20 bills or coins");
  });
});

describe("attributeVariance", () => {
  it("attributes a clean thousand to the ₱1,000 pile", () => {
    const a = attributeVariance("2026-05-23", -1000);
    expect(a.valuePhp).toBe(1000);
    expect(a.pieces).toBe(1);
    expect(a.label).toBe("₱1,000 bills");
  });

  it("prefers the largest pile that divides exactly", () => {
    // 1500 divides by 500 and by 100 and by 20 …; the tidiest story is 3 × ₱500.
    const a = attributeVariance("2026-05-23", -1500);
    expect(a.valuePhp).toBe(500);
    expect(a.pieces).toBe(3);
  });

  it("falls through to a coin-level explanation when no bill divides it", () => {
    const a = attributeVariance("2026-05-23", 61);
    expect(a.valuePhp).toBe(1);
    expect(a.pieces).toBe(61);
    expect(a.label).toBe("₱1 coins");
  });

  it("handles the 25-centavo pile in integer centavos, not floats", () => {
    // 0.75 % 0.25 is NOT reliably 0 in floating point — this is the case the
    // whole centavo-arithmetic discipline exists for.
    const a = attributeVariance("2026-05-23", -0.75);
    expect(a.valuePhp).toBe(0.25);
    expect(a.pieces).toBe(3);
  });

  it("reports no whole-pile explanation for a centavo residue", () => {
    // Off by ₱0.10: no denomination divides it, so this is not a miscounted
    // pile at all — it points at a keyed amount, which is the useful signal.
    const a = attributeVariance("2026-05-23", -0.1);
    expect(a.valuePhp).toBeNull();
    expect(a.label).toBe("No whole-pile explanation");
  });

  it("calls a zero difference balanced rather than attributing it", () => {
    expect(attributeVariance("2026-05-23", 0).label).toBe("Balanced");
  });

  it("attributes over and short alike, keeping the sign on the variance", () => {
    expect(attributeVariance("2026-05-23", 500).valuePhp).toBe(500);
    expect(attributeVariance("2026-05-23", 500).variance).toBe(500);
    expect(attributeVariance("2026-05-23", -500).variance).toBe(-500);
  });
});

describe("buildDenominationTrend", () => {
  const rows: DailyCount[] = [
    { day: "2026-05-20", variance: 0, denominations: { bill_1000: 2, coin_1: 30 } },
    { day: "2026-05-21", variance: -1000, denominations: { bill_1000: 1, coin_1: 20 } },
    { day: "2026-05-22", variance: -1000, denominations: { bill_1000: 3 } },
    { day: "2026-05-23", variance: 500, denominations: null },
    { day: "2026-05-24", variance: -0.1, denominations: { coin_1: 10 } },
  ];
  const t = buildDenominationTrend(rows);

  it("counts closed, counted, balanced, short and over days", () => {
    expect(t.closedDays).toBe(5);
    expect(t.countedDays).toBe(4); // the 23rd predates the count sheet
    expect(t.balancedDays).toBe(1);
    expect(t.shortDays).toBe(3);
    expect(t.overDays).toBe(1);
  });

  it("nets the variance exactly, without float tails", () => {
    expect(t.netVariancePhp).toBe(-1500.1);
  });

  it("groups off days by explanation, most frequent first", () => {
    expect(t.buckets[0].valuePhp).toBe(1000);
    expect(t.buckets[0].days).toBe(2);
    expect(t.buckets[0].netPhp).toBe(-2000);
    // The unexplainable day is its own bucket, not folded into a pile.
    const none = t.buckets.find((b) => b.valuePhp === null)!;
    expect(none.days).toBe(1);
    expect(none.label).toBe("No whole-pile explanation");
  });

  it("summarises till composition over the days a pile actually appeared", () => {
    const thousands = t.composition.find((c) => c.key === "bill_1000")!;
    expect(thousands.daysPresent).toBe(3);
    expect(thousands.totalPieces).toBe(6);
    expect(thousands.avgPieces).toBe(2); // 6 / 3 days present, not / 5 days

    const pesos = t.composition.find((c) => c.key === "coin_1")!;
    expect(pesos.daysPresent).toBe(3);
    expect(pesos.avgPieces).toBe(20); // (30 + 20 + 10) / 3
  });

  it("lists every denomination in composition, even ones never counted", () => {
    expect(t.composition).toHaveLength(11);
    const never = t.composition.find((c) => c.key === "bill_200")!;
    expect(never.daysPresent).toBe(0);
    expect(never.avgPieces).toBe(0);
  });

  it("orders the off-day detail most recent first and excludes balanced days", () => {
    expect(t.offDays.map((o) => o.day)).toEqual([
      "2026-05-24",
      "2026-05-23",
      "2026-05-22",
      "2026-05-21",
    ]);
  });

  it("handles an empty range without dividing by zero", () => {
    const empty = buildDenominationTrend([]);
    expect(empty.closedDays).toBe(0);
    expect(empty.netVariancePhp).toBe(0);
    expect(empty.buckets).toEqual([]);
    expect(empty.composition.every((c) => c.avgPieces === 0)).toBe(true);
  });
});
