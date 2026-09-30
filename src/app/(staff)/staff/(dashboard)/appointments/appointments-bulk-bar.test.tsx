// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({
  bulkDeleteAction: vi.fn(),
  bulkTransitionAction: vi.fn(),
  undoBulkAppointmentsAction: vi.fn(),
}));

import { bulkDeleteAction, bulkTransitionAction, undoBulkAppointmentsAction } from "./actions";
import { AppointmentsBulkBar } from "./appointments-bulk-bar";
import { SelectionProvider } from "@/components/staff/row-selection/selection-context";
import { RowSelectCheckbox } from "@/components/staff/row-selection/row-select-checkbox";
import { SelectAllCheckbox } from "@/components/staff/row-selection/select-all-checkbox";
import { bulkAppointmentsMessage, summariseOutcome, type GroupInfo } from "@/lib/appointments/bulk-eligibility";
import { UNDO_EXPIRED } from "@/lib/ui/bulk-undo";
import type { SelectionEntry } from "@/lib/ui/bulk-selection";

// PR #238 (bulk booking actions on Appointments): the checkboxes
// (RowSelectCheckbox / SelectAllCheckbox), the shared SelectionProvider and
// AppointmentsBulkBar are all real here — only the three server actions and
// next/navigation are mocked, so this exercises the actual wiring the page
// uses (page.tsx composes the same four pieces around the same
// groupsByKey/resetKey contract). Pins: which buttons a selection unlocks
// (bulkActionPlan, driven by each row's status/patientActive), that a
// filter/list change (resetKey) drops the selection without remounting
// anything else, that a bulk button sends exactly the selected ids plus the
// expected "from" status, that a confirm-guarded action can be cancelled,
// that a partial/refused result is shown to the operator, that a successful
// or partial send always prunes what it sent (the outcome panel is the
// record) while a refused one keeps the selection for retry, that a mixed
// selection keeps the outcome inline until a new deliberate edit, the ↶ Undo
// visibility/counting/failure rules, and the Enter-to-bar / Escape-back
// keyboard jump.

interface Row {
  key: string;
  ids: string[];
  status: string;
  patientActive?: boolean;
  /** Defaults to `key` — two rows can share a label on purpose (see the Undo identity test). */
  label?: string;
}

function Harness({
  rows,
  isAdmin = false,
  resetKey = "k1",
}: {
  rows: Row[];
  isAdmin?: boolean;
  resetKey?: string;
}) {
  const groupsByKey: Record<string, GroupInfo> = {};
  for (const r of rows) {
    groupsByKey[r.key] = {
      ids: r.ids,
      status: r.status,
      patientActive: r.patientActive ?? true,
      label: r.label ?? r.key,
    };
  }
  const entries: SelectionEntry[] = rows.map((r) => ({
    rowKey: r.key,
    kinds: [r.status],
    weight: r.ids.length,
  }));
  return (
    <SelectionProvider resetKey={resetKey}>
      <table>
        <thead>
          <tr>
            <th>
              <SelectAllCheckbox entries={entries} label="Select all bookings" />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                <RowSelectCheckbox rowKey={r.key} kinds={[r.status]} weight={r.ids.length} label={r.key} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <AppointmentsBulkBar groupsByKey={groupsByKey} isAdmin={isAdmin} />
    </SelectionProvider>
  );
}

