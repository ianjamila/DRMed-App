import { describe, expect, it } from "vitest";
import { parseShowVoided, splitVoided } from "./ap-voided-filter";

type Row = { id: string; voided_at: string | null };
const rows: Row[] = [
  { id: "a", voided_at: null },
  { id: "b", voided_at: "2026-06-07T00:00:00Z" },
  { id: "c", voided_at: null },
  { id: "d", voided_at: "2026-06-07T00:00:00Z" },
];
const isVoided = (r: Row) => r.voided_at !== null;

describe("splitVoided", () => {
  it("hides voided rows by default and counts them", () => {
    const { visible, hiddenVoided } = splitVoided(rows, isVoided, false);
    expect(visible.map((r) => r.id)).toEqual(["a", "c"]);
    expect(hiddenVoided).toBe(2);
  });

  it("keeps every row, in order, when voided rows are shown", () => {
    const { visible, hiddenVoided } = splitVoided(rows, isVoided, true);
    expect(visible.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(hiddenVoided).toBe(0);
  });

  it("reports every row hidden when all are voided (the prod state in 2026-09)", () => {
    const allVoided = rows.filter(isVoided);
    const { visible, hiddenVoided } = splitVoided(allVoided, isVoided, false);
    expect(visible).toEqual([]);
    expect(hiddenVoided).toBe(2);
  });

  it("does not mutate the input", () => {
    const input = [...rows];
    splitVoided(input, isVoided, false);
    expect(input).toEqual(rows);
  });
});

describe("parseShowVoided", () => {
  it("is on only for the exact value 1", () => {
    expect(parseShowVoided("1")).toBe(true);
    expect(parseShowVoided(null)).toBe(false);
    expect(parseShowVoided(undefined)).toBe(false);
    expect(parseShowVoided("")).toBe(false);
    expect(parseShowVoided("true")).toBe(false);
    expect(parseShowVoided("0")).toBe(false);
  });
});
