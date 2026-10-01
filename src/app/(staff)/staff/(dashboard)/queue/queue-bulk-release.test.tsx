// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ releaseTestsAction: vi.fn(), undoBulkQueueAction: vi.fn() }));
// The bar also imports the visit page sample-delete action (server-only chain).
vi.mock("../visits/[id]/actions", () => ({ deleteSampleVisitsFromQueueAction: vi.fn() }));
vi.mock("./panel-actions", () => ({
  claimQueueSelectionAction: vi.fn(),
  unclaimQueueSelectionAction: vi.fn(),
  deleteQueueSelectionAction: vi.fn(),
}));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({}));

import { releaseTestsAction } from "./actions";
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
    // Queue bulk Release carries no 10-minute Undo (only Claim / Unclaim / Delete do).
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