beforeEach(() => {
  vi.mocked(bulkTransitionAction).mockReset();
  vi.mocked(bulkDeleteAction).mockReset();
  vi.mocked(undoBulkAppointmentsAction).mockReset();
  router.refresh.mockReset();
  // BulkBar measures its own height with a ResizeObserver — not implemented
  // in jsdom.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(cleanup);

describe("selecting rows", () => {
  it("shows the bar with the count and only the buttons the row's status allows", async () => {
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);

    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));

    expect(screen.getByText("1", { selector: "span" })).toBeTruthy();
    expect(screen.getByText("booking selected", { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mark arrived (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No-show (1)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel (1)" })).toBeTruthy();
    // confirmed bookings are not eligible for Confirm or Revert, and Delete
    // is admin-only.
    expect(screen.queryByRole("button", { name: /^Confirm/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Revert/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
  });

  it("select-all ticks every row, and clicking it again clears them", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "g1", ids: ["a1"], status: "confirmed" },
          { key: "g2", ids: ["a2"], status: "confirmed" },
        ]}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));
    expect((screen.getByRole("checkbox", { name: "Select g1" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Select g2" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel (2)" })).toBeTruthy();

    await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));
    expect((screen.getByRole("checkbox", { name: "Select g1" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
  });
});

it("a filter/list change (resetKey) drops the selection without being told to", async () => {
  const user = userEvent.setup();
  const rows: Row[] = [{ key: "g1", ids: ["a1"], status: "confirmed" }];
  const { rerender } = render(<Harness rows={rows} resetKey="type=all" />);
  await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
  expect(screen.getByRole("button", { name: "Cancel (1)" })).toBeTruthy();

  rerender(<Harness rows={rows} resetKey="type=pending" />); // e.g. the filter tab changed

  expect((screen.getByRole("checkbox", { name: "Select g1" }) as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
});

describe("running a bulk action", () => {
  it("sends exactly the selected ids and the expected status, then clears the selection on a clean success", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1", "a2", "a3"] });
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "g1", ids: ["a1"], status: "confirmed" },
          { key: "g2", ids: ["a2", "a3"], status: "confirmed" },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (2)" }));

    expect(bulkTransitionAction).toHaveBeenCalledTimes(1);
    const [batch, to] = vi.mocked(bulkTransitionAction).mock.calls[0]!;
    expect(batch).toEqual([
      { ids: ["a1"], from: "confirmed" },
      { ids: ["a2", "a3"], from: "confirmed" },
    ]);
    expect(to).toBe("arrived");
    expect(window.alert).not.toHaveBeenCalled(); // every booking changed — nothing to explain
    expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("asks for confirmation on a destructive action, and sends nothing if it's cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    await user.click(screen.getByRole("button", { name: "Cancel (1)" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(bulkTransitionAction).not.toHaveBeenCalled();
    // Nothing was sent, so the selection is exactly as the operator left it.
    expect(screen.getByRole("button", { name: "Cancel (1)" })).toBeTruthy();
  });

  it("a partial result is reported in the outcome panel, but every sent row is still pruned (the panel is the record)", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1"] }); // g2 didn't move
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          { key: "g1", ids: ["a1"], status: "confirmed" },
          { key: "g2", ids: ["a2"], status: "confirmed" },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (2)" }));

    const groupsByKey: Record<string, GroupInfo> = {
      g1: { ids: ["a1"], status: "confirmed", patientActive: true, label: "g1" },
      g2: { ids: ["a2"], status: "confirmed", patientActive: true, label: "g2" },
    };
    const outcome = summariseOutcome(["g1", "g2"], groupsByKey, ["a1"]);
    const expected = bulkAppointmentsMessage({ verb: "Marked", pastTense: "arrived" }, outcome, groupsByKey, []);
    // ok:true (even partial) is reported in the outcome panel, never window.alert.
    expect(window.alert).not.toHaveBeenCalled();
    const panel = await screen.findByRole("status");
    // The panel also renders a Dismiss (and possibly Undo) button after the
    // message text, so check containment rather than exact equality.
    expect(panel.textContent).toContain(expected);
    // Both rows were sent, so both are pruned — g2 not having changed is
    // recorded IN the panel text above, not by leaving it selected.
    expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
  });

  it("a refused batch shows the error and keeps the selection so the operator can retry", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: false, error: "Reception or admin only." });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (1)" }));

    expect(window.alert).toHaveBeenCalledWith("Reception or admin only.");
    expect(screen.getByRole("button", { name: "Cancel (1)" })).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled(); // a partial write can still have committed some rows
  });

  it("Delete only appears for an admin, and calls the delete action rather than a transition", async () => {
    const user = userEvent.setup();
    const rows: Row[] = [{ key: "g1", ids: ["a1"], status: "confirmed" }];
    const { rerender } = render(<Harness rows={rows} isAdmin={false} />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();

    rerender(<Harness rows={rows} isAdmin={true} />);
    vi.mocked(bulkDeleteAction).mockResolvedValue({ ok: true, changedIds: ["a1"] });
    await user.click(screen.getByRole("button", { name: "Delete (1)" }));

    expect(bulkDeleteAction).toHaveBeenCalledWith([{ ids: ["a1"], from: "confirmed" }]);
    expect(bulkTransitionAction).not.toHaveBeenCalled();
  });
});

it("skips inactive-patient rows for the buttons that need one, and says how many", async () => {
  const user = userEvent.setup();
  render(
    <Harness
      rows={[
        { key: "g1", ids: ["a1"], status: "confirmed", patientActive: false },
        { key: "g2", ids: ["a2"], status: "confirmed", patientActive: true },
      ]}
    />,
  );
  await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));

  expect(
    screen.getByText("1 skipped for Mark arrived, Confirm and Revert — patient record deleted or merged"),
  ).toBeTruthy();
  // "arrive" needs an active patient, so only g2 is offered it; "cancel" doesn't.
  expect(screen.getByRole("button", { name: "Mark arrived (1)" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel (2)" })).toBeTruthy();
});

it("a mixed-status selection keeps the outcome inline (the bar didn't empty), and a new tick drops it", async () => {
  vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1"] });
  const user = userEvent.setup();
  render(
    <Harness
      rows={[
        { key: "g1", ids: ["a1"], status: "confirmed" },
        { key: "g2", ids: ["a2"], status: "pending_callback" },
      ]}
    />,
  );
  await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
  await user.click(screen.getByRole("checkbox", { name: "Select g2" }));
  await user.click(screen.getByRole("button", { name: "Mark arrived (1)" }));

  // g2 (pending_callback) was never eligible for "arrive", so only g1 was
  // sent and pruned — g2 stays selected, the bar keeps rendering, and the
  // outcome for what just happened shows INSIDE it (not in the standalone slot).
  expect(screen.getByRole("region", { name: "Selected rows" })).toBeTruthy();
  const panel = screen.getByRole("status");
  expect(panel.textContent).toContain("Marked 1 booking arrived.");

  // A deliberate new edit (ticking/unticking a row) drops the stale outcome —
  // proves it, rather than assuming: the panel exists first, then disappears.
  await user.click(screen.getByRole("checkbox", { name: "Select g2" }));
  expect(screen.queryByRole("status")).toBeNull();
});

describe("Undo visibility", () => {
  it("shows ↶ Undo when the result carries a batchId and at least one row changed", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1"], batchId: "b-1" });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (1)" }));

    expect(await screen.findByRole("button", { name: "↶ Undo" })).toBeTruthy();
  });

  it("hides ↶ Undo when the result carries no batchId", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1"] });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (1)" }));

    expect(await screen.findByRole("status")).toBeTruthy(); // the outcome panel is still shown...
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull(); // ...just without Undo.
  });

  it("never offers ↶ Undo for Delete, even when the result carries a batchId", async () => {
    vi.mocked(bulkDeleteAction).mockResolvedValue({ ok: true, changedIds: ["a1"], batchId: "b-2" });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} isAdmin />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    await user.click(screen.getByRole("button", { name: "Delete (1)" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });
});

