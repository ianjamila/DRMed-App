// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({
  releaseSelectedAction: vi.fn(),
  undoReleaseSelectedAction: vi.fn(),
  undoReleaseBatchAction: vi.fn(),
}));

import {
  releaseSelectedAction,
  undoReleaseBatchAction,
} from "./actions";
import { BulkActionBar } from "./bulk-action-bar";
import { SelectionProvider } from "./selection-context";
import { RowSelectCheckbox } from "./row-select-checkbox";

// Owner decision 2026-09-28: "Release selected" gets a server-checked
// 10-minute Undo that reuses the existing Unrelease path with an automatic
// reason. Real here: SelectionProvider, RowSelectCheckbox and BulkActionBar
// — only the three server actions are mocked, so this exercises the actual
// wiring the visit page composes. Pins: the outcome panel + ↶ Undo + the
// "patient already notified" warning after a successful release, the Undo
// success message, that Undo never appears without a batchId, and that a
// retryable Undo failure keeps the button (an expired/already-undone one
// would not — see the appointments/queue bar tests for that half).

const VISIT_ID = "11111111-1111-1111-1111-111111111111";
const TR_1 = "22222222-2222-2222-2222-222222222222";
const TR_2 = "33333333-3333-3333-3333-333333333333";

function Harness() {
  return (
    <SelectionProvider>
      <RowSelectCheckbox testRequestId={TR_1} eligibility="release" label="CBC" />
      <RowSelectCheckbox testRequestId={TR_2} eligibility="release" label="Urinalysis" />
      <BulkActionBar
        visitId={VISIT_ID}
        moneySettled
        preferredMedium={null}
        consentOnFile
        gateRequired={false}
        viewedCountById={{}}
        reportScopeByTrId={{}}
      />
    </SelectionProvider>
  );
}

beforeEach(() => {
  vi.mocked(releaseSelectedAction).mockReset();
  vi.mocked(undoReleaseBatchAction).mockReset();
  // FixedBottomBar measures its own height with a ResizeObserver — not
  // implemented in jsdom.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.spyOn(window, "alert").mockImplementation(() => {});
});
afterEach(cleanup);

describe("Release selected -> outcome + Undo", () => {
  it("shows the outcome panel with Undo and the patient-notified warning after a successful release", async () => {
    const user = userEvent.setup();
    vi.mocked(releaseSelectedAction).mockResolvedValue({
      ok: true,
      count: 2,
      batchId: "batch-1",
    });
    render(<Harness />);

    await user.click(screen.getByRole("checkbox", { name: "Select CBC" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Urinalysis" }));
    await user.click(screen.getByRole("button", { name: /Release selected/ }));

    expect(await screen.findByText(/Released 2 tests\./)).toBeTruthy();
    expect(
      screen.getByText(/already notified that results are ready/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "↶ Undo" })).toBeTruthy();
  });

  it("shows the restored message and hides Undo once the undo succeeds", async () => {
    const user = userEvent.setup();
    vi.mocked(releaseSelectedAction).mockResolvedValue({
      ok: true,
      count: 1,
      batchId: "batch-2",
    });
    vi.mocked(undoReleaseBatchAction).mockResolvedValue({
      ok: true,
      restoredIds: [TR_1],
      notRestored: [],
    });
    render(<Harness />);

    await user.click(screen.getByRole("checkbox", { name: "Select CBC" }));
    await user.click(screen.getByRole("button", { name: /Release selected/ }));
    await screen.findByRole("button", { name: "↶ Undo" });

    await user.click(screen.getByRole("button", { name: "↶ Undo" }));

    expect(
      await screen.findByText(
        /Undone — 1 test is back to Ready for release\. The patient was already notified/,
      ),
    ).toBeTruthy();
    expect(vi.mocked(undoReleaseBatchAction)).toHaveBeenCalledWith({
      batchId: "batch-2",
    });
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });

  it("never shows Undo when the server result carries no batchId", async () => {
    const user = userEvent.setup();
    vi.mocked(releaseSelectedAction).mockResolvedValue({ ok: true, count: 1 });
    render(<Harness />);

    await user.click(screen.getByRole("checkbox", { name: "Select CBC" }));
    await user.click(screen.getByRole("button", { name: /Release selected/ }));

    expect(await screen.findByText(/Released 1 test\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });

  it("keeps the Undo button after a retryable failure", async () => {
    const user = userEvent.setup();
    vi.mocked(releaseSelectedAction).mockResolvedValue({
      ok: true,
      count: 1,
      batchId: "batch-3",
    });
    vi.mocked(undoReleaseBatchAction).mockResolvedValue({
      ok: false,
      error: "Could not read what that bulk change did — try again.",
    });
    render(<Harness />);

    await user.click(screen.getByRole("checkbox", { name: "Select CBC" }));
    await user.click(screen.getByRole("button", { name: /Release selected/ }));
    await screen.findByRole("button", { name: "↶ Undo" });

    await user.click(screen.getByRole("button", { name: "↶ Undo" }));

    expect(
      await screen.findByText(
        "Could not read what that bulk change did — try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "↶ Undo" })).toBeTruthy();
  });
});
