// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { RevenueTrend } from "./revenue-trend";
import type { RevenueTrendPoint } from "@/lib/visits/revenue-presets";

// The trend loads lazily and must recover from a failed load on BOTH of its
// surfaces: standalone on Monthly Trends (a Retry button — there is no
// dropdown to reopen) and inside the revenue dropdown (Retry, or close and
// reopen). A stuck "attempt started" guard once made both impossible.

const POINT: RevenueTrendPoint = {
  key: "2026-09",
  label: "Sep",
  year: 2026,
  partial: true,
  start: "2026-09-01",
  end: "2026-09-28",
  lab: 1000,
  consult: 0,
  procedure: 0,
  prior: { lab: 800, consult: 0, procedure: 0 },
};

const ok = () =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, points: [POINT] }) } as Response);
const fail = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) } as Response);

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  router.push.mockReset();
});

describe("RevenueTrend", () => {
  it("standalone: loads at once, and Retry recovers from a failed load", async () => {
    fetchMock.mockImplementationOnce(fail).mockImplementationOnce(ok);
    render(<RevenueTrend />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.click(retry);
    expect(await screen.findByRole("group", { name: /Monthly billed revenue/ })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/through Sep 28, 2026/)).toBeTruthy();
  });

  it("in the dropdown: waits for it to open, and a close + reopen retries", async () => {
    fetchMock.mockImplementationOnce(fail).mockImplementationOnce(ok);
    const { container } = render(
      <details>
        <summary>Revenue</summary>
        <RevenueTrend view="deleted" />
      </details>,
    );
    const details = container.querySelector("details")!;
    expect(fetchMock).not.toHaveBeenCalled();

    // Setting `open` makes jsdom queue the native "toggle" event, exactly as a
    // browser does on a summary click — never fire a second one by hand.
    const toggle = async (open: boolean) => {
      await act(async () => {
        details.open = open;
        await new Promise((r) => setTimeout(r, 0));
      });
    };

    await toggle(true);
    await screen.findByRole("button", { name: "Retry" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("view=deleted");

    await toggle(false);
    await toggle(true);
    expect(await screen.findByRole("group", { name: /Monthly billed revenue/ })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Once loaded, reopening does not fetch again.
    await toggle(false);
    await toggle(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a month is a link to Visit Records over that month, carrying the view", async () => {
    fetchMock.mockImplementationOnce(ok);
    render(<RevenueTrend view="deleted" />);
    const bar = await screen.findByRole("link", { name: /Sep 2026 \(to date\): ₱1,000 total, \+25%/ });
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(router.push).toHaveBeenCalledWith(
      "/staff/visits?start=2026-09-01&end=2026-09-28&view=deleted&rev=1",
    );
  });
});
