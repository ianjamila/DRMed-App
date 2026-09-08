import { describe, expect, it, vi } from "vitest";
import {
  chunk,
  fetchAllRows,
  PAGE_SIZE,
  REPORT_EXPORT_MAX_ROWS,
  unique,
} from "./paging";

// A fake PostgREST: `.range(from, to)` over an in-memory array, capped at
// PAGE_SIZE per call exactly like the real thing.
function fakeSource(total: number) {
  const all = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: [number, number][] = [];
  const fetchPage = vi.fn(async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: all.slice(from, Math.min(to + 1, from + PAGE_SIZE)), error: null };
  });
  return { fetchPage, calls };
}

describe("fetchAllRows", () => {
  it("returns everything in one call when the set is small", async () => {
    const { fetchPage, calls } = fakeSource(7);
    const out = await fetchAllRows(fetchPage, 500);
    expect(out.rows.map((r) => r.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(out.truncated).toBe(false);
    expect(calls).toEqual([[0, 500]]);
  });

  it("walks page by page past the 1000-row cap", async () => {
    const { fetchPage, calls } = fakeSource(2500);
    const out = await fetchAllRows(fetchPage, REPORT_EXPORT_MAX_ROWS);
    expect(out.rows).toHaveLength(2500);
    expect(out.truncated).toBe(false);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("is not truncated when the set is exactly the ceiling", async () => {
    const { fetchPage } = fakeSource(300);
    const out = await fetchAllRows(fetchPage, 300);
    expect(out.rows).toHaveLength(300);
    expect(out.truncated).toBe(false);
  });

  it("flags truncation and trims to the ceiling when there is more", async () => {
    const { fetchPage } = fakeSource(301);
    const out = await fetchAllRows(fetchPage, 300);
    expect(out.rows).toHaveLength(300);
    expect(out.truncated).toBe(true);
  });

  it("with a zero ceiling still answers whether anything exists", async () => {
    const { fetchPage: some } = fakeSource(3);
    expect(await fetchAllRows(some, 0)).toEqual({ rows: [], truncated: true });
    const { fetchPage: none } = fakeSource(0);
    expect(await fetchAllRows(none, 0)).toEqual({ rows: [], truncated: false });
  });

  it("throws on a DB error rather than returning a partial set", async () => {
    const fetchPage = async () => ({ data: null, error: { message: "permission denied" } });
    await expect(fetchAllRows(fetchPage, 10)).rejects.toThrow(/permission denied/);
  });
});

describe("chunk / unique", () => {
  it("splits into fixed-size chunks with a short tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  it("refuses a non-positive chunk size instead of looping forever", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], -1)).toThrow(RangeError);
  });

  it("dedupes and drops null/undefined", () => {
    expect(unique(["a", null, "b", "a", undefined])).toEqual(["a", "b"]);
  });
});
