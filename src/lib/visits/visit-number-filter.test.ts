import { describe, it, expect } from "vitest";
import { visitNumberFilter } from "./visit-number-filter";

describe("visitNumberFilter", () => {
  it("returns null for blank / nullish input so the query stays unfiltered", () => {
    for (const blank of ["", "   ", "#", null, undefined]) {
      expect(visitNumberFilter(blank)).toBeNull();
    }
  });

  it("pads a short number to the stored 4-digit form, keeping the raw typed value", () => {
    // Numbers are stored zero-padded ("0037"), but reception says "visit 37".
    expect(visitNumberFilter("37")).toEqual({ kind: "exact", values: ["0037", "37"] });
  });

  it("does not duplicate when the typed value is already padded", () => {
    expect(visitNumberFilter("0037")).toEqual({ kind: "exact", values: ["0037"] });
  });

  it("leaves numbers past 4 digits alone", () => {
    expect(visitNumberFilter("10001")).toEqual({ kind: "exact", values: ["10001"] });
  });

  it("strips a leading # and surrounding whitespace", () => {
    expect(visitNumberFilter("  #0037 ")).toEqual({ kind: "exact", values: ["0037"] });
  });

  it("falls back to a contains match for legacy non-numeric numbers", () => {
    // The clinical backfill issued numbers like "H-1234" / "H-Tab-7".
    expect(visitNumberFilter("H-1234")).toEqual({ kind: "contains", pattern: "%H-1234%" });
  });

  it("escapes ILIKE wildcards so typed % / _ can't widen the match", () => {
    expect(visitNumberFilter("H-1%_2")).toEqual({ kind: "contains", pattern: "%H-1\\%\\_2%" });
  });
});
