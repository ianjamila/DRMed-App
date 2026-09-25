import { describe, it, expect } from "vitest";
import {
  visibleReceiptLines,
  receiptTotals,
  arrangeReceiptRows,
  toReceiptLine,
} from "./receipt-totals";

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

describe("arrangeReceiptRows", () => {
  const row = (
    id: string,
    overrides: Partial<{
      parentId: string | null;
      isPackageHeader: boolean;
      base: number;
      discount: number;
      final: number;
    }> = {},
  ) => ({
    id,
    parentId: null,
    isPackageHeader: false,
    base: 0,
    discount: 0,
    final: 0,
    ...overrides,
  });

  it("puts each package's included tests straight under it, in their fetched order", () => {
    const lines = [
      row("cbc", { parentId: "pkg" }),
      row("xray", { base: 550, final: 550 }),
      row("pkg", { isPackageHeader: true, base: 5888, final: 5888 }),
      row("fbs", { parentId: "pkg" }),
    ];
    expect(arrangeReceiptRows(lines).map((r) => r.line.id)).toEqual([
      "xray",
      "pkg",
      "cbc",
      "fbs",
    ]);
  });

  it("marks included tests, and only those, as part of a package", () => {
    const rows = arrangeReceiptRows([
      row("pkg", { isPackageHeader: true, base: 5888, final: 5888 }),
      row("cbc", { parentId: "pkg" }),
      row("xray", { base: 550, final: 550 }),
    ]);
    expect(rows.map((r) => [r.line.id, r.includedInPackage])).toEqual([
      ["pkg", false],
      ["cbc", true],
      ["xray", false],
    ]);
  });

  it("hides the ₱0 amounts on an included test but keeps them on everything else", () => {
    const rows = arrangeReceiptRows([
      row("pkg", { isPackageHeader: true, base: 5888, final: 5888 }),
      row("cbc", { parentId: "pkg" }),
      row("free", { base: 0, final: 0 }),
    ]);
    expect(rows.map((r) => [r.line.id, r.showAmounts])).toEqual([
      ["pkg", true],
      ["cbc", false],
      // A standalone ₱0 line is a real ₱0 charge (e.g. a waived test) and
      // still says so.
      ["free", true],
    ]);
  });

  it("never hides an included test's amount when it carries money, so the printed lines still add up to the total", () => {
    const rows = arrangeReceiptRows([
      row("pkg", { isPackageHeader: true, base: 5888, final: 5888 }),
      row("addon", { parentId: "pkg", base: 200, final: 200 }),
    ]);
    expect(rows.find((r) => r.line.id === "addon")?.showAmounts).toBe(true);
  });

  it("prints a test whose package line is not on this receipt as an ordinary line", () => {
    const rows = arrangeReceiptRows([
      row("orphan", { parentId: "gone" }),
      row("xray", { base: 550, final: 550 }),
    ]);
    expect(rows).toEqual([
      { line: expect.objectContaining({ id: "orphan" }), includedInPackage: false, showAmounts: true, includedCount: 0 },
      { line: expect.objectContaining({ id: "xray" }), includedInPackage: false, showAmounts: true, includedCount: 0 },
    ]);
  });

  it("counts the tests a package line includes, for its \"Includes\" caption", () => {
    const rows = arrangeReceiptRows([
      row("pkg", { isPackageHeader: true, base: 5888, final: 5888 }),
      row("cbc", { parentId: "pkg" }),
      row("fbs", { parentId: "pkg" }),
      row("empty", { isPackageHeader: true, base: 100, final: 100 }),
      row("xray", { base: 550, final: 550 }),
    ]);
    expect(rows.map((r) => [r.line.id, r.includedCount])).toEqual([
      ["pkg", 2],
      ["cbc", 0],
      ["fbs", 0],
      ["empty", 0],
      ["xray", 0],
    ]);
  });

  it("keeps two packages' tests apart and lists every line exactly once", () => {
    const lines = [
      row("a", { isPackageHeader: true, base: 1000, final: 1000 }),
      row("b", { isPackageHeader: true, base: 2000, final: 2000 }),
      row("b1", { parentId: "b" }),
      row("a1", { parentId: "a" }),
      row("a2", { parentId: "a" }),
    ];
    const ids = arrangeReceiptRows(lines).map((r) => r.line.id);
    expect(ids).toEqual(["a", "a1", "a2", "b", "b1"]);
    expect(new Set(ids).size).toBe(lines.length);
  });
});

describe("toReceiptLine package fields", () => {
  const raw = {
    id: "t1",
    deleted_at: null,
    base_price_php: 0,
    discount_amount_php: 0,
    final_price_php: 0,
    services: { price_php: 150 },
  };

  it("carries the package link through", () => {
    const mapped = toReceiptLine({ ...raw, parent_id: "pkg", is_package_header: false });
    expect(mapped.parentId).toBe("pkg");
    expect(mapped.isPackageHeader).toBe(false);
  });

  it("defaults to a standalone line when the caller did not select the package columns", () => {
    const mapped = toReceiptLine(raw);
    expect(mapped.parentId).toBeNull();
    expect(mapped.isPackageHeader).toBe(false);
  });
});
