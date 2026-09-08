import { describe, expect, it } from "vitest";
import { csvManilaStamp, pluckOne } from "./format";

describe("csvManilaStamp", () => {
  it("renders a UTC instant as a Manila `YYYY-MM-DD HH:mm`", () => {
    // 2026-09-08T23:30Z is 07:30 the next morning in Manila (+08:00).
    expect(csvManilaStamp("2026-09-08T23:30:00.000Z")).toBe("2026-09-09 07:30");
  });

  it("uses a 24-hour clock without a '24' midnight", () => {
    expect(csvManilaStamp("2026-09-08T16:00:00.000Z")).toBe("2026-09-09 00:00");
  });

  it("is blank for null, undefined or garbage", () => {
    expect(csvManilaStamp(null)).toBe("");
    expect(csvManilaStamp(undefined)).toBe("");
    expect(csvManilaStamp("not a date")).toBe("");
  });
});

describe("pluckOne", () => {
  it("flattens an embed whether PostgREST returned an object or an array", () => {
    expect(pluckOne({ a: 1 })).toEqual({ a: 1 });
    expect(pluckOne([{ a: 1 }, { a: 2 }])).toEqual({ a: 1 });
    expect(pluckOne([])).toBeNull();
    expect(pluckOne(null)).toBeNull();
    expect(pluckOne(undefined)).toBeNull();
  });
});
