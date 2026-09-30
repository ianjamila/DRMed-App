// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  undoBulkQueueAction: vi.fn(),
}));
// EVERY bulk Claim / Unclaim / Delete goes through these three, panel or not:
// they mint the one batch id that shows Undo. The real module pulls in
// server-only code that throws outside a Server Component, so they are mocked.
vi.mock("./panel-actions", () => ({
  claimQueueSelectionAction: vi.fn(),
  unclaimQueueSelectionAction: vi.fn(),
  deleteQueueSelectionAction: vi.fn(),
}));

import { undoBulkQueueAction } from "./actions";
import {
  claimQueueSelectionAction,
  deleteQueueSelectionAction,
  unclaimQueueSelectionAction,
} from "./panel-actions";
import { QueueBulkBar } from "./queue-bulk-bar";
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import { SelectAllCheckbox } from "@/components/staff/row-selection/select-all-checkbox";
import { QUEUE_KIND, bulkQueueMessage, panelRowKey, type QueueRowInfo } from "@/lib/queue/bulk-queue";
import { UNDO_EXPIRED, undoOutcomeMessage } from "@/lib/ui/bulk-undo";
import type { SelectionEntry } from "@/lib/ui/bulk-selection";

// Bulk-select follow-ups (item 6): the checkboxes (RowSelectCheckbox /
// SelectAllCheckbox), the shared SelectionProvider and QueueBulkBar are all
// real here — only the three bulk server actions and next/navigation
// are mocked, so this exercises the same wiring the queue page composes
// (rowsByKey/QUEUE_KIND contract). Pins: which buttons a selection unlocks
// per QUEUE_KIND, that Unclaim carries the holder the row showed, that
// Delete requires a reason, that the outcome panel names every skipped row
// and prunes every sent key, that ineligible rows stay selected with the
// outcome inline, and the ↶ Undo visibility/counting/retry/expiry rules.
// Server-side panel handling is covered by panel-actions / panel-writes tests;
// here a panel key only has to travel in the same call as the single tests.

const VISIT_1 = "11111111-1111-1111-1111-111111111111";

interface Row {
  key: string;
  kinds: string[];
  weight?: number;
  label?: string;
  assignedTo?: string | null;
  visitId?: string;
  /** Panel rows only: tests Delete acts on / tests Claim + Unclaim act on / bench members. */
  testCount?: number;
  benchCount?: number;
  bench?: Array<{ id: string; holder: string | null }>;
}

function buildRowsByKey(rows: Row[]): Record<string, QueueRowInfo> {
  const rowsByKey: Record<string, QueueRowInfo> = {};
  for (const r of rows) {
    rowsByKey[r.key] = {
      visitId: r.visitId ?? VISIT_1,
      label: r.label ?? r.key,
      assignedTo: r.assignedTo ?? null,
      ...(r.testCount !== undefined ? { testCount: r.testCount } : {}),
      ...(r.benchCount !== undefined ? { benchCount: r.benchCount } : {}),
      ...(r.bench ? { bench: r.bench } : {}),
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
  vi.mocked(claimQueueSelectionAction).mockReset();
  vi.mocked(unclaimQueueSelectionAction).mockReset();
  vi.mocked(deleteQueueSelectionAction).mockReset();
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
  it("sends a panel-free selection to claimQueueSelectionAction with no panels", async () => {
    vi.mocked(claimQueueSelectionAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1", "t2"],
      skipped: [],
      batchId: "b-claim",
    });
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "t1", kinds: [QUEUE_KIND.claim] },
          { key: "t2", kinds: [QUEUE_KIND.claim] },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all tests" }));
    await user.click(screen.getByRole("button", { name: "Claim (2)" }));

    expect(claimQueueSelectionAction).toHaveBeenCalledTimes(1);
    expect(claimQueueSelectionAction).toHaveBeenCalledWith({ testRequestIds: ["t1", "t2"], panels: [] });
    // The whole-selection batch id it returns is what offers Undo.
    expect(await screen.findByRole("button", { name: "↶ Undo" })).toBeTruthy();
  });

  it("sends single tests and a chemistry panel in ONE call and offers one Undo", async () => {
    const GROUP = "22222222-2222-2222-2222-222222222222";
    const panelKey = panelRowKey(VISIT_1, GROUP);
    vi.mocked(claimQueueSelectionAction).mockResolvedValue({
      ok: true,
      changedIds: ["t1", "m1", "m2"],
      skipped: [],
      batchId: "b-mixed",
    });
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "t1", kinds: [QUEUE_KIND.claim] },
          { key: panelKey, kinds: [QUEUE_KIND.claim] },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all tests" }));
    await user.click(screen.getByRole("button", { name: "Claim (2)" }));

    expect(claimQueueSelectionAction).toHaveBeenCalledTimes(1);
    expect(claimQueueSelectionAction).toHaveBeenCalledWith({
      testRequestIds: ["t1"],
      panels: [{ visitId: VISIT_1, groupId: GROUP }],
    });
    expect(await screen.findAllByRole("button", { name: "↶ Undo" })).toHaveLength(1);
  });
});