describe("running an Undo", () => {
  it("counts restored bookings by identity, not by their (possibly shared) label", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1", "a2"], batchId: "b-1" });
    vi.mocked(undoBulkAppointmentsAction).mockResolvedValue({ ok: true, restoredIds: ["a1", "a2"], notRestored: [] });
    const user = userEvent.setup();
    render(
      <Harness
        rows={[
          // Two distinct bookings that happen to share a display label
          // (e.g. same patient name) — they must still count as two.
          { key: "g1", ids: ["a1"], status: "confirmed", label: "Maria Santos" },
          { key: "g2", ids: ["a2"], status: "confirmed", label: "Maria Santos" },
        ]}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select all bookings" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (2)" }));

    const undoButton = await screen.findByRole("button", { name: "↶ Undo" });
    await user.click(undoButton);

    expect(undoBulkAppointmentsAction).toHaveBeenCalledWith({ batchId: "b-1" });
    expect(await screen.findByText("Undone — 2 bookings are back to what they were.")).toBeTruthy();
  });

  it("keeps ↶ Undo after a retryable failure, so the operator can try again", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1"], batchId: "b-1" });
    vi.mocked(undoBulkAppointmentsAction).mockResolvedValue({
      ok: false,
      error: "could not be undone just now — try again",
    });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (1)" }));
    const undoButton = await screen.findByRole("button", { name: "↶ Undo" });
    await user.click(undoButton);

    await screen.findByText("could not be undone just now — try again", { exact: false });
    expect(screen.getByRole("button", { name: "↶ Undo" })).toBeTruthy();
  });

  it("removes ↶ Undo once the server says the window/batch is gone (UNDO_EXPIRED)", async () => {
    vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1"], batchId: "b-1" });
    vi.mocked(undoBulkAppointmentsAction).mockResolvedValue({ ok: false, error: UNDO_EXPIRED });
    const user = userEvent.setup();
    render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);
    await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
    await user.click(screen.getByRole("button", { name: "Mark arrived (1)" }));
    const undoButton = await screen.findByRole("button", { name: "↶ Undo" });
    await user.click(undoButton);

    await screen.findByText(UNDO_EXPIRED, { exact: false });
    expect(screen.queryByRole("button", { name: "↶ Undo" })).toBeNull();
  });
});

