// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  claimTestsAction: vi.fn(),
  unclaimTestsAction: vi.fn(),
  undoBulkQueueAction: vi.fn(),
}));
vi.mock("@/lib/actions/visits/queue-deletion", () => ({
  deleteTestRequestsManyAction: vi.fn(),
}));

import { claimTestsAction, unclaimTestsAction, undoBulkQueueAction } from "./actions";
import { deleteTestRequestsManyAction } from "@/lib/actions/visits/queue-deletion";
import { QueueBulkBar } from "./queue-bulk-bar";
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import { SelectAllCheckbox } from "@/components/staff/row-selection/select-all-checkbox";
import { QUEUE_KIND, bulkQueueMessage, panelKey, type QueueRowInfo } from "@/lib/queue/bulk-queue";
import { UNDO_EXPIRED, undoOutcomeMessage } from "@/lib/ui/bulk-undo";
import type { SelectionEntry } from "@/lib/ui/bulk-selection";

// Bulk-select follow-ups (item 6): the checkboxes (RowSelectCheckbox /
// SelectAllCheckbox), the shared SelectionProvider and QueueBulkBar are all
// real here — only the three lab-queue server actions and next/navigation
// are mocked, so this exercises the same wiring the queue page composes
// (rowsByKey/QUEUE_KIND contract). Pins: which buttons a selection unlocks
// per QUEUE_KIND, the testIds/panels split a button sends (splitQueueKeys),
// that Unclaim carries the holder the row showed, that Delete requires a
// reason, that the outcome panel names every skipped row and prunes every
// sent key, that ineligible rows stay selected with the outcome inline, and
// the ↶ Undo visibility/counting/retry/expiry rules.

const VISIT_1 = "11111111-1111-1111-1111-111111111111";
const GROUP_1 = "22222222-2222-2222-2222-222222222222";
const VISIT_2 = "33333333-3333-3333-3333-333333333333";
const GROUP_2 = "44444444-4444-4444-4444-444444444444";
const PANEL_1 = panelKey(VISIT_1, GROUP_1);
const PANEL_2 = panelKey(VISIT_2, GROUP_2);

interface Row {
  key: string;
  kinds: string[];
  weight?: number;
  label?: string;
  assignedTo?: string | null;
  visitId?: string;
}

function buildRowsByKey(rows: Row[]): Record<string, QueueRowInfo> {
  const rowsByKey: Record<string, QueueRowInfo> = {};
  for (const r of rows) {
    rowsByKey[r.key] = {
      visitId: r.visitId ?? VISIT_1,
      label: r.label ?? r.key,
      assignedTo: r.assignedTo ?? null,
    };
  }
  return rowsByKey;
}

function Harness({ rows, resetKey = "k1" }: { rows: Row[]; resetKey?: string }) {
  const rowsByKey = buildRowsByKey(rows);
  const entries: SelectionEntry[] = rows.map((r) => ({
    rowKey: r.key,
    kinds: r.kinds,
    weight: r.weight ?? 1,
  }));
  return (
    <SelectionProvider resetKey={resetKey}>
      <table>
        <thead>
          <tr>
            <th>
              <SelectAllCheckbox entries={entries} label="Select all tests" />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                <RowSelectCheckbox
                  rowKey={r.key}
                  kinds={r.kinds}
                  weight={r.weight ?? 1}
                  label={r.label ?? r.key}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <QueueBulkBar rowsByKey={rowsByKey} />
    </SelectionProvider>
  );
}

beforeEach(() => {
  vi.mocked(claimTestsAction).mockReset();
  vi.mocked(unclaimTestsAction).mockReset();
  vi.mocked(deleteTestRequestsManyAction).mockReset();
  vi.mocked(undoBulkQueueAction).mockReset();
  router.refresh.mockReset();
  // QueueBulkBar renders via FixedBottomBar, which measures itself with a
  // ResizeObserver — not implemented in jsdom.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.spyOn(window, "alert").mockImplementation(() => {});
});
afterEach(cleanup);

it("unlocks each button only for the rows carrying its kind", async () => {
  const user = userEvent.setup();
  render(
    <Harness
      rows={[
        { key: "t1", kinds: [QUEUE_KIND.claim] },
        { key: "t2", kinds: [QUEUE_KIND.unclaim], assignedTo: "holder-1" },
        { key: "t3", kinds: [QUEUE_KIND.delete] },
      ]}
    />,
  );

  await user.click(screen.getByRole("checkbox", { name: "Select all tests" }));

  expect(screen.getByRole("button", { name: "Claim (1)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Unclaim (1)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Delete (1)" })).toBeTruthy();
});

it("an unclaimable row with no holder yet does not unlock Unclaim", async () => {
  const user = userEvent.setup();
  render(
    <Harness rows={[{ key: "t1", kinds: [QUEUE_KIND.unclaim], assignedTo: null }]} />,
  );
  await user.click(screen.getByRole("checkbox", { name: "Select t1" }));
  expect(screen.queryByRole("button", { name: /^Unclaim/ })).toBeNull();
});

