import { describe, expect, it } from "vitest";
import {
  ariaSortFor,
  buildListHref,
  DEFAULT_PAGE_SIZE,
  nextSort,
  pageCount,
  parsePage,
  parsePageSize,
  parseSort,
  rangeFor,
} from "./table-params";

const COLS = ["visit_date", "total_php", "patient"] as const;
const FALLBACK = { key: "visit_date", dir: "desc" } as const;

describe("parseSort", () => {
  it("accepts an allowed column", () => {
    expect(parseSort("total_php", "asc", COLS, FALLBACK)).toEqual({
      key: "total_php",
      dir: "asc",
    });
  });

  it("falls back when the column is not on the allow-list", () => {
    // This is the security case: the raw param reaches a PostgREST .order().
    expect(parseSort("password", "asc", COLS, FALLBACK)).toEqual(FALLBACK);
  });

  it("falls back on an injection-shaped param rather than passing it through", () => {
    expect(
      parseSort("visit_date,patients.drm_id", "asc", COLS, FALLBACK).key,
    ).toBe("visit_date");
    expect(parseSort("id;drop table visits", "desc", COLS, FALLBACK)).toEqual(
      FALLBACK,
    );
  });

  it("defaults direction to desc for anything that is not exactly 'asc'", () => {
    expect(parseSort("total_php", undefined, COLS, FALLBACK).dir).toBe("desc");
    expect(parseSort("total_php", "sideways", COLS, FALLBACK).dir).toBe("desc");
  });
});

describe("parsePageSize", () => {
  it("accepts each offered size", () => {
    for (const n of [5, 10, 25, 50, 100]) {
      expect(parsePageSize(String(n))).toBe(n);
    }
  });

  it("rejects a size that is not offered", () => {
    // Otherwise ?size=100000 is an unbounded read of the table.
    expect(parsePageSize("100000")).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("0")).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("-10")).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("abc")).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("parsePage", () => {
  it("defaults to 1 for junk, zero and negatives", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-4")).toBe(1);
    expect(parsePage("abc")).toBe(1);
  });

  it("floors a fractional page", () => {
    expect(parsePage("3.9")).toBe(3);
  });
});

describe("rangeFor", () => {
  it("is zero-based and inclusive, as PostgREST .range() expects", () => {
    expect(rangeFor(1, 25)).toEqual([0, 24]);
    expect(rangeFor(2, 25)).toEqual([25, 49]);
    expect(rangeFor(3, 10)).toEqual([20, 29]);
  });
});

describe("pageCount", () => {
  it("never reports zero pages, so 'Page 1 of 1' reads correctly when empty", () => {
    expect(pageCount(0, 25)).toBe(1);
  });

  it("rounds a partial last page up", () => {
    expect(pageCount(14256, 25)).toBe(571);
    expect(pageCount(50, 25)).toBe(2);
    expect(pageCount(51, 25)).toBe(3);
  });
});

describe("nextSort", () => {
  it("sorts a newly clicked column descending first", () => {
    expect(nextSort(FALLBACK, "total_php")).toEqual({
      key: "total_php",
      dir: "desc",
    });
  });

  it("flips direction on the already-active column", () => {
    expect(nextSort({ key: "visit_date", dir: "desc" }, "visit_date")).toEqual({
      key: "visit_date",
      dir: "asc",
    });
    expect(nextSort({ key: "visit_date", dir: "asc" }, "visit_date")).toEqual({
      key: "visit_date",
      dir: "desc",
    });
  });
});

describe("ariaSortFor", () => {
  it("reports none for inactive columns and the direction for the active one", () => {
    expect(ariaSortFor(FALLBACK, "total_php")).toBe("none");
    expect(ariaSortFor({ key: "a", dir: "asc" }, "a")).toBe("ascending");
    expect(ariaSortFor({ key: "a", dir: "desc" }, "a")).toBe("descending");
  });
});

describe("buildListHref", () => {
  it("drops empty params so page 1 is the bare path", () => {
    expect(buildListHref("/staff/patients", { q: "", page: "", size: "" })).toBe(
      "/staff/patients",
    );
  });

  it("keeps set params and applies overrides", () => {
    expect(
      buildListHref("/staff/patients", { q: "dela", page: "3" }, { page: "4" }),
    ).toBe("/staff/patients?q=dela&page=4");
  });

  it("removes a param when the override is null", () => {
    expect(
      buildListHref("/staff/patients", { q: "dela", page: "3" }, { page: null }),
    ).toBe("/staff/patients?q=dela");
  });

  it("url-encodes a search term", () => {
    expect(buildListHref("/staff/patients", { q: "dela cruz & co" })).toBe(
      "/staff/patients?q=dela+cruz+%26+co",
    );
  });
});