it("Enter on a row checkbox jumps focus to the first action, not Clear (Alt+B / Enter-on-checkbox footgun)", async () => {
  const user = userEvent.setup();
  render(<Harness rows={[{ key: "g1", ids: ["a1"], status: "confirmed" }]} />);
  const checkbox = screen.getByRole("checkbox", { name: "Select g1" });
  await user.click(checkbox); // select the row so the bar mounts
  expect(document.activeElement).toBe(checkbox);

  await user.keyboard("{Enter}");
  // "Clear" sits in the count line, ahead of the actions container, in DOM
  // order — the jump must land INSIDE the actions container instead, so a
  // keyboard user pressing Enter twice acts on their selection rather than
  // wiping it.
  const actionButton = screen.getByRole("button", { name: "Mark arrived (1)" });
  expect(document.activeElement).toBe(actionButton);
  expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Clear" }));

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Selected rows" })).toBeNull();
  expect(document.activeElement).toBe(checkbox);
});

it("with an inline outcome showing, the jump still lands on a real action button, not Undo/Dismiss", async () => {
  vi.mocked(bulkTransitionAction).mockResolvedValue({ ok: true, changedIds: ["a1"], batchId: "b-1" });
  const user = userEvent.setup();
  render(
    <Harness
      rows={[
        { key: "g1", ids: ["a1"], status: "confirmed" },
        { key: "g2", ids: ["a2"], status: "pending_callback" },
      ]}
    />,
  );
  // g2 (pending_callback) is never eligible for "arrive" — sending only g1
  // leaves g2 selected, so the bar keeps rendering with the outcome panel
  // INLINE as the actions container's first child (see the "mixed-status
  // selection" test above).
  await user.click(screen.getByRole("checkbox", { name: "Select g1" }));
  await user.click(screen.getByRole("checkbox", { name: "Select g2" }));
  await user.click(screen.getByRole("button", { name: "Mark arrived (1)" }));
  await screen.findByRole("button", { name: "↶ Undo" }); // outcome + Undo are inline now

  const checkbox = screen.getByRole("checkbox", { name: "Select g2" });
  checkbox.focus();
  await user.keyboard("{Enter}");

  // Landed on a real action button (g2 is pending_callback, still eligible
  // for Confirm and Cancel — Confirm renders first), never the inline
  // outcome's Undo or Dismiss, which render ahead of it in DOM order.
  const confirmButton = screen.getByRole("button", { name: "Confirm (1)" });
  expect(document.activeElement).toBe(confirmButton);
  expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "↶ Undo" }));
  expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Dismiss" }));
});
