import { describe, expect, it, vi } from "vitest";
import {
  chunk,
  fetchAllRows,
  fetchCompleteRows,
  fetchCompleteRowsByIds,
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

describe("complete sets for totals and selections", () => {
  it("walks every page without imposing the report export ceiling", async () => {
    const { fetchPage } = fakeSource(REPORT_EXPORT_MAX_ROWS + 17);
    const result = await fetchCompleteRows(fetchPage);
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(REPORT_EXPORT_MAX_ROWS + 17);
  });

  it("discards earlier pages and preserves a later PostgREST error", async () => {
    const error = { message: "page failed", code: "42501" };
    const result = await fetchCompleteRows(async (from) => from === 0
      ? { data: Array.from({ length: 1000 }, (_, id) => ({ id })), error: null }
      : { data: null, error });
    expect(result).toEqual({ data: null, error });
  });

  it("pages child fan-out inside each bounded IN chunk and deduplicates input IDs", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => String(i));
    const calls: [number, number][] = [];
    const result = await fetchCompleteRowsByIds([...ids, ids[0]], async (part, from, to) => {
      calls.push([part.length, from]);
      const children = part.flatMap((id) => Array.from({ length: 6 }, (_, i) => ({ id: `${id}-${i}` })));
      return { data: children.slice(from, to + 1), error: null };
    });
    expect(result.data).toHaveLength(1206);
    expect(calls).toEqual([[200, 0], [200, 1000], [1, 0]]);
  });

  it("returns an empty selection without querying and propagates chunk errors", async () => {
    const fetchPage = vi.fn(async () => ({ data: null, error: { message: "denied" } }));
    expect(await fetchCompleteRowsByIds([], fetchPage)).toEqual({ data: [], error: null });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(await fetchCompleteRowsByIds(["id"], fetchPage)).toEqual({ data: null, error: { message: "denied" } });
  });
});
