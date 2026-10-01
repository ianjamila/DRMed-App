// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { OpenNowPill } from "./OpenNowPill";

// 2026-06-21 is a Sunday; Manila is UTC+8 (no DST), so 08:00 Manila = 00:00Z.
function at(day: number, h: number, m: number) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(Date.UTC(2026, 5, day, h - 8, m, 0)));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("OpenNowPill", () => {
  it("Sunday 08:00 shows open, worded as lab-only until 12nn", () => {
    at(21, 8, 0);
    const { container } = render(<OpenNowPill />);
    expect(container.textContent).toBe("Open now · Lab only until 12nn");
  });
  it("Sunday 11:59 is still lab-only open", () => {
    at(21, 11, 59);
    expect(render(<OpenNowPill />).container.textContent).toContain("Lab only until 12nn");
  });
  it("Sunday 07:59 and 12:00 are closed", () => {
    at(21, 7, 59);
    expect(render(<OpenNowPill />).container.textContent).toBe("Closed now");
    cleanup();
    at(21, 12, 0);
    expect(render(<OpenNowPill />).container.textContent).toBe("Closed now");
  });
  it("Saturday 16:59 is plain 'Open now' (full service)", () => {
    at(20, 16, 59);
    expect(render(<OpenNowPill />).container.textContent).toBe("Open now");
  });
});
