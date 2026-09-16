import { describe, expect, it } from "vitest";
import { compareListRows, numberColumn, textColumn, type SortValue } from "./compare-list-rows";

type Row = { id: string; value: SortValue };
const textColumns = { value: textColumn((r: Row) => r.value) };
const numericColumns = { value: numberColumn((r: Row) => r.value) };
const ordered = (rows: Row[], dir: "asc" | "desc", columns = textColumns) =>
  [...rows].sort((a, b) => compareListRows(a, b, { key: "value", dir }, columns));

describe("list comparator used by every payroll table", () => {
  it("treats TEXT employee numbers and external IDs as strings, including historic IDs", () => {
    const rows = ["10", "2", "#H-LAB_SERVICE-0-3", "EMP-7"].map((value) => ({ id: value, value }));
    expect(ordered(rows, "asc").map((r) => r.value)).toEqual(["#H-LAB_SERVICE-0-3", "10", "2", "EMP-7"]);
    for (const a of rows) for (const b of rows) {
      expect(Number.isFinite(compareListRows(a, b, { key: "value", dir: "asc" }, textColumns))).toBe(true);
    }
  });

  it.each(["same", 12, true, null, undefined, NaN, Infinity, -Infinity])("keeps equal-key ids ascending in either direction: %s", (value) => {
    const rows = [{ id: "z", value }, { id: "a", value }];
    for (const columns of [textColumns, numericColumns]) {
      expect(ordered(rows, "asc", columns).map((r) => r.id)).toEqual(["a", "z"]);
      expect(ordered(rows, "desc", columns).map((r) => r.id)).toEqual(["a", "z"]);
    }
  });

  it.each(["asc", "desc"] as const)("keeps nulls and invalid numeric values last: %s", (dir) => {
    const rows = [{ id: "n", value: null }, { id: "b", value: 10 }, { id: "a", value: 2 }, { id: "z", value: NaN }];
    expect(ordered(rows, dir, numericColumns).map((r) => r.id)).toEqual(dir === "asc" ? ["a", "b", "n", "z"] : ["b", "a", "n", "z"]);
  });

  it("sorts numeric DB amounts numerically, not as formatted text", () => {
    expect(ordered([{ id: "a", value: 100 }, { id: "b", value: 9 }], "asc", numericColumns).map((r) => r.id)).toEqual(["b", "a"]);
  });

  it.each(["asc", "desc"] as const)("normalizes mixed values per column for every input permutation: %s", (dir) => {
    const rows: Row[] = [{ id: "two", value: 2 }, { id: "ten", value: 10 }, { id: "fifteen", value: "15" }];
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    for (const indices of permutations) {
      const input = indices.map((i) => rows[i]);
      expect(ordered(input, dir, numericColumns).map((r) => r.id)).toEqual(
        dir === "asc" ? ["two", "ten", "fifteen"] : ["fifteen", "ten", "two"],
      );
      expect(ordered(input, dir, textColumns).map((r) => r.id)).toEqual(
        dir === "asc" ? ["ten", "fifteen", "two"] : ["two", "fifteen", "ten"],
      );
    }
  });

  it.each(["asc", "desc"] as const)("uses ids for normalized ties and puts invalid numeric values last: %s", (dir) => {
    const rows: Row[] = [
      { id: "z", value: "12" }, { id: "a", value: 12 },
      { id: "f", value: undefined }, { id: "e", value: NaN },
      { id: "d", value: "bad" }, { id: "c", value: " " },
      { id: "b", value: null }, { id: "g", value: false },
    ];
    expect(ordered(rows, dir, numericColumns).map((r) => r.id)).toEqual(["a", "z", "b", "c", "d", "e", "f", "g"]);
  });

  it("is transitive and never returns NaN across supported runtime values", () => {
    const values: SortValue[] = [2, 10, "15", "2", "", "bad", false, true, null, undefined, NaN, Infinity, -Infinity];
    const rows = values.map((value, i) => ({ id: String(i), value }));
    for (const columns of [textColumns, numericColumns]) for (const dir of ["asc", "desc"] as const) {
      const compare = (a: Row, b: Row) => compareListRows(a, b, { key: "value", dir }, columns);
      for (const a of rows) for (const b of rows) {
        expect(Number.isNaN(compare(a, b))).toBe(false);
        expect(compare(a, b) + compare(b, a)).toBe(0);
        for (const c of rows) {
          if (compare(a, b) <= 0 && compare(b, c) <= 0) expect(compare(a, c)).toBeLessThanOrEqual(0);
        }
      }
    }
  });

  it.each(["taxable_min_php", "monthly_salary_credit_min_php"])("preserves the rates secondary order for %s", (key) => {
    const rows = [
      { id: "b", date: "2026-01-01", lower: 10000 },
      { id: "z", date: "2026-01-01", lower: 0 },
      { id: "a", date: "2026-01-01", lower: 10000 },
      { id: "c", date: "2025-01-01", lower: 500 },
    ];
    type Band = (typeof rows)[number];
    const columns = {
      effective_from: textColumn((r: Band) => r.date),
      [key]: numberColumn((r: Band) => r.lower),
    };
    for (const dir of ["asc", "desc"] as const) {
      const sorted = [...rows].sort((a, b) => compareListRows<Band, string>(
        a, b, { key: "effective_from", dir }, columns, [{ key, dir: "asc" }],
      ));
      expect(sorted.map((r) => r.id)).toEqual(dir === "asc" ? ["c", "z", "a", "b"] : ["z", "a", "b", "c"]);
    }
  });
});
