// @vitest-environment jsdom
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { ReleaseOutcomeProvider } from "@/components/staff/release/release-outcome";
import { REPORT_REFUSAL } from "@/lib/queue/report-release-scope";
import { BulkActionBar } from "./bulk-action-bar";
import { SelectionProvider, useRowSelection } from "./selection-context";
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
        readyIds={[TR_1, TR_2]}
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
      alsoReleasedCount: 0,
      skipped: [],
      warnings: [],
      batchId: "batch-1",
      notifiedCount: 2,
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

  it("says the patient's message will retry automatically (and does not claim they were notified)", async () => {
    const user = userEvent.setup();
    vi.mocked(releaseSelectedAction).mockResolvedValue({
      ok: true,
      count: 1,
      alsoReleasedCount: 0,
      skipped: [],
      warnings: [],
      batchId: "batch-r",
      notifiedCount: 0,
      noticeRetrying: true,
    });
    render(<Harness />);

    await user.click(screen.getByRole("checkbox", { name: "Select CBC" }));
    await user.click(screen.getByRole("button", { name: /Release selected/ }));

    expect(await screen.findByText(/has not gone out yet — it will retry automatically/)).toBeTruthy();
    expect(screen.queryByText(/already notified that results are ready/)).toBeNull();
  });

  it("shows the restored message and hides Undo once the undo succeeds", async () => {
    const user = userEvent.setup();
    vi.mocked(releaseSelectedAction).mockResolvedValue({
      ok: true,
      count: 1,
      alsoReleasedCount: 0,
      skipped: [],
      warnings: [],
      batchId: "batch-2",
      notifiedCount: 1,
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
    vi.mocked(releaseSelectedAction).mockResolvedValue({
      ok: true,
      count: 1,
      alsoReleasedCount: 0,
      skipped: [],
      warnings: [],
    });
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
      alsoReleasedCount: 0,
      skipped: [],
      warnings: [],
      batchId: "batch-3",
      notifiedCount: 1,
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

  it("does not claim the patient was notified when no notice went out (physical hand-off, withheld report)", async () => {
    const user = userEvent.setup();
    vi.mocked(releaseSelectedAction).mockResolvedValue({
      ok: true,
      count: 1,
      alsoReleasedCount: 0,
      skipped: [],
      warnings: [],
      batchId: "batch-4",
      notifiedCount: 0,
    });
    render(<Harness />);

    await user.click(screen.getByRole("checkbox", { name: "Select CBC" }));
    await user.click(screen.getByRole("button", { name: /Release selected/ }));

    expect(await screen.findByText(/Released 1 test\./)).toBeTruthy();
    expect(screen.queryByText(/already notified/)).toBeNull();
    expect(screen.getByRole("button", { name: "↶ Undo" })).toBeTruthy();

    // …and the Undo that follows does not claim it either.
    vi.mocked(undoReleaseBatchAction).mockResolvedValue({
      ok: true,
      restoredIds: [TR_1],
      notRestored: [],
    });
    await user.click(screen.getByRole("button", { name: "↶ Undo" }));
    expect(await screen.findByText(/Undone — 1 test is back to Ready for release\./)).toBeTruthy();
    expect(screen.queryByText(/already notified/)).toBeNull();
  });
});

// #261: the whole-report preview and outcome text. A successful release
// reports in the bar's own outcome panel (beside its Undo); a release that
// released nothing reports through the page-level ReleaseOutcomeProvider.
const scope = { memberIds: ["a", "b", "c"], label: "chemistry" };

function Select({ ids }: { ids: string[] }) {
  const { toggle } = useRowSelection();
  useEffect(() => {
    for (const id of ids) toggle(id, "release");
  }, [ids, toggle]);
  return null;
}

function bar(ids: string[], readyIds: string[]) {
  return (
    <ReleaseOutcomeProvider>
      <SelectionProvider>
        <Select ids={ids} />
        <BulkActionBar
          visitId="v1"
          moneySettled
          preferredMedium="email"
          consentOnFile
          gateRequired={false}
          viewedCountById={{}}
          reportScopeByTrId={{ a: scope, b: scope, c: scope }}
          readyIds={readyIds}
        />
      </SelectionProvider>
    </ReleaseOutcomeProvider>
  );
}

describe("BulkActionBar release (#261 whole reports)", () => {
  beforeEach(() => {
    vi.mocked(releaseSelectedAction).mockResolvedValue({
      ok: true,
      count: 1,
      alsoReleasedCount: 2,
      skipped: [],
      warnings: [],
    });
  });

  it("previews the other ready members of a selected combined report", () => {
    render(bar(["a", "x"], ["a", "b", "c", "x"]));
    expect(
      screen.getByText("Releasing these also releases 2 other tests on the same combined report."),
    ).toBeTruthy();
  });

  it("shows no preview when the selection already covers the report or there is none", () => {
    render(bar(["a", "b", "c"], ["a", "b", "c"]));
    expect(screen.queryByText(/also releases/)).toBeNull();
  });

  it("reports the count, the pulled-in tests and each skipped reason in the outcome panel", async () => {
    vi.mocked(releaseSelectedAction).mockResolvedValue({
      ok: true,
      count: 1,
      alsoReleasedCount: 2,
      skipped: [{ id: "x", reason: REPORT_REFUSAL.notFinished(1) }],
      warnings: [],
      batchId: "batch-5",
      notifiedCount: 3,
    });
    render(bar(["a", "x"], ["a", "b", "c", "x"]));
    fireEvent.click(screen.getByRole("button", { name: /Release selected/ }));
    await waitFor(() => expect(vi.mocked(releaseSelectedAction)).toHaveBeenCalledTimes(1));
    const notice = await screen.findByText(/Also released 2 other tests/);
    expect(notice.textContent).toContain("Released 1 test.");
    expect(notice.textContent).toContain(REPORT_REFUSAL.notFinished(1));
    expect(screen.getByRole("button", { name: "↶ Undo" })).toBeTruthy();
    expect(alert).not.toHaveBeenCalled();
  });

  it("shows a release that released nothing through the page-level notice, keeping the selection", async () => {
    vi.mocked(releaseSelectedAction).mockResolvedValue({ ok: false, error: REPORT_REFUSAL.notFinished(2) });
    render(bar(["a"], ["a", "b", "c"]));
    // The notice used to commit outside the transition, so for one frame the
    // refusal sat beside a button still reading "Releasing…" — under
    // full-suite load the button query below could land in that gap (flake).
    const screens: string[] = [];
    const observer = new MutationObserver(() => {
      const text = document.body.textContent ?? "";
      if (!text.includes(REPORT_REFUSAL.notFinished(2))) return;
      screens.push(text.includes("Releasing…") ? "refusal / Releasing…" : "refusal / idle");
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    fireEvent.click(screen.getByRole("button", { name: /Release selected/ }));
    expect(await screen.findByText(REPORT_REFUSAL.notFinished(2))).toBeTruthy();
    observer.disconnect();
    expect(screens).not.toContain("refusal / Releasing…");
    expect(screen.getByRole("button", { name: /Release selected \(1\)/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
    expect(alert).not.toHaveBeenCalled();
  });
});
