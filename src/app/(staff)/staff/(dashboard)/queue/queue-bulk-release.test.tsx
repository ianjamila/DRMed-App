// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ releaseTestsAction: vi.fn(), undoBulkQueueAction: vi.fn() }));
// The bar also imports the visit page sample-delete action (server-only chain).
vi.mock("../visits/[id]/actions", () => ({
  deleteSampleVisitsFromQueueAction: vi.fn(),
  undoReleaseBatchAction: vi.fn(),
}));
vi.mock("./panel-actions", () => ({
  claimQueueSelectionAction: vi.fn(),
  unclaimQueueSelectionAction: vi.fn(),
  deleteQueueSelectionAction: vi.fn(),
}));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({}));

import { releaseTestsAction, undoBulkQueueAction } from "./actions";
import { undoReleaseBatchAction } from "../visits/[id]/actions";
import { QueueBulkBar } from "./queue-bulk-bar";
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import { QUEUE_KIND, panelRowKey, type QueueRowInfo } from "@/lib/queue/bulk-queue";

// Task 13: Release from the queue list's Pending release tab. Checkboxes,
// SelectionProvider and QueueBulkBar are real; only the server actions and
// next/navigation are mocked. A chemistry panel row carries its ready members
// in memberIds, and the bar sends ONE de-duplicated call for the lot.

const PANEL = panelRowKey("v2", "g1");
const rowsByKey: Record<string, QueueRowInfo> = {
  t1: { visitId: "v1", label: "CBC — Santos, Maria", assignedTo: null },
  [PANEL]: {
    visitId: "v2",
    label: "Chemistry (2 tests) — Reyes, Ana",
    assignedTo: null,
    testCount: 2,
    memberIds: ["c1", "c2"],
  },
};

function Harness() {
  return (
    <SelectionProvider resetKey="k">
      <RowSelectCheckbox rowKey="t1" kinds={[QUEUE_KIND.release]} label="CBC" />
      <RowSelectCheckbox rowKey={PANEL} kinds={[QUEUE_KIND.release]} weight={2} label="Chemistry" />
      <QueueBulkBar rowsByKey={rowsByKey} />
    </SelectionProvider>
  );
}

beforeEach(() => {
  vi.mocked(releaseTestsAction).mockReset();
  vi.mocked(undoReleaseBatchAction).mockReset();
  vi.mocked(undoBulkQueueAction).mockReset();
  router.refresh.mockReset();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

async function selectBoth() {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByLabelText("Select CBC"));
  await user.click(screen.getByLabelText("Select Chemistry"));
  return user;
}

describe("QueueBulkBar release", () => {
  it("sends one call with the flattened, de-duplicated ids and the chosen medium", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1", "c1", "c2"],
      skipped: [],
      alsoReleasedIds: [],
      warnings: [],
      notifiedCount: 0,
    });
    const user = await selectBoth();
    await user.click(screen.getByRole("button", { name: "Release 3 tests" }));
    await waitFor(() => expect(releaseTestsAction).toHaveBeenCalledTimes(1));
    expect(releaseTestsAction).toHaveBeenCalledWith({
      testRequestIds: ["t1", "c1", "c2"],
      medium: "physical",
    });
    expect((await screen.findByRole("status")).textContent).toContain("Released 3 tests.");
    expect(router.refresh).toHaveBeenCalled();
    // No batch id came back, so there is nothing to undo.
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });

  it("uses the medium picked in the bar", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1", "c1", "c2"],
      skipped: [],
      alsoReleasedIds: [],
      warnings: [],
      notifiedCount: 0,
    });
    const user = await selectBoth();
    await user.selectOptions(screen.getByLabelText("Release medium"), "email");
    await user.click(screen.getByRole("button", { name: "Release 3 tests" }));
    await waitFor(() =>
      expect(releaseTestsAction).toHaveBeenCalledWith({
        testRequestIds: ["t1", "c1", "c2"],
        medium: "email",
      }),
    );
  });

  it("names a skipped panel member by its card and appends warnings", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1"],
      skipped: [{ id: "c2", reason: "Part of this combined report isn't finished — 1 test is still awaiting a result or sign-off." }],
      alsoReleasedIds: [],
      warnings: ["Ana Reyes has no consent on file."],
      notifiedCount: 0,
    });
    const user = await selectBoth();
    await user.click(screen.getByRole("button", { name: "Release 3 tests" }));
    const text = (await screen.findByRole("status")).textContent ?? "";
    expect(text).toContain("Released 1 of 3 tests.");
    expect(text).toContain("Chemistry (2 tests) — Reyes, Ana: Part of this combined report isn't finished");
    expect(text).toContain("Ana Reyes has no consent on file.");
  });

  it("alerts the error and keeps the selection when nothing was attempted", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({ ok: false, error: "Not allowed to release." });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const user = await selectBoth();
    await user.click(screen.getByRole("button", { name: "Release 3 tests" }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Not allowed to release."));
    expect((screen.getByLabelText("Select CBC") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Select Chemistry") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Release 3 tests" })).toBeTruthy();
    alertSpy.mockRestore();
  });

  it("shows no Release button when no selected row is releasable", async () => {
    const user = userEvent.setup();
    render(
      <SelectionProvider resetKey="k">
        <RowSelectCheckbox rowKey="t1" kinds={[QUEUE_KIND.claim]} label="CBC" />
        <QueueBulkBar rowsByKey={rowsByKey} />
      </SelectionProvider>,
    );
    await user.click(screen.getByLabelText("Select CBC"));
    expect(screen.queryByRole("button", { name: /^Release/ })).toBeNull();
  });
});

