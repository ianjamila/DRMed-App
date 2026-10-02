// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/staff/queue/consolidated/v1/g1",
  useSearchParams: () => searchParams,
}));
vi.mock("./actions", () => ({ undoBulkQueueAction: vi.fn() }));

import { undoBulkQueueAction } from "./actions";
import { UNDO_ALREADY, UNDO_EXPIRED } from "@/lib/ui/bulk-undo";
import { ClaimUndoNotice } from "./claim-undo-notice";

const BATCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY = "panel:v1:g1";
const MIN = 60_000;

// BulkOutcomePanel pins itself with FixedBottomBar, which measures with a
// ResizeObserver — not implemented in jsdom.
beforeEach(() => {
  vi.mocked(undoBulkQueueAction).mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
  searchParams = new URLSearchParams();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderNotice(doneAt = Date.now()) {
  return render(<ClaimUndoNotice batchId={BATCH} doneAt={doneAt} reportName="Chemistry" />);
}
const undoBtn = () => screen.queryByRole("button", { name: /Undo/ });

describe("ClaimUndoNotice", () => {
  it("says what was claimed and offers Undo while the window is open", () => {
    renderNotice();
    expect(screen.getByText("You claimed Chemistry.")).toBeTruthy();
    expect(undoBtn()).not.toBeNull();
  });

  it("a notice whose window has already closed removes ?claimed=&at= at once, keeping other params", async () => {
    searchParams = new URLSearchParams("edit=1&claimed=x&at=1");
    render(<ClaimUndoNotice batchId={BATCH} doneAt={Date.now() - 11 * MIN} reportName="Chemistry" />);
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/staff/queue/consolidated/v1/g1?edit=1", { scroll: false }),
    );
  });

  it("drops the query string when the window closes while the notice is open", async () => {
    vi.useFakeTimers();
    render(<ClaimUndoNotice batchId={BATCH} doneAt={Date.now()} reportName="Chemistry" />);
    expect(router.replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * MIN + 1);
    expect(router.replace).toHaveBeenCalledWith("/staff/queue/consolidated/v1/g1", { scroll: false });
    vi.useRealTimers();
  });

  it("Undo sends only the batch id; success says it is back in the queue, hides Undo and refreshes", async () => {
    vi.mocked(undoBulkQueueAction).mockResolvedValue({
      ok: true,
      restoredIds: [KEY],
      restoredTestCount: 3,
      notRestored: [],
    });
    renderNotice();
    await userEvent.click(undoBtn()!);
    expect(undoBulkQueueAction).toHaveBeenCalledWith({ batchId: BATCH });
    await waitFor(() =>
      expect(screen.getByText("Undone — Chemistry is back in the queue, unclaimed.")).toBeTruthy(),
    );
    expect(undoBtn()).toBeNull();
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it("a panel that moved on is reported as not undone, with Undo hidden and no refresh", async () => {
    const reason = "claimed work has moved on — a result was uploaded or someone else holds it";
    vi.mocked(undoBulkQueueAction).mockResolvedValue({
      ok: true,
      restoredIds: [],
      restoredTestCount: 0,
      notRestored: [{ id: KEY, reason }],
    });
    renderNotice();
    await userEvent.click(undoBtn()!);
    await waitFor(() => expect(screen.getByText(`Not undone — ${reason}.`)).toBeTruthy());
    expect(undoBtn()).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("an expired window shows the error and hides Undo", async () => {
    vi.mocked(undoBulkQueueAction).mockResolvedValue({ ok: false, error: UNDO_EXPIRED });
    renderNotice();
    await userEvent.click(undoBtn()!);
    await waitFor(() => expect(screen.getByText(UNDO_EXPIRED)).toBeTruthy());
    expect(undoBtn()).toBeNull();
  });

  it("an already-undone batch shows the error and hides Undo", async () => {
    vi.mocked(undoBulkQueueAction).mockResolvedValue({ ok: false, error: UNDO_ALREADY });
    renderNotice();
    await userEvent.click(undoBtn()!);
    await waitFor(() => expect(screen.getByText(UNDO_ALREADY)).toBeTruthy());
    expect(undoBtn()).toBeNull();
  });

  it("a second click while the first Undo is pending calls the action once", async () => {
    let finish!: (r: Awaited<ReturnType<typeof undoBulkQueueAction>>) => void;
    vi.mocked(undoBulkQueueAction).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderNotice();
    const button = undoBtn()!;
    await userEvent.click(button);
    await userEvent.click(button);
    expect(undoBulkQueueAction).toHaveBeenCalledTimes(1);
    finish({ ok: true, restoredIds: [KEY], restoredTestCount: 1, notRestored: [] });
    await waitFor(() => expect(undoBtn()).toBeNull());
  });

  it("uses the fallback text when nothing was restored and no reason came back", async () => {
    vi.mocked(undoBulkQueueAction).mockResolvedValue({
      ok: true,
      restoredIds: [],
      restoredTestCount: 0,
      notRestored: [],
    });
    renderNotice();
    await userEvent.click(undoBtn()!);
    await waitFor(() => expect(screen.getByText("Not undone — it changed since.")).toBeTruthy());
    expect(undoBtn()).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("any other error keeps Undo so the operator can retry", async () => {
    vi.mocked(undoBulkQueueAction).mockResolvedValue({ ok: false, error: "Could not undo — try again." });
    renderNotice();
    await userEvent.click(undoBtn()!);
    await waitFor(() => expect(screen.getByText("Could not undo — try again.")).toBeTruthy());
    expect(undoBtn()).not.toBeNull();
  });

  it("Dismiss replaces the URL with the bare path, dropping ?claimed=&at=", async () => {
    renderNotice();
    await userEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
    expect(router.replace).toHaveBeenCalledWith("/staff/queue/consolidated/v1/g1", { scroll: false });
  });
});