describe("Claim", () => {
  it("splits a mixed selection into testIds and panels, in selection order", async () => {
    vi.mocked(claimTestsAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1", "t2", PANEL_1],
      skipped: [],
      batchId: "b-claim",
    });
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "t1", kinds: [QUEUE_KIND.claim] },
          { key: "t2", kinds: [QUEUE_KIND.claim] },
          { key: PANEL_1, kinds: [QUEUE_KIND.claim], weight: 2, visitId: VISIT_1 },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all tests" }));
    await user.click(screen.getByRole("button", { name: "Claim (3)" }));

    expect(claimTestsAction).toHaveBeenCalledTimes(1);
    expect(claimTestsAction).toHaveBeenCalledWith({
      testIds: ["t1", "t2"],
      panels: [{ visitId: VISIT_1, groupId: GROUP_1 }],
    });
  });
});

describe("Unclaim", () => {
  it("opens a reason panel and carries the holder the row showed, for a single test and a panel", async () => {
    vi.mocked(unclaimTestsAction).mockResolvedValue({
      ok: true,
      changedIds: ["t2", PANEL_2],
      skipped: [],
      batchId: "b-unclaim",
    });
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "t2", kinds: [QUEUE_KIND.unclaim], assignedTo: "holder-a" },
          { key: PANEL_2, kinds: [QUEUE_KIND.unclaim], assignedTo: "holder-b", weight: 2, visitId: VISIT_2 },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all tests" }));
    await user.click(screen.getByRole("button", { name: "Unclaim (2)" }));
    const confirm = await screen.findByRole("button", { name: /Confirm unclaim/ });
    await user.click(confirm);

    expect(unclaimTestsAction).toHaveBeenCalledWith({
      items: [{ testRequestId: "t2", assignedTo: "holder-a" }],
      panels: [{ visitId: VISIT_2, groupId: GROUP_2, assignedTo: "holder-b" }],
      reason: undefined,
    });
  });
});

