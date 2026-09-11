import { describe, it, expect } from "vitest";
import { visibleReceiptLines, receiptTotals } from "./receipt-totals";

const line = (overrides: Partial<{
  deleted: boolean;
  base: number;
  discount: number;
  final: number;
}> = {}) => ({
  deleted: false,
  base: 0,
  discount: 0,
  final: 0,
  ...overrides,
});

describe("visibleReceiptLines", () => {
  it("drops soft-deleted lines", () => {
    const lines = [line({ deleted: false }), line({ deleted: true })];
    expect(visibleReceiptLines(lines)).toEqual([lines[0]]);
  });

  it("keeps everything when nothing is deleted", () => {
    const lines = [line(), line()];
    expect(visibleReceiptLines(lines)).toHaveLength(2);
  });

  it("is empty when every line is deleted", () => {
    const lines = [line({ deleted: true }), line({ deleted: true })];
    expect(visibleReceiptLines(lines)).toEqual([]);
  });
});

describe("receiptTotals", () => {
  it("sums base, discount and final across lines", () => {
    const lines = [
      line({ base: 500, discount: 100, final: 400 }),
      line({ base: 300, discount: 0, final: 300 }),
    ];
    expect(receiptTotals(lines)).toEqual({
      subtotal: 800,
      totalDiscount: 100,
      total: 700,
    });
  });

  it("is all zero for an empty line list", () => {
    expect(receiptTotals([])).toEqual({
      subtotal: 0,
      totalDiscount: 0,
      total: 0,
    });
  });

  it("a soft-deleted test line never reaches the total — the caller must filter first", () => {
    // Regression guard for N8: receiptTotals only sums what it's given, so
    // the deleted line's charge must already be gone by the time it's
    // filtered through visibleReceiptLines before this call.
    const allLines = [
      line({ deleted: false, base: 500, discount: 0, final: 500 }),
      line({ deleted: true, base: 1200, discount: 0, final: 1200 }),
    ];
    const totals = receiptTotals(visibleReceiptLines(allLines));
    expect(totals.total).toBe(500);
  });
});
