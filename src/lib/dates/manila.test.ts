import { describe, it, expect, vi, afterEach } from "vitest";
import { manilaDayWindowUtc } from "./manila";

describe("manilaDayWindowUtc", () => {
  afterEach(() => vi.useRealTimers());

  it("maps tomorrow's Manila day to a fixed +08:00 UTC window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T09:00:00Z")); // 17:00 Manila on 06-16
    const { startIso, endIso } = manilaDayWindowUtc(1);
    // Manila 2026-06-17 00:00 = UTC 2026-06-16 16:00; +24h = 2026-06-17 16:00.
    expect(startIso).toBe("2026-06-16T16:00:00.000Z");
    expect(endIso).toBe("2026-06-17T16:00:00.000Z");
  });

  it("offset 0 is today's Manila day and the window is exactly 24h", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T09:00:00Z"));
    const { startIso, endIso } = manilaDayWindowUtc(0);
    expect(startIso).toBe("2026-06-15T16:00:00.000Z");
    expect(new Date(endIso).getTime() - new Date(startIso).getTime()).toBe(86_400_000);
  });

  it("crosses a month boundary correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T15:00:00Z")); // 23:00 Manila on 06-30
    const { startIso } = manilaDayWindowUtc(1); // tomorrow Manila = 2026-07-01
    expect(startIso).toBe("2026-06-30T16:00:00.000Z");
  });
});