describe("Delete", () => {
  it("requires a reason before it will send anything", async () => {
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "t3", kinds: [QUEUE_KIND.delete] }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select t3" }));
    await user.click(screen.getByRole("button", { name: "Delete (1)" }));
    await user.click(screen.getByRole("button", { name: "Confirm delete (1)" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Reason is required.");
    expect(deleteTestRequestsManyAction).not.toHaveBeenCalled();
  });

  it("sends the typed reason once one is entered", async () => {
    vi.mocked(deleteTestRequestsManyAction).mockResolvedValue({
      ok: true,
      changedIds: ["t3"],
      skipped: [],
      batchId: "b-delete",
    });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "t3", kinds: [QUEUE_KIND.delete] }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select t3" }));
    await user.click(screen.getByRole("button", { name: "Delete (1)" }));
    await user.type(screen.getByLabelText("Reason for deleting"), "Duplicate entry");
    await user.click(screen.getByRole("button", { name: "Confirm delete (1)" }));

    expect(deleteTestRequestsManyAction).toHaveBeenCalledWith({
      testRequestIds: ["t3"],
      panels: [],
      reason: "Duplicate entry",
    });
  });
});

it("the outcome panel names every skipped row and prunes every key that was sent", async () => {
  const rows: Row[] = [
    { key: "t1", kinds: [QUEUE_KIND.claim], label: "CBC — Cruz, Ana" },
    { key: "t4", kinds: [QUEUE_KIND.claim], label: "FBS — Reyes, Ben" },
  ];
  vi.mocked(claimTestsAction).mockResolvedValue({
    ok: true,
    changedIds: ["t1"],
    skipped: [{ id: "t4", reason: "Claimed by someone else or changed just now." }],
    batchId: "b-1",
  });
  const user = userEvent.setup();
  render(<Harness rows={rows} />);
  await user.click(screen.getByRole("checkbox", { name: "Select all tests" }));
  await user.click(screen.getByRole("button", { name: "Claim (2)" }));

  const rowsByKey = buildRowsByKey(rows);
  const expected = bulkQueueMessage(
    "Claimed",
    2,
    { changedIds: ["t1"], skipped: [{ id: "t4", reason: "Claimed by someone else or changed just now." }] },
    rowsByKey,
  );
  const panel = await screen.findByRole("status");
  expect(panel.textContent).toContain(expected);
  expect(panel.textContent).toContain("FBS — Reyes, Ben");

  // Both t1 and t4 were SENT (even though only t1 changed) — pruning is by
  // what was sent, not by what changed, so both checkboxes are unticked.
  expect((screen.getByRole("checkbox", { name: "Select CBC — Cruz, Ana" }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("checkbox", { name: "Select FBS — Reyes, Ben" }) as HTMLInputElement).checked).toBe(false);
});

it("a row not eligible for the pressed button stays selected, the outcome shows inline, and a new tick drops it", async () => {
  vi.mocked(claimTestsAction).mockResolvedValue({
    ok: true,
    changedIds: ["t1"],
    skipped: [],
    batchId: "b-1",
  });
  const user = userEvent.setup();
  render(
    <Harness
      rows={[
        { key: "t1", kinds: [QUEUE_KIND.claim] },
        { key: "t5", kinds: [QUEUE_KIND.unclaim], assignedTo: "holder-x" },
      ]}
    />,
  );
  await user.click(screen.getByRole("checkbox", { name: "Select t1" }));
  await user.click(screen.getByRole("checkbox", { name: "Select t5" }));
  await user.click(screen.getByRole("button", { name: "Claim (1)" }));

  // t5 was never claim-eligible, so it was never sent and stays selected —
  // the bar keeps rendering, with the outcome for what just happened INSIDE it.
  expect(screen.getByRole("region", { name: "Selected rows" })).toBeTruthy();
  const panel = screen.getByRole("status");
  expect(panel.textContent).toContain("Claimed 1 test.");

  // A deliberate new edit drops the stale outcome — prove it, don't assume:
  // the panel exists first, then disappears once the operator ticks again.
  await user.click(screen.getByRole("checkbox", { name: "Select t5" }));
  await user.click(screen.getByRole("checkbox", { name: "Select t5" }));
  expect(screen.queryByRole("status")).toBeNull();
});

describe("Undo", () => {
  it("shows ↶ Undo when the result carries a batchId and at least one row changed", async () => {
    vi.mocked(claimTestsAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1"],
      skipped: [],
      batchId: "b-1",
    });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "t1", kinds: [QUEUE_KIND.claim] }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select t1" }));
    await user.click(screen.getByRole("button", { name: "Claim (1)" }));

    expect(await screen.findByRole("button", { name: "↶ Undo" })).toBeTruthy();
  });

  it("hides ↶ Undo when the result carries no batchId", async () => {
    vi.mocked(claimTestsAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1"],
      skipped: [],
    });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "t1", kinds: [QUEUE_KIND.claim] }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select t1" }));
    await user.click(screen.getByRole("button", { name: "Claim (1)" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });

  it("counts restored rows by identity, not by their (possibly shared) label", async () => {
    vi.mocked(claimTestsAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1", "t2"],
      skipped: [],
      batchId: "b-1",
    });
    vi.mocked(undoBulkQueueAction).mockResolvedValue({
      ok: true,
      restoredIds: ["t1", "t2"],
      notRestored: [],
    });
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          // Two distinct tests that happen to share a display label (same
          // patient, same test name on a re-order) — must still count as two.
          { key: "t1", kinds: [QUEUE_KIND.claim], label: "CBC — Santos, Maria" },
          { key: "t2", kinds: [QUEUE_KIND.claim], label: "CBC — Santos, Maria" },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all tests" }));
    await user.click(screen.getByRole("button", { name: "Claim (2)" }));
    const undoButton = await screen.findByRole("button", { name: "↶ Undo" });
    await user.click(undoButton);

    expect(undoBulkQueueAction).toHaveBeenCalledWith({ batchId: "b-1" });
    expect(
      await screen.findByText(undoOutcomeMessage({ one: "test", many: "tests" }, { restored: 2, notRestored: [] })),
    ).toBeTruthy();
  });

  it("keeps ↶ Undo after a retryable failure, so the operator can try again", async () => {
    vi.mocked(claimTestsAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1"],
      skipped: [],
      batchId: "b-1",
    });
    vi.mocked(undoBulkQueueAction).mockResolvedValue({
      ok: false,
      error: "could not be undone just now — try again",
    });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "t1", kinds: [QUEUE_KIND.claim] }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select t1" }));
    await user.click(screen.getByRole("button", { name: "Claim (1)" }));
    const undoButton = await screen.findByRole("button", { name: "↶ Undo" });
    await user.click(undoButton);

    await screen.findByText("could not be undone just now — try again", { exact: false });
    expect(screen.getByRole("button", { name: "↶ Undo" })).toBeTruthy();
  });

  it("removes ↶ Undo once the server says the window/batch is gone (UNDO_EXPIRED)", async () => {
    vi.mocked(claimTestsAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1"],
      skipped: [],
      batchId: "b-1",
    });
    vi.mocked(undoBulkQueueAction).mockResolvedValue({ ok: false, error: UNDO_EXPIRED });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "t1", kinds: [QUEUE_KIND.claim] }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select t1" }));
    await user.click(screen.getByRole("button", { name: "Claim (1)" }));
    const undoButton = await screen.findByRole("button", { name: "↶ Undo" });
    await user.click(undoButton);

    await screen.findByText(UNDO_EXPIRED, { exact: false });
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });
});

it("an ok:false result is alerted and keeps the selection so the operator can retry", async () => {
  vi.mocked(claimTestsAction).mockResolvedValue({
    ok: false,
    error: "Only lab staff can claim or unclaim tests from the queue.",
  });
  const user = userEvent.setup();
  render(<Harness rows={[{ key: "t1", kinds: [QUEUE_KIND.claim] }]} />);
  await user.click(screen.getByRole("checkbox", { name: "Select t1" }));
  await user.click(screen.getByRole("button", { name: "Claim (1)" }));

  expect(window.alert).toHaveBeenCalledWith("Only lab staff can claim or unclaim tests from the queue.");
  expect(screen.getByRole("button", { name: "Claim (1)" })).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Select t1" }) as HTMLInputElement).checked).toBe(true);
});