describe("Unclaim", () => {
  it("opens a reason panel and carries the holder the row showed", async () => {
    vi.mocked(unclaimQueueSelectionAction).mockResolvedValue({
      ok: true,
      changedIds: ["t2"],
      skipped: [],
      batchId: "b-unclaim",
    });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "t2", kinds: [QUEUE_KIND.unclaim], assignedTo: "holder-a" }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select all tests" }));
    await user.click(screen.getByRole("button", { name: "Unclaim (1)" }));
    const confirm = await screen.findByRole("button", { name: /Confirm unclaim/ });
    await user.click(confirm);

    expect(unclaimQueueSelectionAction).toHaveBeenCalledWith({
      items: [{ testRequestId: "t2", assignedTo: "holder-a" }],
      panels: [],
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
    expect(deleteQueueSelectionAction).not.toHaveBeenCalled();
  });

  it("sends the typed reason once one is entered", async () => {
    vi.mocked(deleteQueueSelectionAction).mockResolvedValue({
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

    expect(deleteQueueSelectionAction).toHaveBeenCalledWith({
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
  vi.mocked(claimQueueSelectionAction).mockResolvedValue({
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
  vi.mocked(claimQueueSelectionAction).mockResolvedValue({
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
    vi.mocked(claimQueueSelectionAction).mockResolvedValue({
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
    vi.mocked(claimQueueSelectionAction).mockResolvedValue({
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
    vi.mocked(claimQueueSelectionAction).mockResolvedValue({
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
    vi.mocked(claimQueueSelectionAction).mockResolvedValue({
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
    vi.mocked(claimQueueSelectionAction).mockResolvedValue({
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

describe("Undo after a chemistry-panel bulk action", () => {
  const GROUP = "22222222-2222-2222-2222-222222222222";
  const panelKey = panelRowKey(VISIT_1, GROUP);
  const MEMBERS = ["m1", "m2", "m3"];
  const panelRow = (kind: string, holder: string | null = null): Row => ({
    key: panelKey,
    kinds: [kind],
    label: "Chemistry panel — Santos, Maria",
    // The bar counts a panel row by its tests, so the buttons read (3), not (1).
    weight: 3,
    testCount: 3,
    benchCount: 3,
    bench: MEMBERS.map((id) => ({ id, holder })),
  });

  it("Claim of ONE panel row offers ↶ Undo that undoes the whole batch, counted in tests", async () => {
    vi.mocked(claimQueueSelectionAction).mockResolvedValue({
      ok: true,
      changedIds: MEMBERS,
      skipped: [],
      batchId: "b-1",
    });
    vi.mocked(undoBulkQueueAction).mockResolvedValue({ ok: true, restoredIds: MEMBERS, notRestored: [] });
    const user = userEvent.setup();
    render(<Harness rows={[panelRow(QUEUE_KIND.claim)]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select Chemistry panel — Santos, Maria" }));
    await user.click(screen.getByRole("button", { name: "Claim (3)" }));

    expect(claimQueueSelectionAction).toHaveBeenCalledWith({
      testRequestIds: [],
      panels: [{ visitId: VISIT_1, groupId: GROUP }],
    });
    // One row was selected, three tests changed: the outcome counts tests.
    expect((await screen.findByRole("status")).textContent).toContain("Claimed 3 tests.");
    await user.click(await screen.findByRole("button", { name: "↶ Undo" }));
    expect(undoBulkQueueAction).toHaveBeenCalledTimes(1);
    expect(undoBulkQueueAction).toHaveBeenCalledWith({ batchId: "b-1" });
  });

  it("Unclaim of ONE panel row offers ↶ Undo that undoes the whole batch", async () => {
    vi.mocked(unclaimQueueSelectionAction).mockResolvedValue({
      ok: true,
      changedIds: MEMBERS,
      skipped: [],
      batchId: "b-unclaim-panel",
    });
    vi.mocked(undoBulkQueueAction).mockResolvedValue({ ok: true, restoredIds: MEMBERS, notRestored: [] });
    const user = userEvent.setup();
    render(<Harness rows={[panelRow(QUEUE_KIND.unclaim, "holder-a")]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select Chemistry panel — Santos, Maria" }));
    await user.click(screen.getByRole("button", { name: "Unclaim (3)" }));
    await user.click(await screen.findByRole("button", { name: /Confirm unclaim/ }));

    expect(unclaimQueueSelectionAction).toHaveBeenCalledWith({
      items: [],
      panels: [{ visitId: VISIT_1, groupId: GROUP, members: MEMBERS.map((id) => ({ id, holder: "holder-a" })) }],
      reason: undefined,
    });
    expect((await screen.findByRole("status")).textContent).toContain("Unclaimed 3 tests.");
    await user.click(await screen.findByRole("button", { name: "↶ Undo" }));
    expect(undoBulkQueueAction).toHaveBeenCalledWith({ batchId: "b-unclaim-panel" });
  });

  it("Delete of ONE panel row offers ↶ Undo that undoes the whole batch", async () => {
    vi.mocked(deleteQueueSelectionAction).mockResolvedValue({
      ok: true,
      changedIds: MEMBERS,
      skipped: [],
      batchId: "b-delete-panel",
    });
    vi.mocked(undoBulkQueueAction).mockResolvedValue({ ok: true, restoredIds: MEMBERS, notRestored: [] });
    const user = userEvent.setup();
    render(<Harness rows={[panelRow(QUEUE_KIND.delete)]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select Chemistry panel — Santos, Maria" }));
    await user.click(screen.getByRole("button", { name: "Delete (3)" }));
    await user.type(screen.getByLabelText("Reason for deleting"), "Duplicate entry");
    await user.click(screen.getByRole("button", { name: "Confirm delete (3)" }));

    expect(deleteQueueSelectionAction).toHaveBeenCalledWith({
      testRequestIds: [],
      panels: [{ visitId: VISIT_1, groupId: GROUP }],
      reason: "Duplicate entry",
    });
    expect((await screen.findByRole("status")).textContent).toContain("Deleted 3 tests.");
    await user.click(await screen.findByRole("button", { name: "↶ Undo" }));
    expect(undoBulkQueueAction).toHaveBeenCalledWith({ batchId: "b-delete-panel" });
  });

  it("a panel Claim result with no batchId shows no ↶ Undo", async () => {
    vi.mocked(claimQueueSelectionAction).mockResolvedValue({
      ok: true,
      changedIds: MEMBERS,
      skipped: [],
    });
    const user = userEvent.setup();
    render(<Harness rows={[panelRow(QUEUE_KIND.claim)]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select Chemistry panel — Santos, Maria" }));
    await user.click(screen.getByRole("button", { name: "Claim (3)" }));

    expect((await screen.findByRole("status")).textContent).toContain("Claimed 3 tests.");
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });

  it("a panel Claim that changed nothing shows no ↶ Undo even with a batchId", async () => {
    vi.mocked(claimQueueSelectionAction).mockResolvedValue({
      ok: true,
      changedIds: [],
      skipped: [{ id: panelKey, reason: "Claimed by someone else or changed just now." }],
      batchId: "b-none",
    });
    const user = userEvent.setup();
    render(<Harness rows={[panelRow(QUEUE_KIND.claim)]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select Chemistry panel — Santos, Maria" }));
    await user.click(screen.getByRole("button", { name: "Claim (3)" }));

    const expected = bulkQueueMessage(
      "Claimed",
      3,
      { changedIds: [], skipped: [{ id: panelKey, reason: "Claimed by someone else or changed just now." }] },
      buildRowsByKey([panelRow(QUEUE_KIND.claim)]),
    );
    expect((await screen.findByRole("status")).textContent).toContain(expected);
    expect(expected).toContain("Nothing claimed.");
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });
});

it("an ok:false result is alerted and keeps the selection so the operator can retry", async () => {
  vi.mocked(claimQueueSelectionAction).mockResolvedValue({
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
