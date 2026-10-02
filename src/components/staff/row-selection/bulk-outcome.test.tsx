// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BulkOutcomePanel, OUTCOME_TICK_MS, type OutcomeUndo } from "./bulk-outcome";

const MIN = 60_000;
const WINDOW = 10 * MIN;
// Deliberately not second-aligned, so the closing tick lands mid-second.
const T0 = new Date("2026-10-02T03:00:00.250Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  // FixedBottomBar measures with a ResizeObserver — not implemented in jsdom.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const undoBtn = () => screen.queryByRole("button", { name: /Undo/ });
const outcomeIntervals = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) => c[1] === OUTCOME_TICK_MS).length;

function undoProp(over: Partial<OutcomeUndo> = {}): OutcomeUndo {
  return {
    doneAt: T0,
    windowMs: WINDOW,
    pending: false,
    onUndo: vi.fn(),
    ...over,
  };
}

describe("BulkOutcomePanel clock (ticks only while an Undo is open)", () => {
  it("a panel with no Undo never sets an interval", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    render(<BulkOutcomePanel message="Done" onDismiss={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * WINDOW);
    });
    expect(outcomeIntervals(setSpy)).toBe(0);
    expect(undoBtn()).toBeNull();
  });

  it("an open Undo ticks once and the button goes exactly when the window closes", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    render(<BulkOutcomePanel message="Done" undo={undoProp()} onDismiss={() => {}} />);
    expect(outcomeIntervals(setSpy)).toBe(1);
    expect(undoBtn()).not.toBeNull();

    // Well before the close (but past several 15 s ticks): still shown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW - 1500);
    });
    expect(undoBtn()).not.toBeNull();

    // The last 15 s tick is long gone: one more ms-precise step closes it.
    const elapsed = WINDOW - 1500;
    clearSpy.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW - elapsed + 1);
    });
    expect(undoBtn()).toBeNull();
    expect(clearSpy).toHaveBeenCalled();
    // Nothing is left ticking.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an Undo whose window already closed at mount sets no interval and shows no button", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    render(<BulkOutcomePanel message="Done" undo={undoProp({ doneAt: T0 - WINDOW - 5_000 })} onDismiss={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(outcomeIntervals(setSpy)).toBe(0);
    expect(undoBtn()).toBeNull();
  });

  it("clears its interval when the Undo goes away (open -> null)", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { rerender } = render(<BulkOutcomePanel message="Done" undo={undoProp()} onDismiss={() => {}} />);
    expect(outcomeIntervals(setSpy)).toBe(1);
    const timersBefore = vi.getTimerCount(); // the interval + the close timeout
    const id = setSpy.mock.results.find((_, i) => setSpy.mock.calls[i]?.[1] === OUTCOME_TICK_MS)?.value;
    clearSpy.mockClear();
    await act(async () => {
      rerender(<BulkOutcomePanel message="Undone" undo={null} onDismiss={() => {}} />);
    });
    expect(clearSpy).toHaveBeenCalledWith(id);
    expect(undoBtn()).toBeNull();
    expect(vi.getTimerCount()).toBe(timersBefore - 2);
    expect(outcomeIntervals(setSpy)).toBe(1);
  });

  it("re-arms the closing tick if it fires early, and still hides the button once the clock passes closesAt", async () => {
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - skew);
    render(<BulkOutcomePanel message="Done" undo={undoProp()} onDismiss={() => {}} />);
    skew = 5; // Date.now() now reads 5 ms behind the timers
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW + 1); // first closing timeout fires "early"
    });
    expect(undoBtn()).not.toBeNull(); // not closed yet by the (skewed) clock
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2); // interval + re-armed timeout
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(undoBtn()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the tooltip reads 10 minutes at mount, even though the floored clock is behind doneAt", () => {
    render(<BulkOutcomePanel message="Done" undo={undoProp()} onDismiss={() => {}} />);
    expect(undoBtn()?.getAttribute("title")).toBe("Available for about 10 more minutes");
  });

  it("a new undo object with the same doneAt/windowMs keeps the same timers", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { rerender } = render(<BulkOutcomePanel message="Done" undo={undoProp()} onDismiss={() => {}} />);
    clearSpy.mockClear();
    await act(async () => {
      rerender(
        <BulkOutcomePanel message="Done" undo={undoProp({ onUndo: vi.fn(), pending: true })} onDismiss={() => {}} />,
      );
    });
    expect(outcomeIntervals(setSpy)).toBe(1);
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it("a new doneAt re-arms the clock for the new window", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const { rerender } = render(<BulkOutcomePanel message="Done" undo={undoProp()} onDismiss={() => {}} />);
    await act(async () => {
      rerender(<BulkOutcomePanel message="Done" undo={undoProp({ doneAt: T0 + 1000 })} onDismiss={() => {}} />);
    });
    expect(outcomeIntervals(setSpy)).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WINDOW + 1000 + 1);
    });
    expect(undoBtn()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
