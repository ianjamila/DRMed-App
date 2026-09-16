import { describe, expect, it } from "vitest";
import { fetchPayrollRows } from "./list-data";

describe("payroll list loading", () => {
  it("walks past 1000 rows so pager counts and aggregates cover the full set", async () => {
    const all = Array.from({ length: 1203 }, (_, id) => ({ id, amount: 2 }));
    const ranges: number[][] = [];
    const result = await fetchPayrollRows(async (from, to) => {
      ranges.push([from, to]);
      return { data: all.slice(from, to + 1), error: null };
    });
    expect(ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(result.data).toHaveLength(1203);
    expect(result.data?.reduce((sum, r) => sum + r.amount, 0)).toBe(2406);
  });

  it("never reports a partial total when a later chunk fails", async () => {
    const result = await fetchPayrollRows(async (from) => from === 0
      ? { data: Array.from({ length: 1000 }, (_, id) => ({ id })), error: null }
      : { data: null, error: { message: "offline" } });
    expect(result.data).toBeNull();
    expect(result.error?.message).toContain("offline");
  });
});