describe("QueueBulkBar release Undo", () => {
  const OK = {
    ok: true as const,
    changedIds: ["t1"],
    alsoReleasedIds: [],
    skipped: [],
    warnings: [],
    notifiedCount: 0,
  };

  async function releaseCbc() {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByLabelText("Select CBC"));
    await user.click(screen.getByRole("button", { name: /^Release 1/ }));
    return user;
  }

  it("offers ↶ Undo after a release that carries a batch id", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, batchId: "b-1" });
    await releaseCbc();
    expect(await screen.findByRole("button", { name: "↶ Undo" })).toBeTruthy();
  });

  it("no batch id, no Undo", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK });
    await releaseCbc();
    await screen.findByText(/Released 1/);
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });

  it("says the patient was notified only when a notice went out, and again after Undo", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, batchId: "b-1", notifiedCount: 1 });
    vi.mocked(undoReleaseBatchAction).mockResolvedValue({ ok: true, restoredIds: ["t1"], notRestored: [] });
    const user = await releaseCbc();
    expect(await screen.findByText(/already notified/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "↶ Undo" }));
    expect(vi.mocked(undoReleaseBatchAction)).toHaveBeenCalledWith({ batchId: "b-1" });
    expect(
      await screen.findByText(/Undone — 1 test is back to Ready for release\. The patient was already notified/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("a physical release never claims a notice, before or after Undo", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, batchId: "b-1", notifiedCount: 0 });
    vi.mocked(undoReleaseBatchAction).mockResolvedValue({ ok: true, restoredIds: ["t1"], notRestored: [] });
    const user = await releaseCbc();
    await screen.findByRole("button", { name: "↶ Undo" });
    expect(screen.queryByText(/already notified/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "↶ Undo" }));
    await screen.findByText(/back to Ready for release/);
    expect(screen.queryByText(/already notified/)).toBeNull();
  });

  it("names a panel member not undone by its card, with the released-separately reason", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, changedIds: ["c1", "c2"], batchId: "b-1" });
    vi.mocked(undoReleaseBatchAction).mockResolvedValue({
      ok: true,
      restoredIds: [],
      notRestored: [{ id: "c1", reason: "part of this report was released separately — undo it from the report page" }],
    });
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByLabelText("Select Chemistry"));
    await user.click(screen.getByRole("button", { name: /^Release 2/ }));
    await user.click(await screen.findByRole("button", { name: "↶ Undo" }));
    expect(
      await screen.findByText(/• Chemistry \(2 tests\) — Reyes, Ana: part of this report was released separately/),
    ).toBeTruthy();
  });

  it("names an unknown not-undone test as a plain 'A test'", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, batchId: "b-1" });
    vi.mocked(undoReleaseBatchAction).mockResolvedValue({
      ok: true,
      restoredIds: [],
      notRestored: [{ id: "zzz", reason: "changed since" }],
    });
    const user = await releaseCbc();
    await user.click(await screen.findByRole("button", { name: "↶ Undo" }));
    expect(await screen.findByText(/• A test: changed since/)).toBeTruthy();
  });

  it("says the notice is retrying, and keeps Undo after a retryable Undo failure", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, batchId: "b-1", noticeRetrying: true });
    vi.mocked(undoReleaseBatchAction).mockResolvedValue({
      ok: false,
      error: "Couldn't confirm what was undone — check the visit page.",
    });
    const user = await releaseCbc();
    expect(await screen.findByText(/will retry automatically/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "↶ Undo" }));
    expect(await screen.findByText(/Couldn't confirm what was undone/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "↶ Undo" })).toBeTruthy();
  });

  it("routes a release Undo to the release action, never the queue one", async () => {
    vi.mocked(releaseTestsAction).mockResolvedValue({ ...OK, batchId: "b-1" });
    vi.mocked(undoReleaseBatchAction).mockResolvedValue({ ok: true, restoredIds: ["t1"], notRestored: [] });
    const user = await releaseCbc();
    await user.click(await screen.findByRole("button", { name: "↶ Undo" }));
    await screen.findByText(/back to Ready for release/);
    expect(vi.mocked(undoBulkQueueAction)).not.toHaveBeenCalled();
  });
});
