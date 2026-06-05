import { describe, it, expect } from "vitest";
import {
  channelLabel,
  enumerateDays,
  num,
  CHANNEL_ORDER,
} from "./daily-report";

describe("channelLabel", () => {
  it("maps bank_transfer to BDO (per the manual sheet)", () => {
    expect(channelLabel("bank_transfer")).toBe("BDO");
  });
  it("maps the known channels", () => {
    expect(channelLabel("cash")).toBe("Cash");
    expect(channelLabel("gcash")).toBe("GCash");
    expect(channelLabel("bpi")).toBe("BPI");
    expect(channelLabel("card")).toBe("Card pay");
    expect(channelLabel("hmo")).toBe("HMO");
    expect(channelLabel("unpaid")).toBe("Unpaid");
  });
  it("falls back to the raw value for an unknown channel", () => {
    expect(channelLabel("crypto")).toBe("crypto");
  });
  it("CHANNEL_ORDER lists the six display channels without unpaid", () => {
    expect(CHANNEL_ORDER).toEqual(["cash", "gcash", "bpi", "bank_transfer", "card", "hmo"]);
  });
});

describe("enumerateDays", () => {
  it("is inclusive of both ends", () => {
    expect(enumerateDays("2026-06-01", "2026-06-03")).toEqual([
      "2026-06-01", "2026-06-02", "2026-06-03",
    ]);
  });
  it("crosses a month boundary correctly", () => {
    expect(enumerateDays("2026-01-30", "2026-02-02")).toEqual([
      "2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02",
    ]);
  });
  it("returns a single day when from === to", () => {
    expect(enumerateDays("2026-06-06", "2026-06-06")).toEqual(["2026-06-06"]);
  });
  it("returns [] when to is before from", () => {
    expect(enumerateDays("2026-06-06", "2026-06-01")).toEqual([]);
  });
});

describe("num", () => {
  it("coerces numeric strings (Supabase numeric columns arrive as strings)", () => {
    expect(num("23985.00")).toBe(23985);
  });
  it("treats null/undefined/'' as 0", () => {
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num("")).toBe(0);
  });
  it("passes numbers through", () => {
    expect(num(1668)).toBe(1668);
  });
});
